/**
 * Guest & Visitor Pass Management API — Task #112
 *
 * Guest passes (member-invited guests):
 *   POST   /organizations/:orgId/guest-passes              Create guest pass (member)
 *   GET    /organizations/:orgId/guest-passes              Admin: list all guest passes
 *   GET    /organizations/:orgId/guest-passes/my           Member: my invited guests
 *   GET    /organizations/:orgId/guest-passes/:id          Get single guest pass
 *   PATCH  /organizations/:orgId/guest-passes/:id/checkin  QR check-in
 *   DELETE /organizations/:orgId/guest-passes/:id          Cancel guest pass
 *
 * Visitor passes (non-member public purchase):
 *   POST   /public/orgs/:orgId/visitor-passes              Public: initiate visitor pass purchase
 *   POST   /public/orgs/:orgId/visitor-passes/verify-payment  Verify Razorpay payment
 *   GET    /public/orgs/:orgId/visitor-passes/:token       Public: get pass by QR token
 *   GET    /organizations/:orgId/visitor-passes            Admin: list all visitor passes
 *   PATCH  /organizations/:orgId/visitor-passes/:id/checkin  QR check-in
 *
 * Visitor pricing:
 *   GET    /organizations/:orgId/visitor-pricing           Get pricing rules
 *   POST   /organizations/:orgId/visitor-pricing           Create pricing rule
 *   PUT    /organizations/:orgId/visitor-pricing/:id       Update pricing rule
 *   DELETE /organizations/:orgId/visitor-pricing/:id       Delete pricing rule
 *
 * Guest policy:
 *   GET    /organizations/:orgId/guest-policy              Get policy
 *   PUT    /organizations/:orgId/guest-policy              Update policy
 *
 * Reports:
 *   GET    /organizations/:orgId/guest-passes/report       Revenue + volume report
 *
 * QR check-in (staff):
 *   POST   /organizations/:orgId/checkin/scan              Scan QR token (guest or visitor)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  guestPassesTable,
  visitorPassesTable,
  visitorPricingRulesTable,
  guestPolicyTable,
  appUsersTable,
  organizationsTable,
} from "@workspace/db";
import { eq, and, desc, gte, lte, sql } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import crypto from "crypto";

const router: IRouter = Router({ mergeParams: true });

function generateQrToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

function getAuthUserId(req: Request): number | null {
  const portalUserId = (req as Request & { portalUser?: { userId?: number } }).portalUser?.userId;
  const userId = portalUserId ?? req.user?.id;
  return userId ? Number(userId) : null;
}

// ─── GUEST POLICY ────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/guest-policy", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const [policy] = await db.select().from(guestPolicyTable).where(eq(guestPolicyTable.organizationId, orgId));
  res.json(policy ?? {
    organizationId: orgId,
    maxGuestsPerMemberPerMonth: 10,
    maxGuestsPerMemberPerYear: 60,
    allowMemberAccountSettlement: true,
    allowGuestOnlinePayment: true,
    allowPayAtDesk: true,
    requireGuestEmail: false,
  });
});

router.put("/organizations/:orgId/guest-policy", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    maxGuestsPerMemberPerMonth, maxGuestsPerMemberPerYear,
    allowMemberAccountSettlement, allowGuestOnlinePayment, allowPayAtDesk, requireGuestEmail,
  } = req.body;

  const fields = {
    maxGuestsPerMemberPerMonth: maxGuestsPerMemberPerMonth ?? 10,
    maxGuestsPerMemberPerYear: maxGuestsPerMemberPerYear ?? 60,
    allowMemberAccountSettlement: allowMemberAccountSettlement ?? true,
    allowGuestOnlinePayment: allowGuestOnlinePayment ?? true,
    allowPayAtDesk: allowPayAtDesk ?? true,
    requireGuestEmail: requireGuestEmail ?? false,
    updatedAt: new Date(),
  };

  const [policy] = await db.insert(guestPolicyTable).values({ organizationId: orgId, ...fields })
    .onConflictDoUpdate({ target: guestPolicyTable.organizationId, set: fields })
    .returning();

  res.json(policy);
});

// ─── VISITOR PRICING ─────────────────────────────────────────────────────────

router.get("/organizations/:orgId/visitor-pricing", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rules = await db.select().from(visitorPricingRulesTable)
    .where(eq(visitorPricingRulesTable.organizationId, orgId))
    .orderBy(visitorPricingRulesTable.sortOrder);
  res.json(rules);
});

router.post("/organizations/:orgId/visitor-pricing", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { label, description, weekdayRate, weekendRate, twilightRate, reciprocalRate, dayOverrides, isActive, sortOrder } = req.body;
  if (!label) { { res.status(400).json({ error: "label is required" }); return; } }

  const [rule] = await db.insert(visitorPricingRulesTable).values({
    organizationId: orgId,
    label,
    description: description ?? null,
    weekdayRate: String(weekdayRate ?? 0),
    weekendRate: String(weekendRate ?? 0),
    twilightRate: twilightRate != null ? String(twilightRate) : null,
    reciprocalRate: reciprocalRate != null ? String(reciprocalRate) : null,
    dayOverrides: dayOverrides ?? {},
    isActive: isActive ?? true,
    sortOrder: sortOrder ?? 0,
  }).returning();

  res.status(201).json(rule);
});

router.put("/organizations/:orgId/visitor-pricing/:ruleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { label, description, weekdayRate, weekendRate, twilightRate, reciprocalRate, dayOverrides, isActive, sortOrder } = req.body;

  const [rule] = await db.update(visitorPricingRulesTable).set({
    ...(label && { label }),
    ...(description !== undefined && { description }),
    ...(weekdayRate != null && { weekdayRate: String(weekdayRate) }),
    ...(weekendRate != null && { weekendRate: String(weekendRate) }),
    ...(twilightRate !== undefined && { twilightRate: twilightRate != null ? String(twilightRate) : null }),
    ...(reciprocalRate !== undefined && { reciprocalRate: reciprocalRate != null ? String(reciprocalRate) : null }),
    ...(dayOverrides !== undefined && { dayOverrides }),
    ...(isActive !== undefined && { isActive }),
    ...(sortOrder != null && { sortOrder }),
    updatedAt: new Date(),
  }).where(and(eq(visitorPricingRulesTable.id, ruleId), eq(visitorPricingRulesTable.organizationId, orgId))).returning();

  if (!rule) { { res.status(404).json({ error: "Pricing rule not found" }); return; } }
  res.json(rule);
});

router.delete("/organizations/:orgId/visitor-pricing/:ruleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).ruleId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(visitorPricingRulesTable)
    .where(and(eq(visitorPricingRulesTable.id, ruleId), eq(visitorPricingRulesTable.organizationId, orgId)));
  res.status(204).end();
});

// ─── GUEST PASSES (member-invited guests) ────────────────────────────────────

router.post("/organizations/:orgId/guest-passes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { guestName, guestEmail, guestPhone, playDate, feeSettlement, teeBookingId, teeBookingPlayerId, notes } = req.body;
  if (!guestName || !playDate) { { res.status(400).json({ error: "guestName and playDate are required" }); return; } }

  const [org] = await db.select({ id: organizationsTable.id })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const [policy] = await db.select().from(guestPolicyTable).where(eq(guestPolicyTable.organizationId, orgId));
  const monthLimit = policy?.maxGuestsPerMemberPerMonth ?? 10;
  const yearLimit = policy?.maxGuestsPerMemberPerYear ?? 60;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const [monthCount] = await db.select({ count: sql<number>`COUNT(*)::int` })
    .from(guestPassesTable)
    .where(and(
      eq(guestPassesTable.organizationId, orgId),
      eq(guestPassesTable.invitedByUserId, userId),
      gte(guestPassesTable.createdAt, startOfMonth),
      sql`${guestPassesTable.status} NOT IN ('cancelled')`,
    ));
  if ((monthCount?.count ?? 0) >= monthLimit) {
    res.status(400).json({ error: `Monthly guest limit of ${monthLimit} reached.` }); return;
  }

  const [yearCount] = await db.select({ count: sql<number>`COUNT(*)::int` })
    .from(guestPassesTable)
    .where(and(
      eq(guestPassesTable.organizationId, orgId),
      eq(guestPassesTable.invitedByUserId, userId),
      gte(guestPassesTable.createdAt, startOfYear),
      sql`${guestPassesTable.status} NOT IN ('cancelled')`,
    ));
  if ((yearCount?.count ?? 0) >= yearLimit) {
    res.status(400).json({ error: `Annual guest limit of ${yearLimit} reached.` }); return;
  }

  const [pricing] = await db.select().from(visitorPricingRulesTable)
    .where(and(eq(visitorPricingRulesTable.organizationId, orgId), eq(visitorPricingRulesTable.isActive, true)))
    .orderBy(visitorPricingRulesTable.sortOrder)
    .limit(1);

  const playDateObj = new Date(playDate);
  const dayOfWeek = playDateObj.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const dayOverrides = pricing?.dayOverrides as Record<string, string> | undefined;
  const dayKey = String(dayOfWeek);
  const greenFee = dayOverrides?.[dayKey] != null
    ? dayOverrides[dayKey]
    : isWeekend
      ? (pricing?.weekendRate ?? "0")
      : (pricing?.weekdayRate ?? "0");

  const effectiveFeeSettlement = feeSettlement ?? "pay_at_desk";
  const initialStatus = effectiveFeeSettlement === "member_account" || effectiveFeeSettlement === "pay_at_desk"
    ? "confirmed" as const
    : "pending" as const;

  const [pass] = await db.insert(guestPassesTable).values({
    organizationId: orgId,
    invitedByUserId: userId,
    guestName,
    guestEmail: guestEmail ?? null,
    guestPhone: guestPhone ?? null,
    playDate: playDateObj,
    greenFee: String(greenFee),
    feeSettlement: effectiveFeeSettlement,
    status: initialStatus,
    qrToken: generateQrToken(),
    teeBookingId: teeBookingId ?? null,
    teeBookingPlayerId: teeBookingPlayerId ?? null,
    notes: notes ?? null,
  }).returning();

  res.status(201).json(pass);
});

router.get("/organizations/:orgId/guest-passes/report", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = req.query;
  const fromDate = from ? new Date(String(from)) : new Date(new Date().getFullYear(), new Date().getMonth() - 2, 1);
  const toDate = to ? new Date(String(to)) : new Date();

  const guestRows = await db
    .select({
      playDate: guestPassesTable.playDate,
      greenFee: guestPassesTable.greenFee,
      status: guestPassesTable.status,
      feeSettlement: guestPassesTable.feeSettlement,
      memberName: appUsersTable.displayName,
      guestName: guestPassesTable.guestName,
    })
    .from(guestPassesTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, guestPassesTable.invitedByUserId))
    .where(and(
      eq(guestPassesTable.organizationId, orgId),
      gte(guestPassesTable.playDate, fromDate),
      lte(guestPassesTable.playDate, toDate),
    ));

  const visitorRows = await db
    .select({
      playDate: visitorPassesTable.playDate,
      greenFee: visitorPassesTable.greenFee,
      status: visitorPassesTable.status,
      visitorName: visitorPassesTable.visitorName,
    })
    .from(visitorPassesTable)
    .where(and(
      eq(visitorPassesTable.organizationId, orgId),
      gte(visitorPassesTable.playDate, fromDate),
      lte(visitorPassesTable.playDate, toDate),
    ));

  const totalGuestRevenue = guestRows
    .filter(r => r.status !== "cancelled")
    .reduce((sum, r) => sum + parseFloat(String(r.greenFee ?? 0)), 0);

  const totalVisitorRevenue = visitorRows
    .filter(r => r.status === "paid" || r.status === "checked_in")
    .reduce((sum, r) => sum + parseFloat(String(r.greenFee ?? 0)), 0);

  res.json({
    period: { from: fromDate, to: toDate },
    guestPasses: {
      total: guestRows.length,
      checkedIn: guestRows.filter(r => r.status === "checked_in").length,
      noShow: guestRows.filter(r => r.status === "no_show").length,
      cancelled: guestRows.filter(r => r.status === "cancelled").length,
      revenue: totalGuestRevenue,
      rows: guestRows,
    },
    visitorPasses: {
      total: visitorRows.length,
      checkedIn: visitorRows.filter(r => r.status === "checked_in").length,
      noShow: visitorRows.filter(r => r.status === "no_show").length,
      cancelled: visitorRows.filter(r => r.status === "cancelled").length,
      revenue: totalVisitorRevenue,
      rows: visitorRows,
    },
    combinedRevenue: totalGuestRevenue + totalVisitorRevenue,
  });
});

router.get("/organizations/:orgId/guest-passes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to, status } = req.query;
  const conditions: ReturnType<typeof eq>[] = [eq(guestPassesTable.organizationId, orgId)];
  if (from) conditions.push(gte(guestPassesTable.playDate, new Date(String(from))) as ReturnType<typeof eq>);
  if (to) conditions.push(lte(guestPassesTable.playDate, new Date(String(to))) as ReturnType<typeof eq>);
  if (status) conditions.push(sql`${guestPassesTable.status} = ${String(status)}` as ReturnType<typeof eq>);

  const passes = await db
    .select({
      pass: guestPassesTable,
      memberName: appUsersTable.displayName,
      memberEmail: appUsersTable.email,
    })
    .from(guestPassesTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, guestPassesTable.invitedByUserId))
    .where(and(...conditions))
    .orderBy(desc(guestPassesTable.playDate))
    .limit(200);

  res.json(passes);
});

router.get("/organizations/:orgId/guest-passes/my", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const passes = await db.select().from(guestPassesTable)
    .where(and(eq(guestPassesTable.organizationId, orgId), eq(guestPassesTable.invitedByUserId, userId)))
    .orderBy(desc(guestPassesTable.playDate))
    .limit(50);

  res.json(passes);
});

router.get("/organizations/:orgId/guest-passes/:passId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const passId = parseInt(String((req.params as Record<string, string>).passId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const [pass] = await db.select().from(guestPassesTable)
    .where(and(eq(guestPassesTable.id, passId), eq(guestPassesTable.organizationId, orgId)));

  if (!pass) { { res.status(404).json({ error: "Guest pass not found" }); return; } }

  const callerUser = req.user as { role?: string; organizationId?: number } | undefined;
  const callerRole = callerUser?.role ?? "";
  const callerIsAdmin = callerRole === "super_admin" || callerRole === "org_admin" || callerRole === "tournament_director";
  if (!callerIsAdmin && pass.invitedByUserId !== userId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  res.json(pass);
});

router.delete("/organizations/:orgId/guest-passes/:passId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const passId = parseInt(String((req.params as Record<string, string>).passId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const [pass] = await db.select().from(guestPassesTable)
    .where(and(eq(guestPassesTable.id, passId), eq(guestPassesTable.organizationId, orgId)));
  if (!pass) { { res.status(404).json({ error: "Guest pass not found" }); return; } }

  const callerUser2 = req.user as { role?: string } | undefined;
  const callerRole2 = callerUser2?.role ?? "";
  const callerIsAdmin2 = callerRole2 === "super_admin" || callerRole2 === "org_admin" || callerRole2 === "tournament_director";
  if (!callerIsAdmin2 && pass.invitedByUserId !== userId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  await db.update(guestPassesTable).set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(guestPassesTable.id, passId));
  res.status(204).end();
});

// ─── QR CHECK-IN (staff endpoint) ────────────────────────────────────────────

router.post("/organizations/:orgId/checkin/scan", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { qrToken } = req.body;
  if (!qrToken) { { res.status(400).json({ error: "qrToken is required" }); return; } }

  const guestPass = await db.select().from(guestPassesTable)
    .where(and(eq(guestPassesTable.qrToken, qrToken), eq(guestPassesTable.organizationId, orgId)))
    .limit(1);

  if (guestPass.length > 0) {
    const pass = guestPass[0];
    if (pass.status === "checked_in") {
      res.json({ type: "guest_pass", pass, warning: "Already checked in" }); return;
    }
    if (pass.status === "cancelled") {
      res.status(400).json({ error: "This guest pass has been cancelled" }); return;
    }
    const [updated] = await db.update(guestPassesTable).set({
      status: "checked_in",
      checkedInAt: new Date(),
      checkedInByUserId: userId,
      updatedAt: new Date(),
    }).where(eq(guestPassesTable.id, pass.id)).returning();
    res.json({ type: "guest_pass", pass: updated });
    return;
  }

  const visitorPass = await db.select().from(visitorPassesTable)
    .where(and(eq(visitorPassesTable.qrToken, qrToken), eq(visitorPassesTable.organizationId, orgId)))
    .limit(1);

  if (visitorPass.length > 0) {
    const pass = visitorPass[0];
    if (pass.status === "checked_in") {
      res.json({ type: "visitor_pass", pass, warning: "Already checked in" }); return;
    }
    if (pass.status === "cancelled") {
      res.status(400).json({ error: "This visitor pass has been cancelled" }); return;
    }
    if (pass.status === "pending_payment") {
      res.status(400).json({ error: "Payment not yet completed for this visitor pass" }); return;
    }
    const [updated] = await db.update(visitorPassesTable).set({
      status: "checked_in",
      checkedInAt: new Date(),
      checkedInByUserId: userId,
      updatedAt: new Date(),
    }).where(eq(visitorPassesTable.id, pass.id)).returning();
    res.json({ type: "visitor_pass", pass: updated });
    return;
  }

  res.status(404).json({ error: "QR code not found or does not belong to this club" });
});

// ─── VISITOR PASSES (public non-member purchase) ─────────────────────────────

router.post("/public/orgs/:orgId/visitor-passes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const { visitorName, visitorEmail, visitorPhone, playDate, pricingRuleId } = req.body;
  if (!visitorName || !visitorEmail || !playDate) {
    res.status(400).json({ error: "visitorName, visitorEmail, and playDate are required" }); return;
  }

  const [org] = await db.select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  let greenFee = "0";
  if (pricingRuleId) {
    const [rule] = await db.select().from(visitorPricingRulesTable)
      .where(and(eq(visitorPricingRulesTable.id, parseInt(String(pricingRuleId))), eq(visitorPricingRulesTable.organizationId, orgId)));
    if (rule) {
      const playDateObj = new Date(playDate);
      const dayOfWeek = playDateObj.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const dayOverrides = rule.dayOverrides as Record<string, string> | undefined;
      const dayKey = String(dayOfWeek);
      greenFee = dayOverrides?.[dayKey] != null
        ? dayOverrides[dayKey]
        : isWeekend ? String(rule.weekendRate) : String(rule.weekdayRate);
    }
  } else {
    const [rule] = await db.select().from(visitorPricingRulesTable)
      .where(and(eq(visitorPricingRulesTable.organizationId, orgId), eq(visitorPricingRulesTable.isActive, true)))
      .orderBy(visitorPricingRulesTable.sortOrder)
      .limit(1);
    if (rule) {
      const playDateObj = new Date(playDate);
      const dayOfWeek = playDateObj.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const dayOverrides = rule.dayOverrides as Record<string, string> | undefined;
      const dayKey = String(dayOfWeek);
      greenFee = dayOverrides?.[dayKey] != null
        ? dayOverrides[dayKey]
        : isWeekend ? String(rule.weekendRate) : String(rule.weekdayRate);
    }
  }

  const [pass] = await db.insert(visitorPassesTable).values({
    organizationId: orgId,
    visitorName,
    visitorEmail,
    visitorPhone: visitorPhone ?? null,
    playDate: new Date(playDate),
    greenFee,
    status: parseFloat(greenFee) === 0 ? "paid" : "pending_payment",
    qrToken: generateQrToken(),
  }).returning();

  res.status(201).json({ pass, orgName: org.name });
});

router.get("/public/orgs/:orgId/visitor-passes/:token", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const token = (req.params as Record<string, string>).token;

  const [pass] = await db.select().from(visitorPassesTable)
    .where(and(eq(visitorPassesTable.qrToken, token), eq(visitorPassesTable.organizationId, orgId)));

  if (!pass) { { res.status(404).json({ error: "Visitor pass not found" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  res.json({ pass, org });
});

router.post("/public/orgs/:orgId/visitor-passes/:passId/mark-paid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const passId = parseInt(String((req.params as Record<string, string>).passId));

  const { razorpayOrderId, razorpayPaymentId } = req.body;
  if (!razorpayOrderId || !razorpayPaymentId) {
    res.status(400).json({ error: "razorpayOrderId and razorpayPaymentId are required" }); return;
  }

  const [pass] = await db.select().from(visitorPassesTable)
    .where(and(eq(visitorPassesTable.id, passId), eq(visitorPassesTable.organizationId, orgId)));
  if (!pass) { { res.status(404).json({ error: "Visitor pass not found" }); return; } }

  const [updated] = await db.update(visitorPassesTable).set({
    status: "paid",
    razorpayOrderId,
    razorpayPaymentId,
    paidAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(visitorPassesTable.id, passId)).returning();

  res.json(updated);
});

router.get("/organizations/:orgId/visitor-passes", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to, status } = req.query;
  const conditions: ReturnType<typeof eq>[] = [eq(visitorPassesTable.organizationId, orgId)];
  if (from) conditions.push(gte(visitorPassesTable.playDate, new Date(String(from))) as ReturnType<typeof eq>);
  if (to) conditions.push(lte(visitorPassesTable.playDate, new Date(String(to))) as ReturnType<typeof eq>);
  if (status) conditions.push(sql`${visitorPassesTable.status} = ${String(status)}` as ReturnType<typeof eq>);

  const passes = await db.select().from(visitorPassesTable)
    .where(and(...conditions))
    .orderBy(desc(visitorPassesTable.playDate))
    .limit(200);

  res.json(passes);
});

router.patch("/organizations/:orgId/visitor-passes/:passId/checkin", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const passId = parseInt(String((req.params as Record<string, string>).passId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const [pass] = await db.select().from(visitorPassesTable)
    .where(and(eq(visitorPassesTable.id, passId), eq(visitorPassesTable.organizationId, orgId)));
  if (!pass) { { res.status(404).json({ error: "Visitor pass not found" }); return; } }

  if (pass.status === "pending_payment") {
    res.status(400).json({ error: "Payment not yet completed" }); return;
  }

  const [updated] = await db.update(visitorPassesTable).set({
    status: "checked_in",
    checkedInAt: new Date(),
    checkedInByUserId: userId,
    updatedAt: new Date(),
  }).where(eq(visitorPassesTable.id, passId)).returning();

  res.json(updated);
});

router.get("/public/orgs/:orgId/visitor-pricing", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const rules = await db.select().from(visitorPricingRulesTable)
    .where(and(eq(visitorPricingRulesTable.organizationId, orgId), eq(visitorPricingRulesTable.isActive, true)))
    .orderBy(visitorPricingRulesTable.sortOrder);
  res.json(rules);
});

export default router;
