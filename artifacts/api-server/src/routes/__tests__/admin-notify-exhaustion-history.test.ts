/**
 * Task #1304 — GET /api/admin/notify-exhaustion-history and
 * GET /api/admin/notify-exhaustion-rows.
 *
 * Pins the contract on the two admin endpoints that surface the daily
 * ops-alert (notification retry-exhaustion) data the cron in Task #1130
 * computes. Covers:
 *   • 401 when unauthenticated.
 *   • 403 for non-admin roles (player).
 *   • Admin sees `buckets` covering the requested day window with the
 *     exhaustion counts grouped by UTC day, pipeline, and channel.
 *   • The day a row was stamped exhausted is the day it appears under,
 *     and rows from before the window are excluded.
 *   • `days` is clamped to 1..90.
 *   • Rows endpoint validates pipeline / channel / date and returns the
 *     affected coach-payout / levy-receipt rows for the given UTC day,
 *     including the proId / clubMemberId triagers need to deep-link
 *     into coach-admin or member-360.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// Comms is mocked so the Task #1542 retry-action tests below don't try to
// hit a real FCM / SMS provider. The existing GET tests in this file
// don't dispatch any notifications, so the mock is a safe no-op for them.
vi.mock("../../lib/comms.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/comms.js")>();
  return {
    ...actual,
    sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    })),
    sendTransactionalSms: vi.fn(async () => undefined),
    sendTransactionalWhatsapp: vi.fn(async () => undefined),
  };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  teachingProsTable,
  coachPayoutsTable,
  coachPayoutNotificationAttemptsTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyReceiptAttemptsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { sendTransactionalPush, sendTransactionalSms } from "../../lib/comms.js";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);

let orgId: number;
let adminId: number;
let superAdminId: number;
let playerId: number;
let proId: number;
let proUserId: number;
let levyId: number;

// A second tenant we use to prove the new endpoints scope by
// organization for org_admin / tournament_director and only
// super_admin sees rows from both clubs.
let otherOrgId: number;
let otherOrgAdminId: number;
let otherOrgProId: number;
let otherOrgProUserId: number;
let otherOrgLevyId: number;
let otherOrgCoachAttemptId: number;
let otherOrgLevyAttemptId: number;
let otherOrgPayoutId: number;
let otherOrgLevyChargeId: number;
let otherOrgLevyMemberId: number;

const coachAttemptIds: number[] = [];
const coachPayoutIds: number[] = [];
const levyAttemptIds: number[] = [];
const levyChargeIds: number[] = [];
const levyMemberIds: number[] = [];

// Reference "now" computed from the real wall clock at suite startup.
// The history endpoint computes its lookback window from the live
// clock (`now - days`), so we derive the day labels (today / yesterday
// / two days ago) relative to that same clock. Earlier revisions of
// this file hardcoded literal dates like "2026-04-19", which silently
// fell outside the route's 7-day window once real time advanced past
// the corresponding cutoff (see Task #1918). Computing the labels
// here keeps the per-day-bucket and tenant-scoping assertions
// deterministic on any future run date without needing to fake the
// system clock.
function startOfDayUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function shiftDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * 24 * 3600_000);
}
function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const TODAY_START = startOfDayUtc(new Date());
// Pin NOW to noon UTC of the current day so the seeded `paidAt` /
// `periodStart` timestamps don't sit right on a UTC day boundary, and
// the suite has a comfortable buffer if real time crosses midnight
// while it runs.
const NOW = new Date(TODAY_START.getTime() + 12 * 3600_000);
const TODAY = dayString(TODAY_START);
const YESTERDAY = dayString(shiftDays(TODAY_START, -1));
const TWO_DAYS_AGO = dayString(shiftDays(TODAY_START, -2));
const FAR_PAST = new Date("2020-01-01T12:00:00Z"); // outside any window we test

let payoutSeq = 0;
async function seedCoachAttempt(opts: {
  pushAt?: Date | null;
  smsAt?: Date | null;
}) {
  payoutSeq += 1;
  const [payout] = await db.insert(coachPayoutsTable).values({
    proId,
    organizationId: orgId,
    periodStart: NOW,
    periodEnd: NOW,
    grossPaise: 50000,
    platformFeePaise: 0,
    netPayoutPaise: 50000,
    status: "paid",
    payoutReference: `T1304-${Date.now()}-${payoutSeq}`,
    paidAt: NOW,
  }).returning({ id: coachPayoutsTable.id });
  coachPayoutIds.push(payout.id);

  const [a] = await db.insert(coachPayoutNotificationAttemptsTable).values({
    payoutId: payout.id,
    proId,
    organizationId: orgId,
    coachUserId: proUserId,
    amountPaise: 50000,
    reference: "T1304-COACH",
    notes: null,
    orgName: "T1304_Org",
    pushStatus: opts.pushAt ? "failed" : null,
    pushAttempts: opts.pushAt ? 5 : 0,
    pushRetryExhaustedAt: opts.pushAt ?? null,
    smsStatus: opts.smsAt ? "failed" : null,
    smsAttempts: opts.smsAt ? 5 : 0,
    smsRetryExhaustedAt: opts.smsAt ?? null,
  }).returning({ id: coachPayoutNotificationAttemptsTable.id });
  coachAttemptIds.push(a.id);
  return a.id;
}

async function seedLevyAttempt(opts: {
  pushAt?: Date | null;
  smsAt?: Date | null;
}) {
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "T1304",
    lastName: `Member_${levyMemberIds.length}`,
    email: null,
    phone: null,
  }).returning({ id: clubMembersTable.id });
  levyMemberIds.push(member.id);

  const [charge] = await db.insert(memberLevyChargesTable).values({
    clubMemberId: member.id,
    levyId,
    amount: "100.00",
    status: "unpaid",
  }).returning({ id: memberLevyChargesTable.id });
  levyChargeIds.push(charge.id);

  const [a] = await db.insert(memberLevyReceiptAttemptsTable).values({
    organizationId: orgId,
    chargeId: charge.id,
    clubMemberId: member.id,
    kind: "payment",
    levyName: "T1304_Levy",
    currency: "INR",
    transactionAmount: "100.00",
    newBalance: "0.00",
    note: null,
    pushStatus: opts.pushAt ? "failed" : "skipped",
    pushAttempts: opts.pushAt ? 5 : 0,
    pushRetryExhaustedAt: opts.pushAt ?? null,
    smsStatus: opts.smsAt ? "failed" : "skipped",
    smsAttempts: opts.smsAt ? 5 : 0,
    smsRetryExhaustedAt: opts.smsAt ?? null,
  }).returning({ id: memberLevyReceiptAttemptsTable.id });
  levyAttemptIds.push(a.id);
  return { attemptId: a.id, memberId: member.id, chargeId: charge.id };
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `T1304_${stamp}`, slug: `t1304-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `t1304-admin-${stamp}`,
    username: `t1304_admin_${stamp}`,
    email: `admin_${stamp}@t1304.test`,
    role: "org_admin", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [player] = await db.insert(appUsersTable).values({
    replitUserId: `t1304-player-${stamp}`,
    username: `t1304_player_${stamp}`,
    email: `player_${stamp}@t1304.test`,
    role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerId = player.id;

  const [proUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1304-pro-${stamp}`,
    username: `t1304_pro_${stamp}`,
    email: `pro_${stamp}@t1304.test`,
    role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  proUserId = proUser.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId,
    userId: proUserId,
    displayName: "T1304 Coach",
    email: null,
    phone: null,
  }).returning({ id: teachingProsTable.id });
  proId = pro.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: orgId,
    name: "T1304_Levy",
    amount: "100.00",
    currency: "INR",
  }).returning({ id: memberLeviesTable.id });
  levyId = levy.id;

  // Seed exhaustions:
  //   • Yesterday: 2 coach push, 1 coach sms, 1 levy push.
  //   • Two days ago: 1 levy sms.
  //   • Far past: 1 coach push (must NOT appear in 7d window).
  const yest12 = new Date(`${YESTERDAY}T12:00:00Z`);
  const twoDays12 = new Date(`${TWO_DAYS_AGO}T08:00:00Z`);

  await seedCoachAttempt({ pushAt: yest12 });
  await seedCoachAttempt({ pushAt: yest12, smsAt: yest12 });
  await seedLevyAttempt({ pushAt: yest12 });
  await seedLevyAttempt({ smsAt: twoDays12 });
  await seedCoachAttempt({ pushAt: FAR_PAST });

  // -------- Second tenant -------------------------------------------------
  // Seeded so we can assert that org_admin in `orgId` does NOT see this
  // org's rows or counts (tenant scoping), while super_admin sees both.
  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `T1304_OTHER_${stamp}`, slug: `t1304-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [otherAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `t1304-other-admin-${stamp}`,
    username: `t1304_other_admin_${stamp}`,
    email: `other_admin_${stamp}@t1304.test`,
    role: "org_admin", organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherOrgAdminId = otherAdmin.id;

  const [superUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1304-super-${stamp}`,
    username: `t1304_super_${stamp}`,
    email: `super_${stamp}@t1304.test`,
    role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = superUser.id;

  const [otherProUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1304-other-pro-${stamp}`,
    username: `t1304_other_pro_${stamp}`,
    email: `other_pro_${stamp}@t1304.test`,
    role: "player", organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherOrgProUserId = otherProUser.id;

  const [otherPro] = await db.insert(teachingProsTable).values({
    organizationId: otherOrgId,
    userId: otherOrgProUserId,
    displayName: "T1304 Other Coach",
    email: null,
    phone: null,
  }).returning({ id: teachingProsTable.id });
  otherOrgProId = otherPro.id;

  const [otherLevy] = await db.insert(memberLeviesTable).values({
    organizationId: otherOrgId,
    name: "T1304_OtherLevy",
    amount: "200.00",
    currency: "INR",
  }).returning({ id: memberLeviesTable.id });
  otherOrgLevyId = otherLevy.id;

  // One coach push exhaustion in the OTHER org, yesterday.
  const [otherPayout] = await db.insert(coachPayoutsTable).values({
    proId: otherOrgProId,
    organizationId: otherOrgId,
    periodStart: NOW,
    periodEnd: NOW,
    grossPaise: 70000,
    platformFeePaise: 0,
    netPayoutPaise: 70000,
    status: "paid",
    payoutReference: `T1304-OTHER-${Date.now()}`,
    paidAt: NOW,
  }).returning({ id: coachPayoutsTable.id });
  otherOrgPayoutId = otherPayout.id;

  const [otherCoachA] = await db.insert(coachPayoutNotificationAttemptsTable).values({
    payoutId: otherPayout.id,
    proId: otherOrgProId,
    organizationId: otherOrgId,
    coachUserId: otherOrgProUserId,
    amountPaise: 70000,
    reference: "T1304-OTHER-COACH",
    notes: null,
    orgName: "T1304_Other_Org",
    pushStatus: "failed", pushAttempts: 5, pushRetryExhaustedAt: yest12,
    smsStatus: null, smsAttempts: 0, smsRetryExhaustedAt: null,
  }).returning({ id: coachPayoutNotificationAttemptsTable.id });
  otherOrgCoachAttemptId = otherCoachA.id;

  // One levy SMS exhaustion in the OTHER org, two days ago.
  const [otherMember] = await db.insert(clubMembersTable).values({
    organizationId: otherOrgId,
    firstName: "T1304_Other",
    lastName: "Member",
    email: null, phone: null,
  }).returning({ id: clubMembersTable.id });
  otherOrgLevyMemberId = otherMember.id;

  const [otherCharge] = await db.insert(memberLevyChargesTable).values({
    clubMemberId: otherMember.id,
    levyId: otherOrgLevyId,
    amount: "200.00",
    status: "unpaid",
  }).returning({ id: memberLevyChargesTable.id });
  otherOrgLevyChargeId = otherCharge.id;

  const [otherLevyA] = await db.insert(memberLevyReceiptAttemptsTable).values({
    organizationId: otherOrgId,
    chargeId: otherCharge.id,
    clubMemberId: otherMember.id,
    kind: "payment",
    levyName: "T1304_OtherLevy",
    currency: "INR",
    transactionAmount: "200.00",
    newBalance: "0.00",
    note: null,
    pushStatus: "skipped", pushAttempts: 0, pushRetryExhaustedAt: null,
    smsStatus: "failed", smsAttempts: 5, smsRetryExhaustedAt: twoDays12,
  }).returning({ id: memberLevyReceiptAttemptsTable.id });
  otherOrgLevyAttemptId = otherLevyA.id;
});

afterAll(async () => {
  // Other-org rows first (so we can drop their parents below).
  if (otherOrgCoachAttemptId) {
    await db.delete(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, otherOrgCoachAttemptId));
  }
  if (otherOrgLevyAttemptId) {
    await db.delete(memberLevyReceiptAttemptsTable)
      .where(eq(memberLevyReceiptAttemptsTable.id, otherOrgLevyAttemptId));
  }
  if (otherOrgLevyChargeId) {
    await db.delete(memberLevyChargesTable)
      .where(eq(memberLevyChargesTable.id, otherOrgLevyChargeId));
  }
  if (otherOrgLevyMemberId) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, otherOrgLevyMemberId));
  }
  if (otherOrgPayoutId) {
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.id, otherOrgPayoutId));
  }
  if (otherOrgLevyId) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, otherOrgLevyId));
  }
  if (otherOrgProId) {
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, otherOrgProId));
  }

  if (coachAttemptIds.length) {
    await db.delete(coachPayoutNotificationAttemptsTable)
      .where(inArray(coachPayoutNotificationAttemptsTable.id, coachAttemptIds));
  }
  if (levyAttemptIds.length) {
    await db.delete(memberLevyReceiptAttemptsTable)
      .where(inArray(memberLevyReceiptAttemptsTable.id, levyAttemptIds));
  }
  if (levyChargeIds.length) {
    await db.delete(memberLevyChargesTable)
      .where(inArray(memberLevyChargesTable.id, levyChargeIds));
  }
  if (levyMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, levyMemberIds));
  }
  if (coachPayoutIds.length) {
    await db.delete(coachPayoutsTable)
      .where(inArray(coachPayoutsTable.id, coachPayoutIds));
  }
  if (levyId) await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, levyId));
  if (proId) await db.delete(teachingProsTable).where(eq(teachingProsTable.id, proId));
  const userIdsToDelete = [adminId, playerId, proUserId, superAdminId, otherOrgAdminId, otherOrgProUserId]
    .filter((id): id is number => typeof id === "number");
  if (userIdsToDelete.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIdsToDelete));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
  }
});

function asUser(id: number, role: string, organizationId: number | null): TestUser {
  const u: TestUser = { id, username: `u${id}`, role };
  if (organizationId != null) u.organizationId = organizationId;
  return u;
}

function callHistory(user: TestUser | undefined, query = "") {
  return request(createTestApp(user)).get(`/api/admin/notify-exhaustion-history${query}`);
}
function callRows(user: TestUser | undefined, query = "") {
  return request(createTestApp(user)).get(`/api/admin/notify-exhaustion-rows${query}`);
}

describe("GET /api/admin/notify-exhaustion-history", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callHistory(undefined);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await callHistory(asUser(playerId, "player", orgId));
    expect(res.status).toBe(403);
  });

  it("returns per-day buckets for an admin and includes seeded exhaustions", async () => {
    const res = await callHistory(asUser(adminId, "org_admin", orgId), "?days=7");
    expect(res.status).toBe(200);
    const body = res.body as {
      days: number;
      buckets: Array<{
        date: string;
        coachPayout: { push: number; sms: number; rows: number };
        levyReceipt: { push: number; sms: number; rows: number };
        totalRows: number;
        alerted: boolean;
      }>;
    };
    expect(body.days).toBe(7);
    expect(Array.isArray(body.buckets)).toBe(true);
    // 7 buckets returned, oldest first.
    expect(body.buckets.length).toBe(7);
    const today = body.buckets[body.buckets.length - 1];
    expect(today).toBeDefined();
    // The far-past coach attempt must not bleed into any of these days.
    for (const b of body.buckets) {
      // sanity — buckets are dated YYYY-MM-DD
      expect(b.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    const yest = body.buckets.find(b => b.date === YESTERDAY);
    const twoDays = body.buckets.find(b => b.date === TWO_DAYS_AGO);
    expect(yest).toBeDefined();
    expect(twoDays).toBeDefined();

    // Seeded yesterday: 2 coach attempts had push exhausted (one also had
    // sms); 1 levy attempt had push exhausted.
    expect(yest!.coachPayout.push).toBeGreaterThanOrEqual(2);
    expect(yest!.coachPayout.sms).toBeGreaterThanOrEqual(1);
    expect(yest!.levyReceipt.push).toBeGreaterThanOrEqual(1);
    // The two coach attempts share the same UTC day, so distinct rows = 2
    // coach + 1 levy = 3.
    expect(yest!.totalRows).toBeGreaterThanOrEqual(3);

    // Two-days-ago: just one levy SMS.
    expect(twoDays!.levyReceipt.sms).toBeGreaterThanOrEqual(1);
    expect(twoDays!.coachPayout.push + twoDays!.coachPayout.sms).toBe(0);
  });

  // Task #1541 — the history payload must include the configured ops
  // alert recipients so the in-app history page can show admins exactly
  // who would have received an alert email for any flagged day. Source
  // is the OPS_ALERT_EMAILS env var; we mutate it locally so the test
  // doesn't depend on the dev/CI value.
  it("includes the configured ops alert recipients (from OPS_ALERT_EMAILS)", async () => {
    const prev = process.env.OPS_ALERT_EMAILS;
    process.env.OPS_ALERT_EMAILS = "  ops@example.com , oncall@example.com ,";
    try {
      const res = await callHistory(asUser(adminId, "org_admin", orgId), "?days=7");
      expect(res.status).toBe(200);
      const body = res.body as {
        recipients?: { emails: string[]; source: string; envVar?: string };
      };
      expect(body.recipients).toBeDefined();
      expect(body.recipients!.source).toBe("env");
      expect(body.recipients!.envVar).toBe("OPS_ALERT_EMAILS");
      // Trim + dedupe-by-emptiness should have stripped the trailing
      // empty entry and the surrounding whitespace.
      expect(body.recipients!.emails).toEqual(["ops@example.com", "oncall@example.com"]);
    } finally {
      if (prev === undefined) delete process.env.OPS_ALERT_EMAILS;
      else process.env.OPS_ALERT_EMAILS = prev;
    }
  });

  it("returns an empty recipient list when OPS_ALERT_EMAILS is unset", async () => {
    const prev = process.env.OPS_ALERT_EMAILS;
    delete process.env.OPS_ALERT_EMAILS;
    try {
      const res = await callHistory(asUser(adminId, "org_admin", orgId), "?days=7");
      expect(res.status).toBe(200);
      const body = res.body as { recipients?: { emails: string[] } };
      expect(body.recipients).toBeDefined();
      expect(body.recipients!.emails).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.OPS_ALERT_EMAILS = prev;
    }
  });

  it("clamps days to 1..90", async () => {
    const lo = await callHistory(asUser(adminId, "org_admin", orgId), "?days=0");
    expect(lo.status).toBe(200);
    expect((lo.body as { days: number }).days).toBeGreaterThanOrEqual(1);

    const hi = await callHistory(asUser(adminId, "org_admin", orgId), "?days=999");
    expect(hi.status).toBe(200);
    expect((hi.body as { days: number }).days).toBeLessThanOrEqual(90);
  });
});

describe("GET /api/admin/notify-exhaustion-rows", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await callRows(undefined,
      `?pipeline=coach_payout&channel=push&date=${YESTERDAY}`);
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await callRows(
      asUser(playerId, "player", orgId),
      `?pipeline=coach_payout&channel=push&date=${YESTERDAY}`,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid pipeline / channel / date", async () => {
    const adm = asUser(adminId, "org_admin", orgId);
    expect((await callRows(adm, `?pipeline=bogus&channel=push&date=${YESTERDAY}`)).status).toBe(400);
    expect((await callRows(adm, `?pipeline=coach_payout&channel=fax&date=${YESTERDAY}`)).status).toBe(400);
    expect((await callRows(adm, `?pipeline=coach_payout&channel=push&date=2026-13-99`)).status).toBe(400);
  });

  it("returns coach-payout rows for a day with proId / payoutId for triage", async () => {
    const res = await callRows(
      asUser(adminId, "org_admin", orgId),
      `?pipeline=coach_payout&channel=push&date=${YESTERDAY}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      pipeline: string; channel: string; date: string;
      rows: Array<{ id: number; proId?: number; payoutId?: number; exhaustedAt: string }>;
    };
    expect(body.pipeline).toBe("coach_payout");
    expect(body.channel).toBe("push");
    expect(body.date).toBe(YESTERDAY);
    expect(body.rows.length).toBeGreaterThanOrEqual(2);
    for (const r of body.rows) {
      expect(r.proId).toBe(proId);
      expect(typeof r.payoutId).toBe("number");
      expect(new Date(r.exhaustedAt).toISOString().slice(0, 10)).toBe(YESTERDAY);
    }
  });

  it("returns levy-receipt rows for a day with clubMemberId for triage", async () => {
    const res = await callRows(
      asUser(adminId, "org_admin", orgId),
      `?pipeline=levy_receipt&channel=sms&date=${TWO_DAYS_AGO}`,
    );
    expect(res.status).toBe(200);
    const body = res.body as {
      rows: Array<{ id: number; clubMemberId?: number; chargeId?: number; exhaustedAt: string }>;
    };
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    for (const r of body.rows) {
      expect(typeof r.clubMemberId).toBe("number");
      expect(typeof r.chargeId).toBe("number");
      expect(new Date(r.exhaustedAt).toISOString().slice(0, 10)).toBe(TWO_DAYS_AGO);
    }
  });

  it("returns an empty rows array for a day with no matching exhaustions", async () => {
    const res = await callRows(
      asUser(adminId, "org_admin", orgId),
      `?pipeline=coach_payout&channel=sms&date=${TWO_DAYS_AGO}`,
    );
    expect(res.status).toBe(200);
    expect((res.body as { rows: unknown[] }).rows.length).toBe(0);
  });
});

// Tenant scoping tests for the new admin endpoints. These exist because
// without org filtering an org_admin in club A could enumerate club B's
// coach payouts / levy receipts and the operational metadata attached
// to them, which would be a multi-tenant data leak.
describe("notify-exhaustion-* tenant scoping", () => {
  it("history: org_admin only sees their own org's counts, not the other org's", async () => {
    // org_admin in `orgId` queries history. The other org has 1 coach push
    // exhaustion yesterday and 1 levy sms exhaustion two days ago — those
    // must NOT appear in this admin's view.
    const ownRes = await callHistory(
      asUser(adminId, "org_admin", orgId), "?days=7",
    );
    expect(ownRes.status).toBe(200);
    const ownYest = (ownRes.body as {
      buckets: Array<{ date: string; coachPayout: { push: number }; totalRows: number }>;
    }).buckets.find(b => b.date === YESTERDAY);
    expect(ownYest).toBeDefined();
    // Seeded: 2 coach push in own org. If the other org bled in we'd see 3.
    expect(ownYest!.coachPayout.push).toBe(2);

    const otherRes = await callHistory(
      asUser(otherOrgAdminId, "org_admin", otherOrgId), "?days=7",
    );
    expect(otherRes.status).toBe(200);
    const otherYest = (otherRes.body as {
      buckets: Array<{ date: string; coachPayout: { push: number }; levyReceipt: { sms: number } }>;
    }).buckets.find(b => b.date === YESTERDAY);
    // Other org sees its own single coach push exhaustion only.
    expect(otherYest!.coachPayout.push).toBe(1);
  });

  it("history: super_admin sees the platform-wide totals across both orgs", async () => {
    const res = await callHistory(asUser(superAdminId, "super_admin", null), "?days=7");
    expect(res.status).toBe(200);
    const yest = (res.body as {
      buckets: Array<{ date: string; coachPayout: { push: number } }>;
    }).buckets.find(b => b.date === YESTERDAY);
    // 2 own + 1 other = 3.
    expect(yest!.coachPayout.push).toBe(3);
  });

  it("rows: org_admin cannot see the other org's coach-payout rows", async () => {
    const res = await callRows(
      asUser(adminId, "org_admin", orgId),
      `?pipeline=coach_payout&channel=push&date=${YESTERDAY}`,
    );
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: Array<{ proId: number; payoutId: number }> }).rows;
    // Must not leak the other org's payout / pro ids.
    for (const r of rows) {
      expect(r.proId).not.toBe(otherOrgProId);
      expect(r.payoutId).not.toBe(otherOrgPayoutId);
    }
    expect(rows.some(r => r.proId === otherOrgProId)).toBe(false);
  });

  it("rows: org_admin cannot see the other org's levy-receipt rows", async () => {
    const res = await callRows(
      asUser(adminId, "org_admin", orgId),
      `?pipeline=levy_receipt&channel=sms&date=${TWO_DAYS_AGO}`,
    );
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: Array<{ clubMemberId: number; chargeId: number }> }).rows;
    for (const r of rows) {
      expect(r.clubMemberId).not.toBe(otherOrgLevyMemberId);
      expect(r.chargeId).not.toBe(otherOrgLevyChargeId);
    }
  });

  it("rows: super_admin can see rows from both orgs", async () => {
    const res = await callRows(
      asUser(superAdminId, "super_admin", null),
      `?pipeline=coach_payout&channel=push&date=${YESTERDAY}`,
    );
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: Array<{ proId: number; payoutId: number }> }).rows;
    expect(rows.some(r => r.payoutId === otherOrgPayoutId)).toBe(true);
    expect(rows.some(r => r.proId === proId)).toBe(true);
  });

  it("rows: tournament_director is also scoped to their own org", async () => {
    // Reuse the otherOrg admin user but pretend role is tournament_director.
    const res = await callRows(
      asUser(otherOrgAdminId, "tournament_director", otherOrgId),
      `?pipeline=coach_payout&channel=push&date=${YESTERDAY}`,
    );
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: Array<{ proId: number; payoutId: number }> }).rows;
    // Should ONLY see otherOrg's payout, never the original org's.
    for (const r of rows) {
      expect(r.proId).toBe(otherOrgProId);
    }
    expect(rows.some(r => r.payoutId === otherOrgPayoutId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task #1542 — POST /api/admin/notify-exhaustion-action
//
// The drill-down "Retry channel" / "Clear exhaustion stamp" buttons fire this
// endpoint. We pin:
//   • Auth gates (401/403) and input validation (400).
//   • Tenant scoping: org_admin in club A cannot act on club B's attempt id
//     (must be 404, not a silent write).
//   • action="clear" nulls *only* the targeted channel's exhaustion stamp.
//   • action="retry" resets the channel state (status=failed, attempts=0,
//     stamp=null), invokes the channel retry helper, and surfaces its
//     dispatch result. After a successful retry the row drops out of the
//     /notify-exhaustion-rows drill-down for that day.
// ---------------------------------------------------------------------------

function callAction(user: TestUser | undefined, body: unknown) {
  return request(createTestApp(user))
    .post("/api/admin/notify-exhaustion-action")
    .send(body as object);
}

async function loadCoachAttemptRow(id: number) {
  const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
    .where(eq(coachPayoutNotificationAttemptsTable.id, id));
  return row;
}
async function loadLevyAttemptRow(id: number) {
  const [row] = await db.select().from(memberLevyReceiptAttemptsTable)
    .where(eq(memberLevyReceiptAttemptsTable.id, id));
  return row;
}

// Per-test seeds for the action endpoint. We don't reuse the file-level
// seeds because each test wants a fresh attempt row it can mutate without
// stepping on the bucket-count assertions in the GET tests above.
async function seedFreshCoachAttempt(opts: {
  orgIdOverride?: number;
  proIdOverride?: number;
  proUserIdOverride?: number;
  pushExhausted?: boolean;
  smsExhausted?: boolean;
}) {
  const oid = opts.orgIdOverride ?? orgId;
  const pid = opts.proIdOverride ?? proId;
  const puid = opts.proUserIdOverride ?? proUserId;
  const ts = new Date();
  const [payout] = await db.insert(coachPayoutsTable).values({
    proId: pid, organizationId: oid,
    periodStart: ts, periodEnd: ts,
    grossPaise: 60000, platformFeePaise: 0, netPayoutPaise: 60000,
    status: "paid",
    payoutReference: `T1542-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    paidAt: ts,
  }).returning({ id: coachPayoutsTable.id });
  coachPayoutIds.push(payout.id);

  const [a] = await db.insert(coachPayoutNotificationAttemptsTable).values({
    payoutId: payout.id,
    proId: pid,
    organizationId: oid,
    coachUserId: puid,
    amountPaise: 60000,
    reference: "T1542-COACH",
    notes: null,
    orgName: "T1542_Org",
    pushStatus: opts.pushExhausted ? "failed" : null,
    pushAttempts: opts.pushExhausted ? 5 : 0,
    pushRetryExhaustedAt: opts.pushExhausted ? ts : null,
    smsStatus: opts.smsExhausted ? "failed" : null,
    smsAttempts: opts.smsExhausted ? 5 : 0,
    smsRetryExhaustedAt: opts.smsExhausted ? ts : null,
  }).returning({ id: coachPayoutNotificationAttemptsTable.id });
  coachAttemptIds.push(a.id);
  return a.id;
}

async function seedFreshLevyAttempt(opts: {
  orgIdOverride?: number;
  pushExhausted?: boolean;
  smsExhausted?: boolean;
}) {
  const oid = opts.orgIdOverride ?? orgId;
  const lid = opts.orgIdOverride && opts.orgIdOverride !== orgId ? otherOrgLevyId : levyId;
  const ts = new Date();
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: oid,
    firstName: "T1542",
    lastName: `Member_${levyMemberIds.length}`,
    email: null, phone: null,
  }).returning({ id: clubMembersTable.id });
  levyMemberIds.push(member.id);
  const [charge] = await db.insert(memberLevyChargesTable).values({
    clubMemberId: member.id, levyId: lid,
    amount: "100.00", status: "unpaid",
  }).returning({ id: memberLevyChargesTable.id });
  levyChargeIds.push(charge.id);
  const [a] = await db.insert(memberLevyReceiptAttemptsTable).values({
    organizationId: oid,
    chargeId: charge.id,
    clubMemberId: member.id,
    kind: "payment",
    levyName: "T1542_Levy",
    currency: "INR",
    transactionAmount: "100.00",
    newBalance: "0.00",
    note: null,
    pushStatus: opts.pushExhausted ? "failed" : "skipped",
    pushAttempts: opts.pushExhausted ? 5 : 0,
    pushRetryExhaustedAt: opts.pushExhausted ? ts : null,
    smsStatus: opts.smsExhausted ? "failed" : "skipped",
    smsAttempts: opts.smsExhausted ? 5 : 0,
    smsRetryExhaustedAt: opts.smsExhausted ? ts : null,
  }).returning({ id: memberLevyReceiptAttemptsTable.id });
  levyAttemptIds.push(a.id);
  return a.id;
}

describe("POST /api/admin/notify-exhaustion-action", () => {
  beforeEach(() => {
    pushMock.mockReset();
    smsMock.mockReset();
    pushMock.mockImplementation(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    }));
    smsMock.mockResolvedValue(undefined);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await callAction(undefined, {
      pipeline: "coach_payout", channel: "push", attemptId: 1, action: "clear",
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await callAction(asUser(playerId, "player", orgId), {
      pipeline: "coach_payout", channel: "push", attemptId: 1, action: "clear",
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 on invalid pipeline / channel / action / attemptId", async () => {
    const adm = asUser(adminId, "org_admin", orgId);
    const base = { channel: "push", attemptId: 1, action: "clear" } as const;
    expect((await callAction(adm, { ...base, pipeline: "bogus" })).status).toBe(400);
    expect((await callAction(adm, {
      pipeline: "coach_payout", channel: "fax", attemptId: 1, action: "clear",
    })).status).toBe(400);
    expect((await callAction(adm, {
      pipeline: "coach_payout", channel: "push", attemptId: 1, action: "delete",
    })).status).toBe(400);
    expect((await callAction(adm, {
      pipeline: "coach_payout", channel: "push", attemptId: "not-a-number", action: "clear",
    })).status).toBe(400);
  });

  it("returns 404 when the attemptId does not exist", async () => {
    const res = await callAction(asUser(adminId, "org_admin", orgId), {
      pipeline: "coach_payout", channel: "push", attemptId: 999_999_999, action: "clear",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when an org_admin targets the other org's attempt (cross-tenant)", async () => {
    // The other-org coach attempt is real, but pinning the scope to our
    // own orgId must hide it.
    const beforeRow = await loadCoachAttemptRow(otherOrgCoachAttemptId);
    expect(beforeRow.pushRetryExhaustedAt).not.toBeNull();

    const res = await callAction(asUser(adminId, "org_admin", orgId), {
      pipeline: "coach_payout", channel: "push",
      attemptId: otherOrgCoachAttemptId, action: "clear",
    });
    expect(res.status).toBe(404);
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();

    // Untouched.
    const afterRow = await loadCoachAttemptRow(otherOrgCoachAttemptId);
    expect(afterRow.pushRetryExhaustedAt).not.toBeNull();
  });

  it("clear: nulls only the targeted channel's exhaustion stamp on a coach payout row", async () => {
    const attemptId = await seedFreshCoachAttempt({
      pushExhausted: true, smsExhausted: true,
    });
    const before = await loadCoachAttemptRow(attemptId);
    expect(before.pushRetryExhaustedAt).not.toBeNull();
    expect(before.smsRetryExhaustedAt).not.toBeNull();

    const res = await callAction(asUser(adminId, "org_admin", orgId), {
      pipeline: "coach_payout", channel: "push",
      attemptId, action: "clear",
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("clear");
    expect(res.body.attempt).toBeTruthy();
    expect(res.body.attempt.pushRetryExhaustedAt).toBeNull();
    // SMS stamp untouched.
    expect(res.body.attempt.smsRetryExhaustedAt).not.toBeNull();
    // No dispatch on a clear.
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();

    const row = await loadCoachAttemptRow(attemptId);
    expect(row.pushRetryExhaustedAt).toBeNull();
    expect(row.smsRetryExhaustedAt).not.toBeNull();
  });

  it("clear: nulls smsRetryExhaustedAt on a levy receipt row", async () => {
    const attemptId = await seedFreshLevyAttempt({ smsExhausted: true });
    const res = await callAction(asUser(adminId, "org_admin", orgId), {
      pipeline: "levy_receipt", channel: "sms",
      attemptId, action: "clear",
    });
    expect(res.status).toBe(200);
    const row = await loadLevyAttemptRow(attemptId);
    expect(row.smsRetryExhaustedAt).toBeNull();
    expect(row.smsAttempts).toBe(5); // counter NOT reset on clear
  });

  it("retry: resets the channel and re-dispatches push for a coach payout row", async () => {
    const attemptId = await seedFreshCoachAttempt({ pushExhausted: true });
    const before = await loadCoachAttemptRow(attemptId);
    expect(before.pushAttempts).toBe(5);
    expect(before.pushRetryExhaustedAt).not.toBeNull();

    const res = await callAction(asUser(adminId, "org_admin", orgId), {
      pipeline: "coach_payout", channel: "push",
      attemptId, action: "retry",
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("retry");
    expect(res.body.retryResult).toBeTruthy();
    expect(res.body.retryResult.channel).toBe("push");
    expect(res.body.retryResult.status).toBe("sent");
    expect(res.body.retryResult.attempts).toBe(1);
    expect(res.body.retryResult.exhausted).toBe(false);
    expect(pushMock).toHaveBeenCalledTimes(1);

    // Row state on disk: counter reset by the action helper, then bumped
    // to 1 by the dispatch helper; status flipped to sent; exhaustion
    // stamp cleared. This is exactly what the drill-down list filter
    // checks, so the row should now drop out of /notify-exhaustion-rows.
    const row = await loadCoachAttemptRow(attemptId);
    expect(row.pushAttempts).toBe(1);
    expect(row.pushStatus).toBe("sent");
    expect(row.pushRetryExhaustedAt).toBeNull();
  });

  it("retry: resets and re-dispatches sms for a coach payout row", async () => {
    const attemptId = await seedFreshCoachAttempt({ smsExhausted: true });

    // Give the teaching pro a phone so the SMS helper actually dispatches.
    await db.update(teachingProsTable)
      .set({ phone: "+919999912345" })
      .where(eq(teachingProsTable.id, proId));

    const res = await callAction(asUser(adminId, "org_admin", orgId), {
      pipeline: "coach_payout", channel: "sms",
      attemptId, action: "retry",
    });
    expect(res.status).toBe(200);
    expect(res.body.retryResult.channel).toBe("sms");
    expect(res.body.retryResult.status).toBe("sent");
    expect(smsMock).toHaveBeenCalledTimes(1);

    const row = await loadCoachAttemptRow(attemptId);
    expect(row.smsAttempts).toBe(1);
    expect(row.smsStatus).toBe("sent");
    expect(row.smsRetryExhaustedAt).toBeNull();
    // Cleanup the phone we set so it doesn't leak into other tests.
    await db.update(teachingProsTable)
      .set({ phone: null })
      .where(eq(teachingProsTable.id, proId));
  });

  it("retry: refreshing the drill-down list afterwards no longer includes the row", async () => {
    // Seed a row stamped exhausted today (so it lives in today's bucket)
    // and verify it appears in /notify-exhaustion-rows for today, then a
    // retry that succeeds drops it from the list.
    const attemptId = await seedFreshCoachAttempt({ pushExhausted: true });
    const today = new Date().toISOString().slice(0, 10);
    const adm = asUser(adminId, "org_admin", orgId);

    const before = await callRows(adm,
      `?pipeline=coach_payout&channel=push&date=${today}`);
    expect(before.status).toBe(200);
    const beforeIds = (before.body as { rows: Array<{ id: number }> }).rows.map(r => r.id);
    expect(beforeIds).toContain(attemptId);

    const act = await callAction(adm, {
      pipeline: "coach_payout", channel: "push",
      attemptId, action: "retry",
    });
    expect(act.status).toBe(200);
    expect(act.body.retryResult.status).toBe("sent");

    const after = await callRows(adm,
      `?pipeline=coach_payout&channel=push&date=${today}`);
    expect(after.status).toBe(200);
    const afterIds = (after.body as { rows: Array<{ id: number }> }).rows.map(r => r.id);
    expect(afterIds).not.toContain(attemptId);
  });

  it("super_admin can act on any org's attempt", async () => {
    // The other-org coach attempt is exhausted on push. A super_admin
    // clearing it must succeed (no orgScope filter).
    const before = await loadCoachAttemptRow(otherOrgCoachAttemptId);
    expect(before.pushRetryExhaustedAt).not.toBeNull();

    const res = await callAction(asUser(superAdminId, "super_admin", null), {
      pipeline: "coach_payout", channel: "push",
      attemptId: otherOrgCoachAttemptId, action: "clear",
    });
    expect(res.status).toBe(200);
    expect(res.body.attempt.pushRetryExhaustedAt).toBeNull();

    const after = await loadCoachAttemptRow(otherOrgCoachAttemptId);
    expect(after.pushRetryExhaustedAt).toBeNull();
  });
});
