/**
 * Tests for the coach revenue & payouts admin surface — Task #612.
 *
 * Covers the endpoints that back the new `/coach-admin` page:
 *
 *   GET  /coach-marketplace/admin/coaches      (lifetime gross/net + outstanding math)
 *   POST /swing-reviews/admin/payouts/run      (aggregates delivered+unpaid into payouts)
 *   POST /swing-reviews/admin/payouts/:id/mark-paid  (admin-only, requires reference)
 *
 * Coaches are seeded WITHOUT a registered Razorpay payout account so the run
 * batch handler does not attempt a live RazorpayX call — payouts are left in
 * `pending` with a `failureReason`, which is exactly the path an admin would
 * later resolve via `mark-paid`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Hoisted mock for the RazorpayX payout call so the retry happy-path test
// can exercise the route without a network round-trip. We keep every other
// export (getRazorpayClient, getRazorpayKeyId, etc.) intact so the rest of
// `routes/swing-reviews.ts` continues to import the real module.
const { createRazorpayPayoutMock } = vi.hoisted(() => ({
  createRazorpayPayoutMock: vi.fn(),
}));
vi.mock("../lib/razorpay", async () => {
  const actual = await vi.importActual<typeof import("../lib/razorpay")>("../lib/razorpay");
  return { ...actual, createRazorpayPayout: createRazorpayPayoutMock };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  swingVideosTable,
  swingReviewRequestsTable,
  coachPayoutsTable,
  coachPayoutNotificationAttemptsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let otherOrgId: number;
let adminUserId: number;
let memberUserId: number;
let nonAdminUserId: number;
let coachAUserId: number;
let coachBUserId: number;
let coachAProId: number;
let coachBProId: number;
let coachAVideoId: number;
let coachBVideoId: number;

let admin: TestUser;
let nonAdmin: TestUser;
let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsNonAdmin: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;

async function clearReviewsAndPayouts() {
  // Detach review requests from any payouts and delete both, so each test
  // starts with a clean slate for the run-batch / mark-paid flows.
  await db.update(swingReviewRequestsTable)
    .set({ payoutId: null })
    .where(eq(swingReviewRequestsTable.organizationId, orgId));
  await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.organizationId, orgId));
  await db.delete(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.organizationId, orgId));
}

async function seedDeliveredReview(proId: number, videoId: number, pricePaise: number) {
  const [row] = await db.insert(swingReviewRequestsTable).values({
    organizationId: orgId,
    proId,
    userId: memberUserId,
    swingVideoId: videoId,
    pricePaise,
    status: "delivered",
    escrowHeld: true,
    deliveredAt: new Date(),
  }).returning();
  return row;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `CoachAdminTest_${stamp}`,
    slug: `coach-admin-test-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `CoachAdminOther_${stamp}`,
    slug: `coach-admin-other-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [adminU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-admin-${stamp}`,
    username: `coach_admin_${stamp}`,
    email: `coach_admin_${stamp}@example.com`,
    displayName: "Coach Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminU.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId: adminUserId, role: "org_admin",
  });

  const [memberU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-admin-member-${stamp}`,
    username: `coach_admin_member_${stamp}`,
    email: `coach_admin_member_${stamp}@example.com`,
    displayName: "Coach Admin Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = memberU.id;

  const [nonAdminU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-admin-nonadmin-${stamp}`,
    username: `coach_admin_nonadmin_${stamp}`,
    email: `coach_admin_nonadmin_${stamp}@example.com`,
    displayName: "Coach Admin NonAdmin",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  nonAdminUserId = nonAdminU.id;

  const [coachAU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-admin-coachA-${stamp}`,
    username: `coach_admin_coachA_${stamp}`,
    email: `coach_admin_coachA_${stamp}@example.com`,
    displayName: "Coach A",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachAUserId = coachAU.id;

  const [coachBU] = await db.insert(appUsersTable).values({
    replitUserId: `coach-admin-coachB-${stamp}`,
    username: `coach_admin_coachB_${stamp}`,
    email: `coach_admin_coachB_${stamp}@example.com`,
    displayName: "Coach B",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachBUserId = coachBU.id;

  const [proA] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachAUserId, displayName: "Coach A",
  }).returning({ id: teachingProsTable.id });
  coachAProId = proA.id;

  const [proB] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachBUserId, displayName: "Coach B",
  }).returning({ id: teachingProsTable.id });
  coachBProId = proB.id;

  // Coach A: explicit 80% revenue share
  await db.insert(coachMarketplaceProfilesTable).values({
    proId: coachAProId, organizationId: orgId,
    isListed: true, revenueSharePct: "80",
    asyncReviewPricePaise: 50000,
  });
  // Coach B: no profile row — exercises the default 70% fallback in the math.

  const [vidA] = await db.insert(swingVideosTable).values({
    userId: memberUserId, organizationId: orgId,
    videoUrl: "https://example.com/a.mp4",
  }).returning({ id: swingVideosTable.id });
  coachAVideoId = vidA.id;

  const [vidB] = await db.insert(swingVideosTable).values({
    userId: memberUserId, organizationId: orgId,
    videoUrl: "https://example.com/b.mp4",
  }).returning({ id: swingVideosTable.id });
  coachBVideoId = vidB.id;

  admin = {
    id: adminUserId, username: `coach_admin_${stamp}`,
    displayName: "Coach Admin", role: "org_admin", organizationId: orgId,
  };
  nonAdmin = {
    id: nonAdminUserId, username: `coach_admin_nonadmin_${stamp}`,
    displayName: "Coach Admin NonAdmin", role: "player", organizationId: orgId,
  };
  appAsAdmin = createTestApp(admin);
  appAsNonAdmin = createTestApp(nonAdmin);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  if (orgId) {
    await db.delete(swingReviewRequestsTable).where(eq(swingReviewRequestsTable.organizationId, orgId));
    await db.delete(coachPayoutsTable).where(eq(coachPayoutsTable.organizationId, orgId));
    await db.delete(swingVideosTable).where(eq(swingVideosTable.organizationId, orgId));
    await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.organizationId, orgId));
    await db.delete(teachingProsTable).where(eq(teachingProsTable.organizationId, orgId));
  }
  const userIds = [adminUserId, memberUserId, nonAdminUserId, coachAUserId, coachBUserId].filter(Boolean);
  if (userIds.length) await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (otherOrgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
});

beforeEach(async () => {
  await clearReviewsAndPayouts();
});

// ─── GET /coach-marketplace/admin/coaches ─────────────────────────────

describe("GET /coach-marketplace/admin/coaches", () => {
  it("requires authentication", async () => {
    const res = await request(appAnonymous)
      .get(`/api/coach-marketplace/admin/coaches`)
      .query({ organizationId: orgId });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin caller", async () => {
    const res = await request(appAsNonAdmin)
      .get(`/api/coach-marketplace/admin/coaches`)
      .query({ organizationId: orgId });
    expect(res.status).toBe(403);
  });

  it("returns 400 when organizationId is missing and the caller has none", async () => {
    const orphan: TestUser = { id: nonAdminUserId, username: "orphan", role: "super_admin" };
    const orphanApp = createTestApp(orphan);
    const res = await request(orphanApp).get(`/api/coach-marketplace/admin/coaches`);
    expect(res.status).toBe(400);
  });

  it("computes lifetime gross/net and outstanding balance per coach", async () => {
    // Coach A: two delivered, one already paid out (so it should NOT count as outstanding,
    // but DOES count as lifetime gross). Coach B: one delivered, unpaid.
    const a1 = await seedDeliveredReview(coachAProId, coachAVideoId, 50000);
    const a2 = await seedDeliveredReview(coachAProId, coachAVideoId, 30000);
    const b1 = await seedDeliveredReview(coachBProId, coachBVideoId, 40000);

    // Mark a1 as already attached to a paid payout — counts toward lifetime
    // gross but is no longer outstanding.
    const [paidPayout] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId, organizationId: orgId,
      periodStart: new Date(), periodEnd: new Date(),
      grossPaise: 50000, platformFeePaise: 10000, netPayoutPaise: 40000,
      status: "paid", paidAt: new Date(), payoutReference: "manual-1",
    }).returning();
    await db.update(swingReviewRequestsTable)
      .set({ payoutId: paidPayout.id })
      .where(eq(swingReviewRequestsTable.id, a1.id));

    // Throw in a non-delivered request — must NOT count anywhere.
    await db.insert(swingReviewRequestsTable).values({
      organizationId: orgId, proId: coachAProId, userId: memberUserId,
      swingVideoId: coachAVideoId, pricePaise: 99999, status: "in_review",
    });
    void a2; void b1;

    const res = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/coaches`)
      .query({ organizationId: orgId });
    expect(res.status, res.text).toBe(200);
    const coaches: Array<{
      proId: number; revenueSharePct: number;
      lifetimeGrossPaise: number; lifetimeNetPayoutPaise: number;
      outstandingGrossPaise: number; outstandingNetPayoutPaise: number;
      outstandingCount: number; deliveredCount: number;
    }> = res.body.coaches;
    expect(Array.isArray(coaches)).toBe(true);
    const a = coaches.find(c => c.proId === coachAProId)!;
    const b = coaches.find(c => c.proId === coachBProId)!;
    expect(a, "expected coach A").toBeDefined();
    expect(b, "expected coach B").toBeDefined();

    // Coach A: 80% share, gross 50000 + 30000 = 80000, net = 64000
    expect(a.revenueSharePct).toBe(80);
    expect(a.lifetimeGrossPaise).toBe(80000);
    expect(a.lifetimeNetPayoutPaise).toBe(64000);
    expect(a.deliveredCount).toBe(2);
    // Outstanding: only a2 (a1 has a payoutId now) = 30000 gross, net 24000
    expect(a.outstandingGrossPaise).toBe(30000);
    expect(a.outstandingNetPayoutPaise).toBe(24000);
    expect(a.outstandingCount).toBe(1);

    // Coach B: default 70% share, single delivered+unpaid 40000 → net 28000
    expect(b.revenueSharePct).toBe(70);
    expect(b.lifetimeGrossPaise).toBe(40000);
    expect(b.lifetimeNetPayoutPaise).toBe(28000);
    expect(b.outstandingGrossPaise).toBe(40000);
    expect(b.outstandingNetPayoutPaise).toBe(28000);
    expect(b.outstandingCount).toBe(1);
  });

  it("returns coaches with zero stats when there are no reviews yet", async () => {
    const res = await request(appAsAdmin)
      .get(`/api/coach-marketplace/admin/coaches`)
      .query({ organizationId: orgId });
    expect(res.status).toBe(200);
    const coaches = res.body.coaches as Array<{ proId: number; lifetimeGrossPaise: number; outstandingGrossPaise: number }>;
    expect(coaches.length).toBeGreaterThanOrEqual(2);
    for (const c of coaches) {
      expect(c.lifetimeGrossPaise).toBe(0);
      expect(c.outstandingGrossPaise).toBe(0);
    }
  });

  // Task #1221 — surface saved payout-verification status inline so admins
  // can see at a glance which coaches need attention.
  it("includes payout method + verification status, verifiedAt, and failure reason per coach", async () => {
    const verifiedAt = new Date("2026-01-15T10:00:00.000Z");
    // Coach A: a healthy verified UPI account.
    await db.update(coachMarketplaceProfilesTable)
      .set({
        payoutAccountId: "fa_test_verified_A",
        payoutMethod: "upi",
        payoutVerifiedAt: verifiedAt,
        payoutVerificationStatus: "verified",
        payoutVerificationFailureReason: null,
      })
      .where(eq(coachMarketplaceProfilesTable.proId, coachAProId));

    try {
      const res = await request(appAsAdmin)
        .get(`/api/coach-marketplace/admin/coaches`)
        .query({ organizationId: orgId });
      expect(res.status, res.text).toBe(200);
      const coaches = res.body.coaches as Array<{
        proId: number;
        payoutMethod: string | null;
        payoutVerificationStatus: string | null;
        payoutVerifiedAt: string | null;
        payoutVerificationFailureReason: string | null;
      }>;
      const a = coaches.find(c => c.proId === coachAProId)!;
      const b = coaches.find(c => c.proId === coachBProId)!;
      expect(a.payoutMethod).toBe("upi");
      expect(a.payoutVerificationStatus).toBe("verified");
      expect(a.payoutVerifiedAt).toBe(verifiedAt.toISOString());
      expect(a.payoutVerificationFailureReason).toBeNull();
      // Coach B has no marketplace profile yet → all four fields surface as null.
      expect(b.payoutMethod).toBeNull();
      expect(b.payoutVerificationStatus).toBeNull();
      expect(b.payoutVerifiedAt).toBeNull();
      expect(b.payoutVerificationFailureReason).toBeNull();
    } finally {
      await db.update(coachMarketplaceProfilesTable)
        .set({
          payoutAccountId: null,
          payoutMethod: null,
          payoutVerifiedAt: null,
          payoutVerificationStatus: null,
          payoutVerificationFailureReason: null,
        })
        .where(eq(coachMarketplaceProfilesTable.proId, coachAProId));
    }
  });

  it("surfaces needs_attention status with the failure reason when re-verification has failed", async () => {
    await db.update(coachMarketplaceProfilesTable)
      .set({
        payoutAccountId: "fa_test_failed_A",
        payoutMethod: "bank_account",
        payoutVerifiedAt: new Date("2025-12-01T00:00:00.000Z"),
        payoutVerificationStatus: "needs_attention",
        payoutVerificationFailureReason: "Bank account closed",
      })
      .where(eq(coachMarketplaceProfilesTable.proId, coachAProId));

    try {
      const res = await request(appAsAdmin)
        .get(`/api/coach-marketplace/admin/coaches`)
        .query({ organizationId: orgId });
      expect(res.status).toBe(200);
      const a = (res.body.coaches as Array<{ proId: number; payoutVerificationStatus: string | null; payoutVerificationFailureReason: string | null; payoutMethod: string | null }>)
        .find(c => c.proId === coachAProId)!;
      expect(a.payoutMethod).toBe("bank_account");
      expect(a.payoutVerificationStatus).toBe("needs_attention");
      expect(a.payoutVerificationFailureReason).toBe("Bank account closed");
    } finally {
      await db.update(coachMarketplaceProfilesTable)
        .set({
          payoutAccountId: null,
          payoutMethod: null,
          payoutVerifiedAt: null,
          payoutVerificationStatus: null,
          payoutVerificationFailureReason: null,
        })
        .where(eq(coachMarketplaceProfilesTable.proId, coachAProId));
    }
  });
});

// ─── POST /swing-reviews/admin/payouts/run ────────────────────────────

describe("POST /swing-reviews/admin/payouts/run", () => {
  it("returns 403 for non-admin caller", async () => {
    const res = await request(appAsNonAdmin)
      .post(`/api/swing-reviews/admin/payouts/run`)
      .send({ organizationId: orgId });
    expect(res.status).toBe(403);
  });

  it("returns an empty result when no delivered+unpaid requests exist", async () => {
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/run`)
      .send({ organizationId: orgId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.payouts).toEqual([]);
    expect(res.body.message).toMatch(/no eligible/i);
  });

  it("aggregates delivered+unpaid requests into one payout per coach", async () => {
    await seedDeliveredReview(coachAProId, coachAVideoId, 50000);
    await seedDeliveredReview(coachAProId, coachAVideoId, 30000);
    await seedDeliveredReview(coachBProId, coachBVideoId, 40000);

    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/run`)
      .send({ organizationId: orgId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.count).toBe(2);

    const payouts = res.body.payouts as Array<{
      payoutId: number; proId: number; netPayoutPaise: number;
      status: string; error?: string;
    }>;
    const aPayout = payouts.find(p => p.proId === coachAProId)!;
    const bPayout = payouts.find(p => p.proId === coachBProId)!;
    expect(aPayout).toBeDefined();
    expect(bPayout).toBeDefined();

    // 80% of (50000+30000) = 64000
    expect(aPayout.netPayoutPaise).toBe(64000);
    // 70% of 40000 = 28000
    expect(bPayout.netPayoutPaise).toBe(28000);

    // No payout account on file → status pending with a failureReason recorded.
    expect(aPayout.status).toBe("pending");
    expect(bPayout.status).toBe("pending");
    expect(res.body.summary.pending).toBe(2);

    // DB rows reflect the same numbers and the originating reviews are now
    // attached to their payout via payoutId.
    const dbPayouts = await db.select().from(coachPayoutsTable)
      .where(eq(coachPayoutsTable.organizationId, orgId));
    expect(dbPayouts.length).toBe(2);
    const dbA = dbPayouts.find(p => p.proId === coachAProId)!;
    expect(dbA.grossPaise).toBe(80000);
    expect(dbA.netPayoutPaise).toBe(64000);
    expect(dbA.platformFeePaise).toBe(80000 - 64000);
    expect(dbA.failureReason).toMatch(/payout account/i);

    const stillUnpaid = await db.select().from(swingReviewRequestsTable)
      .where(eq(swingReviewRequestsTable.organizationId, orgId));
    for (const r of stillUnpaid) expect(r.payoutId).not.toBeNull();
  });
});

// ─── POST /swing-reviews/admin/payouts/:id/mark-paid ──────────────────

describe("POST /swing-reviews/admin/payouts/:id/mark-paid", () => {
  it("marks a pending payout as paid and stores the reference", async () => {
    await seedDeliveredReview(coachAProId, coachAVideoId, 50000);
    const runRes = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/run`)
      .send({ organizationId: orgId });
    expect(runRes.status).toBe(200);
    const payoutId: number = runRes.body.payouts[0].payoutId;

    const markRes = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payoutId}/mark-paid`)
      .send({ reference: "UPI-TXN-1234", notes: "settled out-of-band" });
    expect(markRes.status, markRes.text).toBe(200);
    expect(markRes.body.success).toBe(true);

    const [row] = await db.select().from(coachPayoutsTable)
      .where(eq(coachPayoutsTable.id, payoutId));
    expect(row.status).toBe("paid");
    expect(row.payoutReference).toBe("UPI-TXN-1234");
    expect(row.notes).toBe("settled out-of-band");
    expect(row.paidAt).not.toBeNull();
  });

  it("returns 400 when reference is missing", async () => {
    await seedDeliveredReview(coachAProId, coachAVideoId, 50000);
    const runRes = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/run`)
      .send({ organizationId: orgId });
    const payoutId: number = runRes.body.payouts[0].payoutId;

    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payoutId}/mark-paid`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown payout id", async () => {
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/9999999/mark-paid`)
      .send({ reference: "ref" });
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin caller", async () => {
    await seedDeliveredReview(coachAProId, coachAVideoId, 50000);
    const runRes = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/run`)
      .send({ organizationId: orgId });
    const payoutId: number = runRes.body.payouts[0].payoutId;

    const res = await request(appAsNonAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payoutId}/mark-paid`)
      .send({ reference: "x" });
    expect(res.status).toBe(403);
  });
});

// ─── POST /swing-reviews/admin/payouts/:id/retry ──────────────────────

describe("POST /swing-reviews/admin/payouts/:id/retry", () => {
  beforeEach(() => {
    createRazorpayPayoutMock.mockReset();
  });

  async function seedPendingPayout(opts: { status?: "pending" | "failed" | "paid" } = {}) {
    const [row] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId,
      organizationId: orgId,
      periodStart: new Date(),
      periodEnd: new Date(),
      grossPaise: 50000,
      platformFeePaise: 10000,
      netPayoutPaise: 40000,
      status: opts.status ?? "pending",
      failureReason: opts.status === "paid" ? null : "Coach has not registered a payout account",
    }).returning();
    return row;
  }

  it("returns 403 for non-admin caller", async () => {
    const payout = await seedPendingPayout();
    const res = await request(appAsNonAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/retry`)
      .send({});
    expect(res.status).toBe(403);
    expect(createRazorpayPayoutMock).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown payout id", async () => {
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/9999999/retry`)
      .send({});
    expect(res.status).toBe(404);
    expect(createRazorpayPayoutMock).not.toHaveBeenCalled();
  });

  it("returns 400 when the payout is in a terminal state (paid)", async () => {
    const payout = await seedPendingPayout({ status: "paid" });
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/retry`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot retry/i);
    expect(createRazorpayPayoutMock).not.toHaveBeenCalled();
  });

  // Both 'pending' (never-attempted, e.g. coach had no payout account at run time)
  // and 'failed' (RazorpayX rejected, e.g. amount_exceeds_balance) are retryable
  // — the route allow-lists exactly these two statuses.
  for (const startingStatus of ["pending", "failed"] as const) {
    it(`flips a ${startingStatus} payout to processing once the coach has a payout account`, async () => {
      // Simulate the coach having just registered a UPI payout account.
      await db.update(coachMarketplaceProfilesTable)
        .set({ payoutAccountId: "fa_test_123", payoutMethod: "upi" })
        .where(eq(coachMarketplaceProfilesTable.proId, coachAProId));

      try {
        const payout = await seedPendingPayout({ status: startingStatus });
        createRazorpayPayoutMock.mockResolvedValueOnce({
          id: `pout_test_${startingStatus}`,
          status: "processing",
          amount: 40000,
          fund_account_id: "fa_test_123",
          mode: "UPI",
        });

        const res = await request(appAsAdmin)
          .post(`/api/swing-reviews/admin/payouts/${payout.id}/retry`)
          .send({});
        expect(res.status, res.text).toBe(200);
        expect(res.body.status).toBe("processing");
        expect(res.body.razorpayPayoutId).toBe(`pout_test_${startingStatus}`);
        expect(createRazorpayPayoutMock).toHaveBeenCalledTimes(1);
        const callArgs = createRazorpayPayoutMock.mock.calls[0][0];
        expect(callArgs.fund_account_id).toBe("fa_test_123");
        expect(callArgs.amount).toBe(40000);
        expect(callArgs.mode).toBe("UPI");

        const [row] = await db.select().from(coachPayoutsTable)
          .where(eq(coachPayoutsTable.id, payout.id));
        expect(row.status).toBe("processing");
        expect(row.payoutReference).toBe(`pout_test_${startingStatus}`);
        expect(row.payoutMode).toBe("UPI");
        expect(row.failureReason).toBeNull();
        expect(row.attemptedAt).not.toBeNull();
      } finally {
        // Reset the profile so other tests don't accidentally trigger a real call.
        await db.update(coachMarketplaceProfilesTable)
          .set({ payoutAccountId: null, payoutMethod: null })
          .where(eq(coachMarketplaceProfilesTable.proId, coachAProId));
      }
    });
  }
});

// ─── POST /swing-reviews/admin/payouts/:id/resend-notification ──────────
// Task #1129 — admin-facing button that resets the
// `coach_payout_notification_attempts` row so the retry cron picks it up.

describe("POST /swing-reviews/admin/payouts/:id/resend-notification", () => {
  async function seedPaidPayoutWithAttempt(opts: {
    pushStatus?: string | null;
    pushAttempts?: number;
    pushExhausted?: boolean;
    smsStatus?: string | null;
    smsAttempts?: number;
    smsExhausted?: boolean;
  }) {
    const now = new Date();
    const [payout] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId,
      organizationId: orgId,
      periodStart: now,
      periodEnd: now,
      grossPaise: 50000,
      platformFeePaise: 10000,
      netPayoutPaise: 40000,
      status: "paid",
      payoutReference: "REF-1129",
      paidAt: now,
      paidNotifiedAt: now,
    }).returning();
    const [attempt] = await db.insert(coachPayoutNotificationAttemptsTable).values({
      payoutId: payout.id,
      proId: coachAProId,
      organizationId: orgId,
      coachUserId: coachAUserId,
      amountPaise: 40000,
      reference: "REF-1129",
      pushStatus: opts.pushStatus ?? null,
      pushAttempts: opts.pushAttempts ?? 0,
      lastPushError: opts.pushStatus === "failed" ? "boom" : null,
      pushRetryExhaustedAt: opts.pushExhausted ? now : null,
      smsStatus: opts.smsStatus ?? null,
      smsAttempts: opts.smsAttempts ?? 0,
      lastSmsError: opts.smsStatus === "failed" ? "boom" : null,
      smsRetryExhaustedAt: opts.smsExhausted ? now : null,
    }).returning();
    return { payout, attempt };
  }

  it("resets a cap-exhausted push attempt so the retry cron picks it up again", async () => {
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      smsStatus: "sent", smsAttempts: 1,
    });

    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/resend-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ success: true, resetPush: true, resetSms: false });

    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.pushStatus).toBe("failed");
    expect(row.pushAttempts).toBe(0);
    expect(row.lastPushError).toBeNull();
    expect(row.pushRetryExhaustedAt).toBeNull();
    // SMS was already 'sent' — must be untouched.
    expect(row.smsStatus).toBe("sent");
    expect(row.smsAttempts).toBe(1);
  });

  it("resets a 'skipped' SMS (provider unconfigured) when admin retries", async () => {
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "sent", pushAttempts: 1,
      smsStatus: "skipped", smsAttempts: 0,
    });

    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/resend-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ success: true, resetPush: false, resetSms: true });

    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.smsStatus).toBe("failed");
    expect(row.smsAttempts).toBe(0);
    expect(row.smsRetryExhaustedAt).toBeNull();
  });

  it("returns 400 when both channels are already delivered (nothing to resend)", async () => {
    const { payout } = await seedPaidPayoutWithAttempt({
      pushStatus: "sent", pushAttempts: 1,
      smsStatus: "sent", smsAttempts: 1,
    });
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/resend-notification`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing to resend/i);
  });

  it("returns 400 when the payout has no notification attempt row yet", async () => {
    const now = new Date();
    const [payout] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId, organizationId: orgId,
      periodStart: now, periodEnd: now,
      grossPaise: 50000, platformFeePaise: 10000, netPayoutPaise: 40000,
      status: "pending",
    }).returning();
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/resend-notification`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no notification attempt/i);
  });

  it("returns 404 for an unknown payout id", async () => {
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/9999999/resend-notification`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 403 for non-admin caller", async () => {
    const { payout } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
    });
    const res = await request(appAsNonAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/resend-notification`)
      .send({});
    expect(res.status).toBe(403);
  });
});

// ─── POST /swing-reviews/coach/payouts/:id/retry-notification ────────────
// Task #1543 — coach-side "Try again" mirrors admin Resend (Task #1129)
// but enforces ownership (payout.proId === pro.id) and a per-payout
// cooldown stored in `coachRetryRequestedAt`.

describe("POST /swing-reviews/coach/payouts/:id/retry-notification", () => {
  let coachAApp: ReturnType<typeof createTestApp>;
  let coachBApp: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    const coachAUser: TestUser = {
      id: coachAUserId, username: `coach_admin_coachA_${stamp}`,
      displayName: "Coach A", role: "player", organizationId: orgId,
    };
    const coachBUser: TestUser = {
      id: coachBUserId, username: `coach_admin_coachB_${stamp}`,
      displayName: "Coach B", role: "player", organizationId: orgId,
    };
    coachAApp = createTestApp(coachAUser);
    coachBApp = createTestApp(coachBUser);
  });

  async function seedPaidPayoutWithAttempt(opts: {
    proId?: number;
    pushStatus?: string | null;
    pushAttempts?: number;
    pushExhausted?: boolean;
    smsStatus?: string | null;
    smsAttempts?: number;
    smsExhausted?: boolean;
    coachRetryRequestedAt?: Date | null;
    // Task #1914 — pre-set the coach-retry counter / admin-alert dedup
    // marker so tests can drive the "coach is hammering retry" admin
    // alert path without simulating N real presses.
    coachRetryCount?: number;
    coachRetryAdminNotifiedAt?: Date | null;
  }) {
    const proId = opts.proId ?? coachAProId;
    const now = new Date();
    const [payout] = await db.insert(coachPayoutsTable).values({
      proId,
      organizationId: orgId,
      periodStart: now,
      periodEnd: now,
      grossPaise: 50000,
      platformFeePaise: 10000,
      netPayoutPaise: 40000,
      status: "paid",
      payoutReference: "REF-1543",
      paidAt: now,
      paidNotifiedAt: now,
    }).returning();
    const [attempt] = await db.insert(coachPayoutNotificationAttemptsTable).values({
      payoutId: payout.id,
      proId,
      organizationId: orgId,
      coachUserId: proId === coachAProId ? coachAUserId : coachBUserId,
      amountPaise: 40000,
      reference: "REF-1543",
      pushStatus: opts.pushStatus ?? null,
      pushAttempts: opts.pushAttempts ?? 0,
      lastPushError: opts.pushStatus === "failed" ? "boom" : null,
      pushRetryExhaustedAt: opts.pushExhausted ? now : null,
      smsStatus: opts.smsStatus ?? null,
      smsAttempts: opts.smsAttempts ?? 0,
      lastSmsError: opts.smsStatus === "failed" ? "boom" : null,
      smsRetryExhaustedAt: opts.smsExhausted ? now : null,
      coachRetryRequestedAt: opts.coachRetryRequestedAt ?? null,
      coachRetryCount: opts.coachRetryCount ?? 0,
      coachRetryAdminNotifiedAt: opts.coachRetryAdminNotifiedAt ?? null,
    }).returning();
    return { payout, attempt };
  }

  it("requires authentication", async () => {
    const { payout } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
    });
    const res = await request(appAnonymous)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("returns 403 if the caller isn't a registered coach", async () => {
    const { payout } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
    });
    const res = await request(appAsNonAdmin)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a registered coach/i);
  });

  it("returns 403 when coach B tries to retry coach A's payout", async () => {
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      proId: coachAProId,
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
    });
    const res = await request(coachBApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status).toBe(403);
    // Side effect check: coach B's failed attempt must NOT have rewritten the row.
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.pushAttempts).toBe(5);
    expect(row.coachRetryRequestedAt).toBeNull();
  });

  it("returns 404 for an unknown payout id", async () => {
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/9999999/retry-notification`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("resets a cap-exhausted push attempt and stamps coachRetryRequestedAt", async () => {
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      smsStatus: "sent", smsAttempts: 1,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ success: true, resetPush: true, resetSms: false });
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.pushStatus).toBe("failed");
    expect(row.pushAttempts).toBe(0);
    expect(row.lastPushError).toBeNull();
    expect(row.pushRetryExhaustedAt).toBeNull();
    expect(row.smsStatus).toBe("sent");
    expect(row.coachRetryRequestedAt).not.toBeNull();
  });

  it("resets a 'skipped' SMS when the coach retries", async () => {
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "sent", pushAttempts: 1,
      smsStatus: "skipped", smsAttempts: 0,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ success: true, resetPush: false, resetSms: true });
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.smsStatus).toBe("failed");
    expect(row.smsAttempts).toBe(0);
    expect(row.smsRetryExhaustedAt).toBeNull();
  });

  it("returns 400 when both channels are already delivered (nothing to resend)", async () => {
    const { payout } = await seedPaidPayoutWithAttempt({
      pushStatus: "sent", pushAttempts: 1,
      smsStatus: "sent", smsAttempts: 1,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing to resend/i);
  });

  it("returns 400 when the payout has no notification attempt row yet", async () => {
    const now = new Date();
    const [payout] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId, organizationId: orgId,
      periodStart: now, periodEnd: now,
      grossPaise: 50000, platformFeePaise: 10000, netPayoutPaise: 40000,
      status: "pending",
    }).returning();
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no notification attempt/i);
  });

  it("returns 429 when the coach retries again within the cooldown window", async () => {
    // Stamp a recent coachRetryRequestedAt so the cooldown branch fires.
    const recentlyRequested = new Date(Date.now() - 30 * 1000); // 30s ago
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      coachRetryRequestedAt: recentlyRequested,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/wait/i);
    expect(typeof res.body.retryAfterSec).toBe("number");
    expect(res.body.retryAfterSec).toBeGreaterThan(0);
    // Channels must NOT have been reset.
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.pushAttempts).toBe(5);
    expect(row.pushRetryExhaustedAt).not.toBeNull();
    // The pre-existing cooldown stamp must be preserved (not overwritten).
    expect(row.coachRetryRequestedAt?.getTime()).toBe(recentlyRequested.getTime());
  });

  it("allows a fresh retry once the cooldown has elapsed", async () => {
    // Stamp a coachRetryRequestedAt comfortably outside the 5-minute window.
    const oldRequest = new Date(Date.now() - 10 * 60 * 1000);
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      coachRetryRequestedAt: oldRequest,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.resetPush).toBe(true);
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.pushAttempts).toBe(0);
    // Cooldown stamp moved forward.
    expect(row.coachRetryRequestedAt?.getTime()).toBeGreaterThan(oldRequest.getTime());
  });

  // ─── Task #1914 — repeat-retry counter + admin alert ─────────────────
  // The coach-side "Try again" route increments `coachRetryCount` on every
  // accepted press and pages org admins exactly once when the count crosses
  // `COACH_PAYOUT_REPEAT_RETRY_ADMIN_THRESHOLD`. The admin Resend path
  // resets both the counter and the dedup marker so a fresh stuck pattern
  // after the admin's fix can re-fire the alert.

  it("increments coachRetryCount on each accepted press and returns it", async () => {
    // Seed at count=1 so the next accepted press takes us to 2 (the hint
    // threshold) without crossing the admin threshold yet.
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      coachRetryCount: 1,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ success: true, coachRetryCount: 2 });
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.coachRetryCount).toBe(2);
    // Below the admin threshold — dedup marker must still be NULL so a
    // future press at count=3 is allowed to fire the alert.
    expect(row.coachRetryAdminNotifiedAt).toBeNull();
  });

  it("stamps coachRetryAdminNotifiedAt once the admin threshold is crossed", async () => {
    // Pre-seed at count=2 so this press is the third (= admin threshold).
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      coachRetryCount: 2,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.coachRetryCount).toBe(3);
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.coachRetryCount).toBe(3);
    // Admin alert helper must have stamped the dedup marker exactly once.
    expect(row.coachRetryAdminNotifiedAt).not.toBeNull();
  });

  it("does not re-stamp coachRetryAdminNotifiedAt on a 4th press (dedup)", async () => {
    // Already past threshold and already alerted — the dedup marker must
    // be preserved and not bumped to a fresh timestamp by the next press.
    const previouslyNotified = new Date(Date.now() - 60 * 1000);
    const oldCooldown = new Date(Date.now() - 10 * 60 * 1000);
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      coachRetryCount: 3,
      coachRetryAdminNotifiedAt: previouslyNotified,
      coachRetryRequestedAt: oldCooldown,
    });
    const res = await request(coachAApp)
      .post(`/api/swing-reviews/coach/payouts/${payout.id}/retry-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.coachRetryCount).toBe(4);
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.coachRetryCount).toBe(4);
    // Same exact timestamp — the helper short-circuits when the marker is
    // already set, so the existing value must NOT be overwritten.
    expect(row.coachRetryAdminNotifiedAt?.getTime()).toBe(previouslyNotified.getTime());
  });

  it("admin Resend resets coachRetryCount and clears coachRetryAdminNotifiedAt", async () => {
    // Mid-incident state: coach has been hammering retry, admin alert was
    // already fired, push is stuck. Admin presses Resend after fixing the
    // underlying contact problem — both repeat-retry trackers must clear.
    const { payout, attempt } = await seedPaidPayoutWithAttempt({
      pushStatus: "failed", pushAttempts: 5, pushExhausted: true,
      coachRetryCount: 4,
      coachRetryAdminNotifiedAt: new Date(),
    });
    const res = await request(appAsAdmin)
      .post(`/api/swing-reviews/admin/payouts/${payout.id}/resend-notification`)
      .send({});
    expect(res.status, res.text).toBe(200);
    const [row] = await db.select().from(coachPayoutNotificationAttemptsTable)
      .where(eq(coachPayoutNotificationAttemptsTable.id, attempt.id));
    expect(row.coachRetryCount).toBe(0);
    expect(row.coachRetryAdminNotifiedAt).toBeNull();
    // Sanity: the existing push reset behaviour from Task #1129 still works.
    expect(row.pushAttempts).toBe(0);
    expect(row.pushRetryExhaustedAt).toBeNull();
  });
});

// ─── GET /swing-reviews/admin/payouts (notification surface — Task #1129) ──

describe("GET /swing-reviews/admin/payouts notification join", () => {
  it("returns the per-payout push/SMS notification row when present", async () => {
    const now = new Date();
    const [payout] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId, organizationId: orgId,
      periodStart: now, periodEnd: now,
      grossPaise: 50000, platformFeePaise: 10000, netPayoutPaise: 40000,
      status: "paid", payoutReference: "REF-LIST", paidAt: now, paidNotifiedAt: now,
    }).returning();
    await db.insert(coachPayoutNotificationAttemptsTable).values({
      payoutId: payout.id,
      proId: coachAProId,
      organizationId: orgId,
      coachUserId: coachAUserId,
      amountPaise: 40000,
      reference: "REF-LIST",
      pushStatus: "failed",
      pushAttempts: 5,
      lastPushError: "DeviceNotRegistered",
      pushRetryExhaustedAt: now,
      smsStatus: "skipped",
      smsAttempts: 0,
    });

    const res = await request(appAsAdmin)
      .get(`/api/swing-reviews/admin/payouts?organizationId=${orgId}`);
    expect(res.status).toBe(200);
    const row = res.body.payouts.find((r: any) => r.payout.id === payout.id);
    expect(row).toBeTruthy();
    expect(row.notification).toMatchObject({
      pushStatus: "failed",
      pushAttempts: 5,
      smsStatus: "skipped",
    });
    expect(row.notification.pushRetryExhaustedAt).not.toBeNull();
  });

  // Task #1919 — admins triaging a coach who claims they never got their
  // payout notification need the same masked recipient snapshot the coach
  // sees in `coach-workspace.tsx`, so they can tell a stale-on-file
  // contact from a provider outage without bouncing into the database.
  // The endpoint already selects `coachPayoutNotificationAttemptsTable`
  // whole — this test pins that contract so a future narrowing of the
  // SELECT can't silently drop the columns the admin UI now renders.
  it("hands the masked pushTargetLabel and smsTargetMasked snapshots through to admins", async () => {
    const now = new Date();
    const [payout] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId, organizationId: orgId,
      periodStart: now, periodEnd: now,
      grossPaise: 50000, platformFeePaise: 10000, netPayoutPaise: 40000,
      status: "paid", payoutReference: "REF-MASK", paidAt: now, paidNotifiedAt: now,
    }).returning();
    await db.insert(coachPayoutNotificationAttemptsTable).values({
      payoutId: payout.id,
      proId: coachAProId,
      organizationId: orgId,
      coachUserId: coachAUserId,
      amountPaise: 40000,
      reference: "REF-MASK",
      pushStatus: "failed",
      pushAttempts: 5,
      lastPushError: "DeviceNotRegistered",
      pushRetryExhaustedAt: now,
      pushTargetLabel: "iPhone 14",
      smsStatus: "failed",
      smsAttempts: 5,
      lastSmsError: "carrier rejected",
      smsRetryExhaustedAt: now,
      smsTargetMasked: "+91 ●●●●●● 4321",
    });

    const res = await request(appAsAdmin)
      .get(`/api/swing-reviews/admin/payouts?organizationId=${orgId}`);
    expect(res.status).toBe(200);
    const row = res.body.payouts.find((r: any) => r.payout.id === payout.id);
    expect(row).toBeTruthy();
    expect(row.notification).toMatchObject({
      pushTargetLabel: "iPhone 14",
      smsTargetMasked: "+91 ●●●●●● 4321",
    });
  });

  it("returns notification: null for a payout with no attempt row yet", async () => {
    const now = new Date();
    const [payout] = await db.insert(coachPayoutsTable).values({
      proId: coachAProId, organizationId: orgId,
      periodStart: now, periodEnd: now,
      grossPaise: 50000, platformFeePaise: 10000, netPayoutPaise: 40000,
      status: "pending",
    }).returning();

    const res = await request(appAsAdmin)
      .get(`/api/swing-reviews/admin/payouts?organizationId=${orgId}`);
    expect(res.status).toBe(200);
    const row = res.body.payouts.find((r: any) => r.payout.id === payout.id);
    expect(row).toBeTruthy();
    expect(row.notification).toBeNull();
  });
});
