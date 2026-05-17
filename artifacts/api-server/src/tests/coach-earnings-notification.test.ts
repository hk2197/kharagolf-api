/**
 * Task #1306 — verify GET /coach/earnings now joins each payout to its
 * matching `coach_payout_notification_attempts` row so the coach-facing
 * earnings view can render the same per-channel push/SMS state the
 * admin view uses (Task #1129).
 *
 * Coverage:
 *   • Paid payout with a sent attempt → notification.pushStatus etc.
 *     come back on the payout object.
 *   • Pending payout (no attempt row yet) → notification === null
 *     instead of dropping the payout.
 *   • Coach can only ever see their own payouts.
 *   • Backwards-compat: existing payout fields (id, status, …) keep
 *     working alongside the new `notification` field.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  coachPayoutsTable,
  coachPayoutNotificationAttemptsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let coachAUserId: number;
let coachBUserId: number;
let coachAProId: number;
let coachBProId: number;

let coachA: TestUser;
let coachB: TestUser;
let appAsCoachA: ReturnType<typeof createTestApp>;
let appAsCoachB: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `EarningsNotifTest_${stamp}`,
    slug: `earnings-notif-test-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `earnings-notif-coach-a-${stamp}`,
    username: `earnings_notif_coach_a_${stamp}`,
    email: `coach_a_${stamp}@example.com`,
    displayName: "Coach A",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachAUserId = a.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: coachAUserId, role: "player",
  });

  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `earnings-notif-coach-b-${stamp}`,
    username: `earnings_notif_coach_b_${stamp}`,
    email: `coach_b_${stamp}@example.com`,
    displayName: "Coach B",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachBUserId = b.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: coachBUserId, role: "player",
  });

  const [proA] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachAUserId, displayName: "Coach A",
  }).returning({ id: teachingProsTable.id });
  coachAProId = proA.id;
  const [proB] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachBUserId, displayName: "Coach B",
  }).returning({ id: teachingProsTable.id });
  coachBProId = proB.id;

  await db.insert(coachMarketplaceProfilesTable).values([
    { proId: coachAProId, organizationId: orgId, isListed: true, revenueSharePct: "70" },
    { proId: coachBProId, organizationId: orgId, isListed: true, revenueSharePct: "70" },
  ]);

  coachA = {
    id: coachAUserId, username: `earnings_notif_coach_a_${stamp}`,
    displayName: "Coach A", role: "player", organizationId: orgId,
  };
  coachB = {
    id: coachBUserId, username: `earnings_notif_coach_b_${stamp}`,
    displayName: "Coach B", role: "player", organizationId: orgId,
  };
  appAsCoachA = createTestApp(coachA);
  appAsCoachB = createTestApp(coachB);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  const proIds = [coachAProId, coachBProId].filter(Boolean);
  if (proIds.length) {
    await db.delete(coachPayoutNotificationAttemptsTable)
      .where(inArray(coachPayoutNotificationAttemptsTable.proId, proIds));
    await db.delete(coachPayoutsTable)
      .where(inArray(coachPayoutsTable.proId, proIds));
    await db.delete(coachMarketplaceProfilesTable)
      .where(inArray(coachMarketplaceProfilesTable.proId, proIds));
    await db.delete(teachingProsTable)
      .where(inArray(teachingProsTable.id, proIds));
  }
  const userIds = [coachAUserId, coachBUserId].filter(Boolean);
  if (userIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  // Wipe payouts + attempts between tests so each test starts clean.
  await db.delete(coachPayoutNotificationAttemptsTable)
    .where(inArray(coachPayoutNotificationAttemptsTable.proId, [coachAProId, coachBProId]));
  await db.delete(coachPayoutsTable)
    .where(inArray(coachPayoutsTable.proId, [coachAProId, coachBProId]));
});

async function seedPayout(opts: {
  proId: number;
  status?: "pending" | "processing" | "paid" | "failed";
  reference?: string | null;
  withAttempt?: {
    pushStatus?: string | null;
    pushAttempts?: number;
    pushExhausted?: boolean;
    smsStatus?: string | null;
    smsAttempts?: number;
    smsExhausted?: boolean;
    // Task #1544 — masked snapshots of the contact details we tried.
    // Both default to null so existing tests don't have to thread them.
    pushTargetLabel?: string | null;
    smsTargetMasked?: string | null;
  };
}) {
  const now = new Date();
  const [payout] = await db.insert(coachPayoutsTable).values({
    proId: opts.proId,
    organizationId: orgId,
    periodStart: now,
    periodEnd: now,
    grossPaise: 50000,
    platformFeePaise: 10000,
    netPayoutPaise: 40000,
    status: opts.status ?? "paid",
    payoutReference: opts.reference ?? "REF-1306",
    paidAt: opts.status === "pending" ? null : now,
    paidNotifiedAt: opts.status === "pending" ? null : now,
  }).returning();
  if (opts.withAttempt) {
    await db.insert(coachPayoutNotificationAttemptsTable).values({
      payoutId: payout.id,
      proId: opts.proId,
      organizationId: orgId,
      coachUserId: opts.proId === coachAProId ? coachAUserId : coachBUserId,
      amountPaise: 40000,
      reference: opts.reference ?? "REF-1306",
      pushStatus: opts.withAttempt.pushStatus ?? null,
      pushAttempts: opts.withAttempt.pushAttempts ?? 0,
      lastPushError: opts.withAttempt.pushStatus === "failed" ? "boom" : null,
      pushRetryExhaustedAt: opts.withAttempt.pushExhausted ? now : null,
      pushTargetLabel: opts.withAttempt.pushTargetLabel ?? null,
      smsStatus: opts.withAttempt.smsStatus ?? null,
      smsAttempts: opts.withAttempt.smsAttempts ?? 0,
      lastSmsError: opts.withAttempt.smsStatus === "failed" ? "boom" : null,
      smsRetryExhaustedAt: opts.withAttempt.smsExhausted ? now : null,
      smsTargetMasked: opts.withAttempt.smsTargetMasked ?? null,
    });
  }
  return payout;
}

describe("GET /coach/earnings — Task #1306 notification join", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous).get("/api/swing-reviews/coach/earnings");
    expect(res.status).toBe(401);
  });

  it("includes the joined notification row for a paid payout with an attempt", async () => {
    await seedPayout({
      proId: coachAProId,
      status: "paid",
      reference: "REF-A-SENT",
      withAttempt: {
        pushStatus: "sent", pushAttempts: 1,
        smsStatus: "sent", smsAttempts: 1,
      },
    });
    const res = await request(appAsCoachA).get("/api/swing-reviews/coach/earnings");
    expect(res.status, res.text).toBe(200);
    expect(Array.isArray(res.body.payouts)).toBe(true);
    expect(res.body.payouts).toHaveLength(1);
    const p = res.body.payouts[0];
    // Backwards-compat fields still present.
    expect(p.id).toBeTypeOf("number");
    expect(p.status).toBe("paid");
    expect(p.payoutReference).toBe("REF-A-SENT");
    // New: notification join.
    expect(p.notification).not.toBeNull();
    expect(p.notification.pushStatus).toBe("sent");
    expect(p.notification.smsStatus).toBe("sent");
    expect(p.notification.pushAttempts).toBe(1);
    expect(p.notification.smsAttempts).toBe(1);
  });

  it("returns notification === null for a payout with no attempt row yet", async () => {
    await seedPayout({
      proId: coachAProId,
      status: "pending",
      reference: "REF-A-PENDING",
      // intentionally no withAttempt
    });
    const res = await request(appAsCoachA).get("/api/swing-reviews/coach/earnings");
    expect(res.status, res.text).toBe(200);
    expect(res.body.payouts).toHaveLength(1);
    const p = res.body.payouts[0];
    expect(p.status).toBe("pending");
    expect(p.notification).toBeNull();
  });

  it("surfaces failure / exhaustion state on the notification object", async () => {
    await seedPayout({
      proId: coachAProId,
      status: "paid",
      reference: "REF-A-EXHAUSTED",
      withAttempt: {
        pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
        smsStatus: "no_address", smsAttempts: 0,
      },
    });
    const res = await request(appAsCoachA).get("/api/swing-reviews/coach/earnings");
    expect(res.status, res.text).toBe(200);
    expect(res.body.payouts).toHaveLength(1);
    const p = res.body.payouts[0];
    expect(p.notification).not.toBeNull();
    expect(p.notification.pushStatus).toBe("failed");
    expect(p.notification.pushAttempts).toBe(5);
    expect(p.notification.pushRetryExhaustedAt).not.toBeNull();
    expect(p.notification.smsStatus).toBe("no_address");
  });

  it("surfaces the masked target snapshots from Task #1544", async () => {
    // The send/retry paths populate `pushTargetLabel` and `smsTargetMasked`
    // when a channel attempt missed; the earnings endpoint must hand
    // them through unchanged so the coach UI can show "we tried +91 ……
    // 4321 / 1 expo device" alongside the failure badge.
    await seedPayout({
      proId: coachAProId,
      status: "paid",
      reference: "REF-A-MASKED",
      withAttempt: {
        pushStatus: "failed",
        pushAttempts: 3,
        pushTargetLabel: "1 expo device",
        smsStatus: "failed",
        smsAttempts: 3,
        smsTargetMasked: "+91 ●●●●●● 4321",
      },
    });
    const res = await request(appAsCoachA).get("/api/swing-reviews/coach/earnings");
    expect(res.status, res.text).toBe(200);
    const p = res.body.payouts[0];
    expect(p.notification).not.toBeNull();
    expect(p.notification.pushTargetLabel).toBe("1 expo device");
    expect(p.notification.smsTargetMasked).toBe("+91 ●●●●●● 4321");
  });

  it("returns null target snapshots on legacy rows without the columns set", async () => {
    // Pre-#1544 attempts rows have no snapshot; the endpoint must emit
    // `null` (not `undefined`) so the UI's `!!notification.pushTargetLabel`
    // guard correctly hides the "tried ..." chip on legacy data.
    await seedPayout({
      proId: coachAProId,
      status: "paid",
      reference: "REF-A-LEGACY",
      withAttempt: { pushStatus: "sent", pushAttempts: 1, smsStatus: "sent", smsAttempts: 1 },
    });
    const res = await request(appAsCoachA).get("/api/swing-reviews/coach/earnings");
    expect(res.status, res.text).toBe(200);
    const p = res.body.payouts[0];
    expect(p.notification.pushTargetLabel).toBeNull();
    expect(p.notification.smsTargetMasked).toBeNull();
  });

  it("never leaks another coach's payouts or notifications", async () => {
    // Coach A gets a payout, Coach B should not see it.
    await seedPayout({
      proId: coachAProId,
      status: "paid",
      reference: "REF-A-PRIVATE",
      withAttempt: { pushStatus: "sent", pushAttempts: 1 },
    });
    await seedPayout({
      proId: coachBProId,
      status: "paid",
      reference: "REF-B-OWN",
      withAttempt: { pushStatus: "failed", pushAttempts: 5, pushExhausted: true },
    });

    const resB = await request(appAsCoachB).get("/api/swing-reviews/coach/earnings");
    expect(resB.status, resB.text).toBe(200);
    expect(resB.body.payouts).toHaveLength(1);
    expect(resB.body.payouts[0].payoutReference).toBe("REF-B-OWN");
    expect(resB.body.payouts[0].notification.pushStatus).toBe("failed");

    const resA = await request(appAsCoachA).get("/api/swing-reviews/coach/earnings");
    expect(resA.status, resA.text).toBe(200);
    expect(resA.body.payouts).toHaveLength(1);
    expect(resA.body.payouts[0].payoutReference).toBe("REF-A-PRIVATE");
  });
});
