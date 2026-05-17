/**
 * Task #1854 — admin-only in-app dashboard at /admin/notify-failures.
 *
 * Pins the contract of the two new endpoints that surface and act on
 * exhausted wallet-refund / coach-payout-account-change notify rows
 * (the same data the Task #1507 cron emails as a daily admin digest):
 *
 *   • GET  /api/admin/notify-failures
 *   • POST /api/admin/notify-failures/resend
 *
 * Covers:
 *   1. 401 when unauthenticated, 403 for non-admin roles.
 *   2. Tenant scoping — org_admin only sees their own org's rows;
 *      super_admin sees both orgs.
 *   3. Rows include channel(s), last error, exhaustion stamp and
 *      digestedAt status, and surface the affected member/coach
 *      metadata downstream rendering needs.
 *   4. Resend requires both pipeline + numeric attemptId; bad input → 400.
 *   5. Resend is tenant-scoped — org_admin trying to resend another
 *      org's row gets 404, not 200.
 *   6. Resend resets only the channels that were exhausted, leaving
 *      a non-exhausted channel's bookkeeping untouched, then calls
 *      the channel-specific retry helper so a follow-up GET drops the
 *      row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

// Mock comms so the resend-action test doesn't reach real providers.
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

// Mock mailer so the "email" channel resend doesn't try to talk to a
// real SMTP provider; we just need the helper to return a non-null
// retry result so the route reports `outcomes`. The exact export
// names matter — these are the symbols the wallet-refund and
// coach-payout-account-change retry helpers import from `mailer.ts`.
vi.mock("../../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mailer.js")>();
  return {
    ...actual,
    sendWalletTopupAutoRefundedEmail: vi.fn(async () => undefined),
    sendCoachPayoutAccountChangedEmail: vi.fn(async () => undefined),
  };
});

import {
  db,
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  teachingProsTable,
  coachPayoutAccountHistoryTable,
  walletTopupRefundNotifyAttemptsTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "../../tests/helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

let orgId: number;
let otherOrgId: number;

let adminId: number;
let otherOrgAdminId: number;
let superAdminId: number;
let playerId: number;

let memberUserId: number;
let memberId: number;
let proId: number;
let proUserId: number;
let historyId: number;

let otherMemberUserId: number;
let otherProId: number;
let otherProUserId: number;
let otherHistoryId: number;

const walletAttemptIds: number[] = [];
const coachAttemptIds: number[] = [];

const NOW = new Date("2026-04-30T12:00:00Z");
const HOUR = 60 * 60_000;

async function makeWalletAttempt(opts: {
  orgId: number;
  userId: number;
  paymentId: string;
  emailExhaustedAt?: Date | null;
  pushExhaustedAt?: Date | null;
  adminDigestSentAt?: Date | null;
  lastEmailError?: string | null;
  lastPushError?: string | null;
}): Promise<number> {
  const [r] = await db.insert(walletTopupRefundNotifyAttemptsTable).values({
    paymentId: opts.paymentId,
    organizationId: opts.orgId,
    userId: opts.userId,
    refundId: `rfnd_${opts.paymentId}`,
    amount: "499.00",
    currency: "INR",
    emailStatus: opts.emailExhaustedAt ? "failed" : null,
    emailAttempts: opts.emailExhaustedAt ? 5 : 0,
    lastEmailError: opts.lastEmailError ?? null,
    emailRetryExhaustedAt: opts.emailExhaustedAt ?? null,
    pushStatus: opts.pushExhaustedAt ? "failed" : null,
    pushAttempts: opts.pushExhaustedAt ? 5 : 0,
    lastPushError: opts.lastPushError ?? null,
    pushRetryExhaustedAt: opts.pushExhaustedAt ?? null,
    adminDigestSentAt: opts.adminDigestSentAt ?? null,
  }).returning({ id: walletTopupRefundNotifyAttemptsTable.id });
  walletAttemptIds.push(r.id);
  return r.id;
}

async function makeCoachAttempt(opts: {
  orgId: number;
  proId: number;
  coachUserId: number;
  historyId: number;
  emailExhaustedAt?: Date | null;
  pushExhaustedAt?: Date | null;
  adminDigestSentAt?: Date | null;
  lastEmailError?: string | null;
}): Promise<number> {
  const [r] = await db.insert(coachPayoutAccountChangeNotifyAttemptsTable).values({
    historyId: opts.historyId,
    organizationId: opts.orgId,
    proId: opts.proId,
    coachUserId: opts.coachUserId,
    changeKind: "updated",
    method: "upi",
    emailStatus: opts.emailExhaustedAt ? "failed" : null,
    emailAttempts: opts.emailExhaustedAt ? 5 : 0,
    lastEmailError: opts.lastEmailError ?? null,
    emailRetryExhaustedAt: opts.emailExhaustedAt ?? null,
    pushStatus: opts.pushExhaustedAt ? "failed" : null,
    pushAttempts: opts.pushExhaustedAt ? 5 : 0,
    pushRetryExhaustedAt: opts.pushExhaustedAt ?? null,
    adminDigestSentAt: opts.adminDigestSentAt ?? null,
  }).returning({ id: coachPayoutAccountChangeNotifyAttemptsTable.id });
  coachAttemptIds.push(r.id);
  return r.id;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `T1854_${stamp}`, slug: `t1854-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [other] = await db.insert(organizationsTable).values({
    name: `T1854_other_${stamp}`, slug: `t1854-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = other.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-admin-${stamp}`, username: `t1854_admin_${stamp}`,
    email: `admin_${stamp}@t1854.test`, role: "org_admin", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [otherAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-other-admin-${stamp}`, username: `t1854_other_admin_${stamp}`,
    email: `other_admin_${stamp}@t1854.test`, role: "org_admin", organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherOrgAdminId = otherAdmin.id;

  const [superAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-super-${stamp}`, username: `t1854_super_${stamp}`,
    email: `super_${stamp}@t1854.test`, role: "super_admin", organizationId: null,
  }).returning({ id: appUsersTable.id });
  superAdminId = superAdmin.id;

  const [player] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-player-${stamp}`, username: `t1854_player_${stamp}`,
    email: `player_${stamp}@t1854.test`, role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  playerId = player.id;

  const [memberUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-member-${stamp}`, username: `t1854_member_${stamp}`,
    email: `member_${stamp}@t1854.test`, role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = memberUser.id;

  const [member] = await db.insert(clubMembersTable).values({
    organizationId: orgId, userId: memberUserId,
    firstName: "Wallace", lastName: "Wallet",
    email: `member-club_${stamp}@t1854.test`,
  }).returning({ id: clubMembersTable.id });
  memberId = member.id;

  const [proUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-pro-${stamp}`, username: `t1854_pro_${stamp}`,
    email: `pro_${stamp}@t1854.test`, role: "player", organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  proUserId = proUser.id;

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: proUserId, displayName: "Coach Carla",
    email: `coach_${stamp}@t1854.test`,
  }).returning({ id: teachingProsTable.id });
  proId = pro.id;

  const [hist] = await db.insert(coachPayoutAccountHistoryTable).values({
    proId, organizationId: orgId, changedByRole: "coach",
    changeKind: "updated", method: "upi",
    accountHolderName: "Coach Carla", upiVpaMasked: "co****@upi",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  historyId = hist.id;

  // Other-org seeds — these must never be visible to the first org's
  // admin and must not be acted on by the first org's resend.
  const [otherMemberUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-other-member-${stamp}`, username: `t1854_other_member_${stamp}`,
    email: `other_member_${stamp}@t1854.test`, role: "player", organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherMemberUserId = otherMemberUser.id;

  const [otherProUser] = await db.insert(appUsersTable).values({
    replitUserId: `t1854-other-pro-${stamp}`, username: `t1854_other_pro_${stamp}`,
    email: `other_pro_${stamp}@t1854.test`, role: "player", organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  otherProUserId = otherProUser.id;

  const [otherPro] = await db.insert(teachingProsTable).values({
    organizationId: otherOrgId, userId: otherProUserId, displayName: "Other Coach",
    email: `other_coach_${stamp}@t1854.test`,
  }).returning({ id: teachingProsTable.id });
  otherProId = otherPro.id;

  const [otherHist] = await db.insert(coachPayoutAccountHistoryTable).values({
    proId: otherProId, organizationId: otherOrgId, changedByRole: "coach",
    changeKind: "updated", method: "upi",
    accountHolderName: "Other Coach", upiVpaMasked: "ot****@upi",
  }).returning({ id: coachPayoutAccountHistoryTable.id });
  otherHistoryId = otherHist.id;
});

beforeEach(async () => {
  if (walletAttemptIds.length > 0) {
    await db.delete(walletTopupRefundNotifyAttemptsTable)
      .where(inArray(walletTopupRefundNotifyAttemptsTable.id, walletAttemptIds));
    walletAttemptIds.length = 0;
  }
  if (coachAttemptIds.length > 0) {
    await db.delete(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(inArray(coachPayoutAccountChangeNotifyAttemptsTable.id, coachAttemptIds));
    coachAttemptIds.length = 0;
  }
});

afterAll(async () => {
  if (walletAttemptIds.length > 0) {
    await db.delete(walletTopupRefundNotifyAttemptsTable)
      .where(inArray(walletTopupRefundNotifyAttemptsTable.id, walletAttemptIds));
  }
  if (coachAttemptIds.length > 0) {
    await db.delete(coachPayoutAccountChangeNotifyAttemptsTable)
      .where(inArray(coachPayoutAccountChangeNotifyAttemptsTable.id, coachAttemptIds));
  }
  await db.delete(coachPayoutAccountHistoryTable)
    .where(inArray(coachPayoutAccountHistoryTable.id, [historyId, otherHistoryId].filter(Boolean) as number[]));
  await db.delete(teachingProsTable)
    .where(inArray(teachingProsTable.id, [proId, otherProId].filter(Boolean) as number[]));
  await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, [memberId].filter(Boolean) as number[]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [
    adminId, otherOrgAdminId, superAdminId, playerId, memberUserId, proUserId, otherMemberUserId, otherProUserId,
  ].filter(Boolean) as number[]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId, otherOrgId].filter(Boolean) as number[]));
});

const adminUser = (): TestUser => ({
  id: adminId, username: `t1854_admin_${stamp}`, role: "org_admin", organizationId: orgId,
});
const otherAdminUser = (): TestUser => ({
  id: otherOrgAdminId, username: `t1854_other_admin_${stamp}`, role: "org_admin", organizationId: otherOrgId,
});
const superUser = (): TestUser => ({
  id: superAdminId, username: `t1854_super_${stamp}`, role: "super_admin",
});
const playerUser = (): TestUser => ({
  id: playerId, username: `t1854_player_${stamp}`, role: "player", organizationId: orgId,
});

describe("GET /api/admin/notify-failures", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = createTestApp();
    const res = await request(app).get("/api/admin/notify-failures");
    expect(res.status).toBe(401);
  });

  it("returns 403 for player role", async () => {
    const app = createTestApp(playerUser());
    const res = await request(app).get("/api/admin/notify-failures");
    expect(res.status).toBe(403);
  });

  it("lists exhausted wallet + coach rows for the caller's org with affected metadata and digest status", async () => {
    const walletId = await makeWalletAttempt({
      orgId, userId: memberUserId,
      paymentId: `pay_${stamp}_wallet`,
      emailExhaustedAt: new Date(NOW.getTime() - 2 * HOUR),
      lastEmailError: "smtp 550",
    });
    const coachId = await makeCoachAttempt({
      orgId, proId, coachUserId: proUserId, historyId,
      pushExhaustedAt: new Date(NOW.getTime() - 1 * HOUR),
      adminDigestSentAt: new Date(NOW.getTime() - 30 * 60_000),
    });

    const app = createTestApp(adminUser());
    const res = await request(app).get("/api/admin/notify-failures");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);

    const byKey = new Map<string, any>(
      (res.body.rows as any[]).map((r) => [`${r.pipeline}:${r.attemptId}`, r]),
    );
    expect(byKey.has(`wallet_refund:${walletId}`)).toBe(true);
    expect(byKey.has(`coach_payout_account_change:${coachId}`)).toBe(true);

    const wallet = byKey.get(`wallet_refund:${walletId}`);
    expect(wallet.channels).toEqual(["email"]);
    expect(wallet.lastError).toBe("smtp 550");
    expect(wallet.organizationId).toBe(orgId);
    expect(wallet.digestedAt).toBeNull();
    expect(wallet.walletRefund).toMatchObject({
      paymentId: `pay_${stamp}_wallet`,
      currency: "INR",
      userId: memberUserId,
      memberName: "Wallace Wallet",
    });

    const coach = byKey.get(`coach_payout_account_change:${coachId}`);
    expect(coach.channels).toEqual(["push"]);
    expect(coach.digestedAt).not.toBeNull();
    expect(coach.coachPayoutAccountChange).toMatchObject({
      proId, coachUserId: proUserId, coachName: "Coach Carla", method: "upi",
    });
  });

  it("hides other-org rows from an org_admin and reveals them to super_admin", async () => {
    const myWalletId = await makeWalletAttempt({
      orgId, userId: memberUserId, paymentId: `pay_${stamp}_mine`,
      emailExhaustedAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    const otherWalletId = await makeWalletAttempt({
      orgId: otherOrgId, userId: otherMemberUserId, paymentId: `pay_${stamp}_other`,
      emailExhaustedAt: new Date(NOW.getTime() - 1 * HOUR),
    });

    const orgRes = await request(createTestApp(adminUser())).get("/api/admin/notify-failures");
    expect(orgRes.status).toBe(200);
    const orgIds = (orgRes.body.rows as any[])
      .filter((r) => r.pipeline === "wallet_refund")
      .map((r) => r.attemptId);
    expect(orgIds).toContain(myWalletId);
    expect(orgIds).not.toContain(otherWalletId);

    const superRes = await request(createTestApp(superUser())).get("/api/admin/notify-failures");
    expect(superRes.status).toBe(200);
    const superIds = (superRes.body.rows as any[])
      .filter((r) => r.pipeline === "wallet_refund")
      .map((r) => r.attemptId);
    expect(superIds).toContain(myWalletId);
    expect(superIds).toContain(otherWalletId);
  });

  it("excludes rows whose retry counter has not run out", async () => {
    const liveId = await makeWalletAttempt({
      orgId, userId: memberUserId, paymentId: `pay_${stamp}_live`,
      // Neither email nor push exhausted — should never appear.
    });
    const exhaustedId = await makeWalletAttempt({
      orgId, userId: memberUserId, paymentId: `pay_${stamp}_dead`,
      emailExhaustedAt: new Date(NOW.getTime() - 1 * HOUR),
    });

    const res = await request(createTestApp(adminUser())).get("/api/admin/notify-failures");
    expect(res.status).toBe(200);
    const ids = (res.body.rows as any[])
      .filter((r) => r.pipeline === "wallet_refund")
      .map((r) => r.attemptId);
    expect(ids).toContain(exhaustedId);
    expect(ids).not.toContain(liveId);
  });
});

describe("POST /api/admin/notify-failures/resend", () => {
  it("returns 401 unauthenticated, 403 player", async () => {
    expect(
      (await request(createTestApp()).post("/api/admin/notify-failures/resend")
        .send({ pipeline: "wallet_refund", attemptId: 1 })).status,
    ).toBe(401);
    expect(
      (await request(createTestApp(playerUser())).post("/api/admin/notify-failures/resend")
        .send({ pipeline: "wallet_refund", attemptId: 1 })).status,
    ).toBe(403);
  });

  it("rejects invalid pipeline / attemptId with 400", async () => {
    const app = createTestApp(adminUser());
    expect(
      (await request(app).post("/api/admin/notify-failures/resend")
        .send({ pipeline: "bogus", attemptId: 1 })).status,
    ).toBe(400);
    expect(
      (await request(app).post("/api/admin/notify-failures/resend")
        .send({ pipeline: "wallet_refund", attemptId: "abc" })).status,
    ).toBe(400);
    expect(
      (await request(app).post("/api/admin/notify-failures/resend")
        .send({ pipeline: "wallet_refund" })).status,
    ).toBe(400);
  });

  it("returns 404 when the attempt belongs to another org", async () => {
    const otherWalletId = await makeWalletAttempt({
      orgId: otherOrgId, userId: otherMemberUserId, paymentId: `pay_${stamp}_404`,
      emailExhaustedAt: new Date(NOW.getTime() - 1 * HOUR),
    });

    const res = await request(createTestApp(adminUser()))
      .post("/api/admin/notify-failures/resend")
      .send({ pipeline: "wallet_refund", attemptId: otherWalletId });
    expect(res.status).toBe(404);
  });

  it("clears the exhaustion stamp on the previously-exhausted channel and the row drops from the next list", async () => {
    const walletId = await makeWalletAttempt({
      orgId, userId: memberUserId, paymentId: `pay_${stamp}_resend`,
      emailExhaustedAt: new Date(NOW.getTime() - 1 * HOUR),
      lastEmailError: "smtp 421",
    });

    const app = createTestApp(adminUser());
    const before = await request(app).get("/api/admin/notify-failures");
    const beforeIds = (before.body.rows as any[]).map((r) => r.attemptId);
    expect(beforeIds).toContain(walletId);

    const resend = await request(app).post("/api/admin/notify-failures/resend")
      .send({ pipeline: "wallet_refund", attemptId: walletId });
    expect(resend.status).toBe(200);
    expect(resend.body.pipeline).toBe("wallet_refund");
    expect(resend.body.attemptId).toBe(walletId);
    expect(Array.isArray(resend.body.outcomes)).toBe(true);
    // We only exhausted email, so push must be untouched.
    const channelsTouched = (resend.body.outcomes as any[]).map((o) => o.channel);
    expect(channelsTouched).toEqual(["email"]);

    // The exhaustion stamp on the row must be cleared regardless of
    // whether the retry helper actually delivered (provider may be
    // unconfigured in the test env). Re-querying the listing is the
    // cheapest way to assert that — the row falls out the moment both
    // exhaustion stamps are null.
    const after = await request(app).get("/api/admin/notify-failures");
    const afterIds = (after.body.rows as any[]).map((r) => r.attemptId);
    expect(afterIds).not.toContain(walletId);
  });
});
