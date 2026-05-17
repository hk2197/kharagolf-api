/**
 * Staff Commission Tracking API — Task #105
 * Base: /organizations/:orgId/commissions
 *
 * Commission Rules (admin only)
 * GET    /rules                             List commission rules for org
 * POST   /rules                             Create a new commission rule
 * PATCH  /rules/:ruleId                     Update a commission rule
 * DELETE /rules/:ruleId                     Delete (deactivate) a rule
 *
 * Staff self-service
 * GET    /my-summary                        Authenticated staff member's own summary
 *
 * Attributions (admin)
 * GET    /attributions                      List attributions (filterable by staff, date)
 *
 * Adjustments (admin)
 * POST   /adjustments                       Add a manual adjustment for a staff member
 * GET    /adjustments                       List adjustments
 *
 * Payouts (admin)
 * GET    /payouts                           List payouts
 * POST   /payouts/generate                  Generate payout(s) for a pay period
 * PATCH  /payouts/:payoutId/approve         Approve a payout
 * PATCH  /payouts/:payoutId/mark-paid       Mark a payout as paid
 * PATCH  /payouts/:payoutId/cancel          Cancel a payout
 * GET    /payouts/:payoutId/report          CSV report for a payout
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  commissionRulesTable,
  salesAttributionsTable,
  commissionAdjustmentsTable,
  commissionPayoutsTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, sum, count, sql, isNull, inArray } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser { id: number; role?: string; organizationId?: number | null; displayName?: string; email?: string }

function getUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
}

async function isOrgMember(userId: number, orgId: number): Promise<boolean> {
  const [m] = await db.select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, userId)));
  return !!m;
}

function parseOrgId(req: Request): number {
  return parseInt(String((req.params as Record<string, string>).orgId));
}

// ─── COMMISSION RULES ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/commissions/rules
router.get("/rules", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { staffUserId, source, activeOnly } = req.query;

  const conditions = [eq(commissionRulesTable.organizationId, orgId)];
  if (staffUserId) conditions.push(eq(commissionRulesTable.staffUserId, parseInt(String(staffUserId))));
  if (source) conditions.push(eq(commissionRulesTable.source, String(source) as "pos" | "lesson"));
  if (activeOnly === "true") conditions.push(eq(commissionRulesTable.isActive, true));

  const rules = await db
    .select({
      id: commissionRulesTable.id,
      staffUserId: commissionRulesTable.staffUserId,
      staffName: appUsersTable.displayName,
      staffEmail: appUsersTable.email,
      category: commissionRulesTable.category,
      commissionType: commissionRulesTable.commissionType,
      rate: commissionRulesTable.rate,
      source: commissionRulesTable.source,
      tierThresholdAmount: commissionRulesTable.tierThresholdAmount,
      isActive: commissionRulesTable.isActive,
      createdAt: commissionRulesTable.createdAt,
    })
    .from(commissionRulesTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, commissionRulesTable.staffUserId))
    .where(and(...conditions))
    .orderBy(appUsersTable.displayName, commissionRulesTable.source);

  res.json(rules);
});

// POST /organizations/:orgId/commissions/rules
router.post("/rules", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { staffUserId, category, commissionType, rate, source, tierThresholdAmount } = req.body;

  if (!staffUserId || !source || rate === undefined || rate === null) {
    res.status(400).json({ error: "staffUserId, source, and rate are required." });
    return;
  }
  if (!["percentage", "flat_per_sale"].includes(commissionType ?? "percentage")) {
    res.status(400).json({ error: "commissionType must be 'percentage' or 'flat_per_sale'." });
    return;
  }
  if (!["pos", "lesson"].includes(source)) {
    res.status(400).json({ error: "source must be 'pos' or 'lesson'." });
    return;
  }

  const [rule] = await db.insert(commissionRulesTable).values({
    organizationId: orgId,
    staffUserId: parseInt(String(staffUserId)),
    category: category ?? null,
    commissionType: (commissionType ?? "percentage") as "percentage" | "flat_per_sale",
    rate: String(parseFloat(String(rate))),
    source: source as "pos" | "lesson",
    tierThresholdAmount: tierThresholdAmount ? String(parseFloat(String(tierThresholdAmount))) : null,
    isActive: true,
  }).returning();

  res.status(201).json(rule);
});

// PATCH /organizations/:orgId/commissions/rules/:ruleId
router.patch("/rules/:ruleId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));
  const [existing] = await db.select().from(commissionRulesTable)
    .where(and(eq(commissionRulesTable.id, ruleId), eq(commissionRulesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Rule not found." }); return; } }

  const { category, commissionType, rate, source, tierThresholdAmount, isActive } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (category !== undefined) updates.category = category;
  if (commissionType !== undefined) updates.commissionType = commissionType;
  if (rate !== undefined) updates.rate = String(parseFloat(String(rate)));
  if (source !== undefined) updates.source = source;
  if (tierThresholdAmount !== undefined) updates.tierThresholdAmount = tierThresholdAmount ? String(parseFloat(String(tierThresholdAmount))) : null;
  if (isActive !== undefined) updates.isActive = isActive;

  const [updated] = await db.update(commissionRulesTable).set(updates).where(eq(commissionRulesTable.id, ruleId)).returning();
  res.json(updated);
});

// DELETE /organizations/:orgId/commissions/rules/:ruleId
router.delete("/rules/:ruleId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));
  const [existing] = await db.select().from(commissionRulesTable)
    .where(and(eq(commissionRulesTable.id, ruleId), eq(commissionRulesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Rule not found." }); return; } }

  await db.update(commissionRulesTable).set({ isActive: false, updatedAt: new Date() }).where(eq(commissionRulesTable.id, ruleId));
  res.json({ ok: true });
});

// ─── STAFF LIST (for admin dropdowns) ─────────────────────────────────────────

// GET /organizations/:orgId/commissions/staff
router.get("/staff", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const members = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      email: appUsersTable.email,
      role: orgMembershipsTable.role,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      sql`${orgMembershipsTable.role} NOT IN ('player', 'spectator')`,
    ))
    .orderBy(appUsersTable.displayName);

  res.json(members);
});

// ─── ATTRIBUTIONS ─────────────────────────────────────────────────────────────

// GET /organizations/:orgId/commissions/attributions
router.get("/attributions", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { staffUserId, from, to, source, unassigned } = req.query;

  const conditions = [eq(salesAttributionsTable.organizationId, orgId)];
  if (staffUserId) conditions.push(eq(salesAttributionsTable.staffUserId, parseInt(String(staffUserId))));
  if (source) conditions.push(eq(salesAttributionsTable.source, String(source) as "pos" | "lesson"));
  if (from) conditions.push(gte(salesAttributionsTable.attributedAt, new Date(String(from))));
  if (to) conditions.push(lte(salesAttributionsTable.attributedAt, new Date(String(to))));
  if (unassigned === "true") conditions.push(isNull(salesAttributionsTable.payoutId));

  const attributions = await db
    .select({
      id: salesAttributionsTable.id,
      staffUserId: salesAttributionsTable.staffUserId,
      staffName: appUsersTable.displayName,
      source: salesAttributionsTable.source,
      posTransactionId: salesAttributionsTable.posTransactionId,
      lessonBookingId: salesAttributionsTable.lessonBookingId,
      saleAmount: salesAttributionsTable.saleAmount,
      category: salesAttributionsTable.category,
      commissionAmount: salesAttributionsTable.commissionAmount,
      currency: salesAttributionsTable.currency,
      payoutId: salesAttributionsTable.payoutId,
      attributedAt: salesAttributionsTable.attributedAt,
    })
    .from(salesAttributionsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, salesAttributionsTable.staffUserId))
    .where(and(...conditions))
    .orderBy(desc(salesAttributionsTable.attributedAt))
    .limit(500);

  res.json(attributions);
});

// ─── ADJUSTMENTS ──────────────────────────────────────────────────────────────

// GET /organizations/:orgId/commissions/adjustments
router.get("/adjustments", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { staffUserId } = req.query;
  const conditions = [eq(commissionAdjustmentsTable.organizationId, orgId)];
  if (staffUserId) conditions.push(eq(commissionAdjustmentsTable.staffUserId, parseInt(String(staffUserId))));

  const adjustments = await db
    .select({
      id: commissionAdjustmentsTable.id,
      staffUserId: commissionAdjustmentsTable.staffUserId,
      staffName: appUsersTable.displayName,
      amount: commissionAdjustmentsTable.amount,
      currency: commissionAdjustmentsTable.currency,
      reason: commissionAdjustmentsTable.reason,
      payoutId: commissionAdjustmentsTable.payoutId,
      createdAt: commissionAdjustmentsTable.createdAt,
    })
    .from(commissionAdjustmentsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, commissionAdjustmentsTable.staffUserId))
    .where(and(...conditions))
    .orderBy(desc(commissionAdjustmentsTable.createdAt));

  res.json(adjustments);
});

// POST /organizations/:orgId/commissions/adjustments
router.post("/adjustments", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const adminUser = getUser(req);
  const { staffUserId, amount, reason, currency } = req.body;

  if (!staffUserId || amount === undefined || !reason) {
    res.status(400).json({ error: "staffUserId, amount, and reason are required." });
    return;
  }

  const [adj] = await db.insert(commissionAdjustmentsTable).values({
    organizationId: orgId,
    staffUserId: parseInt(String(staffUserId)),
    amount: String(parseFloat(String(amount))),
    currency: currency ?? "INR",
    reason: String(reason),
    adjustedByUserId: adminUser?.id ?? null,
  }).returning();

  res.status(201).json(adj);
});

// ─── SELF-SERVICE (any authenticated org member) ───────────────────────────────

// GET /organizations/:orgId/commissions/my-summary?from=&to=
router.get("/my-summary", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const orgId = parseOrgId(req);
  const user = getUser(req)!;

  // Admin can view any; staff can only view their own
  const isAdmin = user.role === "super_admin" ||
    ((user.role === "org_admin" || user.role === "tournament_director") && Number(user.organizationId) === orgId) ||
    (await isOrgMember(user.id, orgId));

  const targetStaffId = parseInt(String(req.query.staffUserId ?? user.id));

  if (targetStaffId !== user.id) {
    if (!await requireOrgAdmin(req, res, orgId)) return;
  } else if (!isAdmin) {
    res.status(403).json({ error: "You are not a member of this organization." });
    return;
  }

  const { from, to } = req.query;

  const periodStart = from ? new Date(String(from)) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const periodEnd = to ? new Date(String(to)) : new Date();

  const conditions = [
    eq(salesAttributionsTable.organizationId, orgId),
    eq(salesAttributionsTable.staffUserId, targetStaffId),
    gte(salesAttributionsTable.attributedAt, periodStart),
    lte(salesAttributionsTable.attributedAt, periodEnd),
  ];

  const [totals] = await db
    .select({
      totalSales: sum(salesAttributionsTable.saleAmount),
      totalCommission: sum(salesAttributionsTable.commissionAmount),
      count: count(salesAttributionsTable.id),
    })
    .from(salesAttributionsTable)
    .where(and(...conditions));

  const adjConditions = [
    eq(commissionAdjustmentsTable.organizationId, orgId),
    eq(commissionAdjustmentsTable.staffUserId, targetStaffId),
    gte(commissionAdjustmentsTable.createdAt, periodStart),
    lte(commissionAdjustmentsTable.createdAt, periodEnd),
  ];

  const [adjTotals] = await db
    .select({ totalAdjustments: sum(commissionAdjustmentsTable.amount) })
    .from(commissionAdjustmentsTable)
    .where(and(...adjConditions));

  const recentAttributions = await db
    .select({
      id: salesAttributionsTable.id,
      source: salesAttributionsTable.source,
      saleAmount: salesAttributionsTable.saleAmount,
      commissionAmount: salesAttributionsTable.commissionAmount,
      category: salesAttributionsTable.category,
      attributedAt: salesAttributionsTable.attributedAt,
    })
    .from(salesAttributionsTable)
    .where(and(...conditions))
    .orderBy(desc(salesAttributionsTable.attributedAt))
    .limit(50);

  const payouts = await db
    .select({
      id: commissionPayoutsTable.id,
      periodStart: commissionPayoutsTable.periodStart,
      periodEnd: commissionPayoutsTable.periodEnd,
      netPayout: commissionPayoutsTable.netPayout,
      status: commissionPayoutsTable.status,
      paidAt: commissionPayoutsTable.paidAt,
    })
    .from(commissionPayoutsTable)
    .where(and(
      eq(commissionPayoutsTable.organizationId, orgId),
      eq(commissionPayoutsTable.staffUserId, targetStaffId),
    ))
    .orderBy(desc(commissionPayoutsTable.periodStart))
    .limit(12);

  const totalCommission = parseFloat(totals?.totalCommission ?? "0") || 0;
  const totalAdjustments = parseFloat(adjTotals?.totalAdjustments ?? "0") || 0;

  res.json({
    staffUserId: targetStaffId,
    period: { from: periodStart, to: periodEnd },
    totalSales: parseFloat(totals?.totalSales ?? "0") || 0,
    totalCommission,
    totalAdjustments,
    netEarnings: totalCommission + totalAdjustments,
    saleCount: totals?.count ?? 0,
    recentAttributions,
    payouts,
  });
});

// ─── PAYOUTS ──────────────────────────────────────────────────────────────────

// GET /organizations/:orgId/commissions/payouts
router.get("/payouts", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { staffUserId, status } = req.query;
  const conditions = [eq(commissionPayoutsTable.organizationId, orgId)];
  if (staffUserId) conditions.push(eq(commissionPayoutsTable.staffUserId, parseInt(String(staffUserId))));
  if (status) conditions.push(eq(commissionPayoutsTable.status, String(status) as "pending" | "approved" | "paid" | "cancelled"));

  const payouts = await db
    .select({
      id: commissionPayoutsTable.id,
      staffUserId: commissionPayoutsTable.staffUserId,
      staffName: appUsersTable.displayName,
      staffEmail: appUsersTable.email,
      periodStart: commissionPayoutsTable.periodStart,
      periodEnd: commissionPayoutsTable.periodEnd,
      totalSales: commissionPayoutsTable.totalSales,
      totalCommission: commissionPayoutsTable.totalCommission,
      totalAdjustments: commissionPayoutsTable.totalAdjustments,
      netPayout: commissionPayoutsTable.netPayout,
      currency: commissionPayoutsTable.currency,
      status: commissionPayoutsTable.status,
      notes: commissionPayoutsTable.notes,
      approvedAt: commissionPayoutsTable.approvedAt,
      paidAt: commissionPayoutsTable.paidAt,
      createdAt: commissionPayoutsTable.createdAt,
    })
    .from(commissionPayoutsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, commissionPayoutsTable.staffUserId))
    .where(and(...conditions))
    .orderBy(desc(commissionPayoutsTable.periodStart));

  res.json(payouts);
});

// POST /organizations/:orgId/commissions/payouts/generate
// Generates a payout record for each staff member who has unpaid attributions in the period.
router.post("/payouts/generate", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const adminUser = getUser(req)!;
  const { periodStart, periodEnd, staffUserIds } = req.body;

  if (!periodStart || !periodEnd) {
    res.status(400).json({ error: "periodStart and periodEnd are required." });
    return;
  }

  const start = new Date(String(periodStart));
  const end = new Date(String(periodEnd));

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
    res.status(400).json({ error: "Invalid period dates." });
    return;
  }

  // Get all staff with unpaid attributions in the period
  const attrConditions = [
    eq(salesAttributionsTable.organizationId, orgId),
    isNull(salesAttributionsTable.payoutId),
    gte(salesAttributionsTable.attributedAt, start),
    lte(salesAttributionsTable.attributedAt, end),
  ];
  if (staffUserIds && Array.isArray(staffUserIds) && staffUserIds.length > 0) {
    attrConditions.push(inArray(salesAttributionsTable.staffUserId, staffUserIds.map(Number)));
  }

  const staffTotals = await db
    .select({
      staffUserId: salesAttributionsTable.staffUserId,
      totalSales: sum(salesAttributionsTable.saleAmount),
      totalCommission: sum(salesAttributionsTable.commissionAmount),
    })
    .from(salesAttributionsTable)
    .where(and(...attrConditions))
    .groupBy(salesAttributionsTable.staffUserId);

  if (staffTotals.length === 0) {
    res.json({ payouts: [], message: "No unpaid attributions found for the selected period." });
    return;
  }

  const createdPayouts = [];

  for (const st of staffTotals) {
    const staffId = st.staffUserId;

    // Get adjustments for this staff member in the period
    const [adjTotal] = await db
      .select({ total: sum(commissionAdjustmentsTable.amount) })
      .from(commissionAdjustmentsTable)
      .where(and(
        eq(commissionAdjustmentsTable.organizationId, orgId),
        eq(commissionAdjustmentsTable.staffUserId, staffId),
        isNull(commissionAdjustmentsTable.payoutId),
        gte(commissionAdjustmentsTable.createdAt, start),
        lte(commissionAdjustmentsTable.createdAt, end),
      ));

    const totalSales = parseFloat(st.totalSales ?? "0") || 0;
    const totalCommission = parseFloat(st.totalCommission ?? "0") || 0;
    const totalAdjustments = parseFloat(adjTotal?.total ?? "0") || 0;
    const netPayout = totalCommission + totalAdjustments;

    const [payout] = await db.insert(commissionPayoutsTable).values({
      organizationId: orgId,
      staffUserId: staffId,
      periodStart: start,
      periodEnd: end,
      totalSales: String(totalSales.toFixed(2)),
      totalCommission: String(totalCommission.toFixed(2)),
      totalAdjustments: String(totalAdjustments.toFixed(2)),
      netPayout: String(netPayout.toFixed(2)),
      status: "pending",
    }).returning();

    // Link attributions to this payout
    await db.update(salesAttributionsTable)
      .set({ payoutId: payout.id })
      .where(and(...attrConditions, eq(salesAttributionsTable.staffUserId, staffId)));

    // Link adjustments to this payout
    await db.update(commissionAdjustmentsTable)
      .set({ payoutId: payout.id })
      .where(and(
        eq(commissionAdjustmentsTable.organizationId, orgId),
        eq(commissionAdjustmentsTable.staffUserId, staffId),
        isNull(commissionAdjustmentsTable.payoutId),
        gte(commissionAdjustmentsTable.createdAt, start),
        lte(commissionAdjustmentsTable.createdAt, end),
      ));

    createdPayouts.push(payout);
  }

  res.status(201).json({ payouts: createdPayouts });
});

// PATCH /organizations/:orgId/commissions/payouts/:payoutId/approve
router.patch("/payouts/:payoutId/approve", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const payoutId = parseInt(String((req.params as Record<string, string>).payoutId));
  const adminUser = getUser(req)!;

  const [payout] = await db.select().from(commissionPayoutsTable)
    .where(and(eq(commissionPayoutsTable.id, payoutId), eq(commissionPayoutsTable.organizationId, orgId)));
  if (!payout) { { res.status(404).json({ error: "Payout not found." }); return; } }
  if (payout.status !== "pending") { { res.status(400).json({ error: "Only pending payouts can be approved." }); return; } }

  const [updated] = await db.update(commissionPayoutsTable)
    .set({ status: "approved", approvedByUserId: adminUser.id, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(commissionPayoutsTable.id, payoutId))
    .returning();

  res.json(updated);
});

// PATCH /organizations/:orgId/commissions/payouts/:payoutId/mark-paid
router.patch("/payouts/:payoutId/mark-paid", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const payoutId = parseInt(String((req.params as Record<string, string>).payoutId));
  const { notes } = req.body;

  const [payout] = await db.select().from(commissionPayoutsTable)
    .where(and(eq(commissionPayoutsTable.id, payoutId), eq(commissionPayoutsTable.organizationId, orgId)));
  if (!payout) { { res.status(404).json({ error: "Payout not found." }); return; } }
  if (!["pending", "approved"].includes(payout.status)) { { res.status(400).json({ error: "Payout cannot be marked paid." }); return; } }

  const [updated] = await db.update(commissionPayoutsTable)
    .set({ status: "paid", paidAt: new Date(), notes: notes ?? payout.notes, updatedAt: new Date() })
    .where(eq(commissionPayoutsTable.id, payoutId))
    .returning();

  res.json(updated);
});

// PATCH /organizations/:orgId/commissions/payouts/:payoutId/cancel
router.patch("/payouts/:payoutId/cancel", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const payoutId = parseInt(String((req.params as Record<string, string>).payoutId));

  const [payout] = await db.select().from(commissionPayoutsTable)
    .where(and(eq(commissionPayoutsTable.id, payoutId), eq(commissionPayoutsTable.organizationId, orgId)));
  if (!payout) { { res.status(404).json({ error: "Payout not found." }); return; } }
  if (payout.status === "paid") { { res.status(400).json({ error: "Paid payouts cannot be cancelled." }); return; } }

  // Unlink attributions so they can be re-processed
  await db.update(salesAttributionsTable)
    .set({ payoutId: null })
    .where(eq(salesAttributionsTable.payoutId, payoutId));

  await db.update(commissionAdjustmentsTable)
    .set({ payoutId: null })
    .where(eq(commissionAdjustmentsTable.payoutId, payoutId));

  const [updated] = await db.update(commissionPayoutsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(commissionPayoutsTable.id, payoutId))
    .returning();

  res.json(updated);
});

// GET /organizations/:orgId/commissions/payouts/:payoutId/report
// Returns CSV-ready data for a payout
router.get("/payouts/:payoutId/report", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const payoutId = parseInt(String((req.params as Record<string, string>).payoutId));

  const [payout] = await db
    .select({
      id: commissionPayoutsTable.id,
      staffUserId: commissionPayoutsTable.staffUserId,
      staffName: appUsersTable.displayName,
      staffEmail: appUsersTable.email,
      periodStart: commissionPayoutsTable.periodStart,
      periodEnd: commissionPayoutsTable.periodEnd,
      totalSales: commissionPayoutsTable.totalSales,
      totalCommission: commissionPayoutsTable.totalCommission,
      totalAdjustments: commissionPayoutsTable.totalAdjustments,
      netPayout: commissionPayoutsTable.netPayout,
      currency: commissionPayoutsTable.currency,
      status: commissionPayoutsTable.status,
    })
    .from(commissionPayoutsTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, commissionPayoutsTable.staffUserId))
    .where(and(eq(commissionPayoutsTable.id, payoutId), eq(commissionPayoutsTable.organizationId, orgId)));

  if (!payout) { { res.status(404).json({ error: "Payout not found." }); return; } }

  const attributions = await db
    .select()
    .from(salesAttributionsTable)
    .where(eq(salesAttributionsTable.payoutId, payoutId))
    .orderBy(salesAttributionsTable.attributedAt);

  const adjustments = await db
    .select()
    .from(commissionAdjustmentsTable)
    .where(eq(commissionAdjustmentsTable.payoutId, payoutId));

  if (req.query.format === "csv") {
    const csvRows: string[] = [
      "Type,Date,Source,Category,Sale Amount,Commission Amount,Notes",
      ...attributions.map(a => [
        "Sale",
        new Date(a.attributedAt).toISOString().slice(0, 10),
        a.source,
        a.category ?? "",
        a.saleAmount,
        a.commissionAmount,
        a.posTransactionId ? `POS #${a.posTransactionId}` : a.lessonBookingId ? `Lesson #${a.lessonBookingId}` : "",
      ].join(",")),
      ...adjustments.map(a => [
        "Adjustment",
        new Date(a.createdAt).toISOString().slice(0, 10),
        "",
        "",
        "",
        a.amount,
        a.reason,
      ].join(",")),
      `,,,,Total Commission,${payout.totalCommission},`,
      `,,,,Total Adjustments,${payout.totalAdjustments},`,
      `,,,,Net Payout,${payout.netPayout},`,
    ];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="commission-payout-${payoutId}.csv"`);
    res.send(csvRows.join("\n"));
    return;
  }

  res.json({ payout, attributions, adjustments });
});

export default router;

// ─── COMMISSION ENGINE (exported helper for POS & Lessons hooks) ───────────────

/**
 * Compute and record a commission attribution for a POS transaction.
 * Called after the transaction is inserted.
 */
export async function attributePosCommission(
  orgId: number,
  staffUserId: number,
  transactionId: number,
  totalAmount: number,
  category: string | null,
): Promise<void> {
  try {
    // Find the best matching active commission rule for this staff + source + category
    const rules = await db.select().from(commissionRulesTable)
      .where(and(
        eq(commissionRulesTable.organizationId, orgId),
        eq(commissionRulesTable.staffUserId, staffUserId),
        eq(commissionRulesTable.source, "pos"),
        eq(commissionRulesTable.isActive, true),
      ))
      .orderBy(commissionRulesTable.tierThresholdAmount);

    if (rules.length === 0) return; // No commission rules configured

    // Pick the most specific rule: category match > generic
    // If tier threshold, check total sales this month for the staff member
    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    const [monthTotal] = await db
      .select({ total: sum(salesAttributionsTable.saleAmount) })
      .from(salesAttributionsTable)
      .where(and(
        eq(salesAttributionsTable.organizationId, orgId),
        eq(salesAttributionsTable.staffUserId, staffUserId),
        eq(salesAttributionsTable.source, "pos"),
        gte(salesAttributionsTable.attributedAt, periodStart),
      ));

    const monthSales = parseFloat(monthTotal?.total ?? "0") || 0;

    // Match: category-specific rule, or fallback to generic (null category)
    let bestRule = rules.find(r => r.category === category && (!r.tierThresholdAmount || monthSales >= parseFloat(r.tierThresholdAmount)));
    if (!bestRule) bestRule = rules.find(r => !r.category && (!r.tierThresholdAmount || monthSales >= parseFloat(r.tierThresholdAmount)));
    if (!bestRule) bestRule = rules.find(r => !r.tierThresholdAmount); // any matching rule without threshold

    if (!bestRule) return;

    const commissionAmount = bestRule.commissionType === "percentage"
      ? +(totalAmount * parseFloat(bestRule.rate) / 100).toFixed(2)
      : +parseFloat(bestRule.rate).toFixed(2);

    await db.insert(salesAttributionsTable).values({
      organizationId: orgId,
      staffUserId,
      source: "pos",
      posTransactionId: transactionId,
      saleAmount: String(totalAmount.toFixed(2)),
      category: category ?? null,
      commissionRuleId: bestRule.id,
      commissionAmount: String(commissionAmount),
    });
  } catch {
    // Non-fatal — commission attribution should not block the sale
  }
}

/**
 * Compute and record a commission attribution for a completed lesson booking.
 */
export async function attributeLessonCommission(
  orgId: number,
  staffUserId: number,
  bookingId: number,
  lessonAmount: number,
): Promise<void> {
  try {
    const rules = await db.select().from(commissionRulesTable)
      .where(and(
        eq(commissionRulesTable.organizationId, orgId),
        eq(commissionRulesTable.staffUserId, staffUserId),
        eq(commissionRulesTable.source, "lesson"),
        eq(commissionRulesTable.isActive, true),
      ));

    if (rules.length === 0) return;

    const periodStart = new Date();
    periodStart.setDate(1);
    periodStart.setHours(0, 0, 0, 0);

    const [monthTotal] = await db
      .select({ total: sum(salesAttributionsTable.saleAmount) })
      .from(salesAttributionsTable)
      .where(and(
        eq(salesAttributionsTable.organizationId, orgId),
        eq(salesAttributionsTable.staffUserId, staffUserId),
        eq(salesAttributionsTable.source, "lesson"),
        gte(salesAttributionsTable.attributedAt, periodStart),
      ));

    const monthSales = parseFloat(monthTotal?.total ?? "0") || 0;

    let bestRule = rules.find(r => !r.tierThresholdAmount || monthSales >= parseFloat(r.tierThresholdAmount));
    if (!bestRule) bestRule = rules[0];
    if (!bestRule) return;

    const commissionAmount = bestRule.commissionType === "percentage"
      ? +(lessonAmount * parseFloat(bestRule.rate) / 100).toFixed(2)
      : +parseFloat(bestRule.rate).toFixed(2);

    await db.insert(salesAttributionsTable).values({
      organizationId: orgId,
      staffUserId,
      source: "lesson",
      lessonBookingId: bookingId,
      saleAmount: String(lessonAmount.toFixed(2)),
      commissionRuleId: bestRule.id,
      commissionAmount: String(commissionAmount),
    });
  } catch {
    // Non-fatal
  }
}
