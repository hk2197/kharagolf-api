/**
 * Commerce Analytics API
 *
 * GET /organizations/:orgId/commerce-analytics
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=daily|weekly|monthly
 *
 * Returns:
 *  - Revenue by channel (shop, POS, F&B, tee times, memberships, tournament)
 *  - Revenue trend (daily/weekly/monthly)
 *  - Top-selling products by units and revenue
 *  - Average order value per channel
 *  - Refund volume and rate
 *  - GST collected summary (CGST, SGST, IGST by state)
 *  - Staff POS performance
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  shopOrdersTable, shopProductsTable,
  posTransactionsTable, posTransactionItemsTable,
  fbOrdersTable,
  marketplaceBookingsTable,
  memberInvoicesTable,
  playersTable, tournamentsTable,
  leagueMembersTable, leaguesTable,
  orgMembershipsTable,
  appUsersTable,
  gstInvoicesTable,
} from "@workspace/db";
import {
  eq, and, gte, lte, desc, sql, sum, count, avg, inArray, type SQL,
} from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router({ mergeParams: true });

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number(user.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Admin access required" }); return false; }
  return true;
}

function dateTrunc(granularity: string, col: unknown): SQL {
  const g = granularity === "weekly" ? "week" : granularity === "monthly" ? "month" : "day";
  return sql`date_trunc(${g}, ${col})`;
}

// GET /organizations/:orgId/commerce-analytics
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to, granularity = "daily" } = req.query;
  const fromDate = from ? new Date(String(from)) : new Date(Date.now() - 30 * 86_400_000);
  const toDate = to ? new Date(String(to)) : new Date();

  try {
    // ── 1. Online Shop Revenue ─────────────────────────────────────────────────
    const shopOrders = await db.select({
      totalRevenue: sum(shopOrdersTable.totalAmount),
      orderCount: count(),
      refundedCount: sql<number>`count(*) filter (where ${shopOrdersTable.status} = 'returned')`,
    }).from(shopOrdersTable)
      .where(and(
        eq(shopOrdersTable.organizationId, orgId),
        inArray(shopOrdersTable.status, ["paid", "processing", "shipped", "delivered", "returned"]),
        gte(shopOrdersTable.createdAt, fromDate),
        lte(shopOrdersTable.createdAt, toDate),
      ));

    const shopRevenue = parseFloat(shopOrders[0]?.totalRevenue ?? "0");
    const shopOrderCount = Number(shopOrders[0]?.orderCount ?? 0);
    const shopRefundCount = Number(shopOrders[0]?.refundedCount ?? 0);

    // ── 2. POS Revenue ────────────────────────────────────────────────────────
    const posData = await db.select({
      totalRevenue: sum(posTransactionsTable.totalAmount),
      orderCount: count(),
    }).from(posTransactionsTable)
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.status, "completed"),
        gte(posTransactionsTable.transactedAt, fromDate),
        lte(posTransactionsTable.transactedAt, toDate),
      ));

    const posRevenue = parseFloat(posData[0]?.totalRevenue ?? "0");
    const posOrderCount = Number(posData[0]?.orderCount ?? 0);

    // ── 3. F&B Revenue ────────────────────────────────────────────────────────
    const fbData = await db.select({
      totalRevenue: sum(fbOrdersTable.totalAmount),
      orderCount: count(),
    }).from(fbOrdersTable)
      .where(and(
        eq(fbOrdersTable.organizationId, orgId),
        inArray(fbOrdersTable.status, ["delivered"]),
        gte(fbOrdersTable.createdAt, fromDate),
        lte(fbOrdersTable.createdAt, toDate),
      ));

    const fbRevenue = parseFloat(fbData[0]?.totalRevenue ?? "0");

    // ── 4. Tee Time / Marketplace Revenue ─────────────────────────────────────
    const teeData = await db.select({
      totalRevenuePaise: sum(marketplaceBookingsTable.amountPaise),
      orderCount: count(),
    }).from(marketplaceBookingsTable)
      .where(and(
        eq(marketplaceBookingsTable.organizationId, orgId),
        eq(marketplaceBookingsTable.paymentStatus, "confirmed"),
        gte(marketplaceBookingsTable.bookedAt, fromDate),
        lte(marketplaceBookingsTable.bookedAt, toDate),
      ));

    const teeRevenue = Number(teeData[0]?.totalRevenuePaise ?? 0) / 100;

    // ── 5. Membership / Dues Revenue ──────────────────────────────────────────
    const duesData = await db.select({
      totalRevenue: sum(memberInvoicesTable.paidAmount),
      orderCount: count(),
    }).from(memberInvoicesTable)
      .where(and(
        eq(memberInvoicesTable.organizationId, orgId),
        eq(memberInvoicesTable.status, "paid"),
        gte(memberInvoicesTable.paidAt, fromDate),
        lte(memberInvoicesTable.paidAt, toDate),
      ));

    const duesRevenue = parseFloat(duesData[0]?.totalRevenue ?? "0");

    // ── 6. Tournament Fees ────────────────────────────────────────────────────
    const tournamentData = await db.select({
      totalRevenue: sum(tournamentsTable.entryFee),
      playerCount: count(),
    }).from(playersTable)
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .where(and(
        eq(tournamentsTable.organizationId, orgId),
        eq(playersTable.paymentStatus, "paid"),
        gte(playersTable.registeredAt, fromDate),
        lte(playersTable.registeredAt, toDate),
      ));

    const tournamentRevenue = parseFloat(tournamentData[0]?.totalRevenue ?? "0");

    // ── 7. Revenue Trend — all 6 channels ────────────────────────────────────
    const gran = (col: unknown): SQL =>
      granularity === "monthly" ? sql`date_trunc('month', ${col})`
        : granularity === "weekly" ? sql`date_trunc('week', ${col})`
        : sql`date_trunc('day', ${col})`;

    const shopTrend = await db.select({
      period: gran(shopOrdersTable.createdAt),
      revenue: sum(shopOrdersTable.totalAmount),
      channel: sql<string>`'shop'`,
    }).from(shopOrdersTable)
      .where(and(
        eq(shopOrdersTable.organizationId, orgId),
        inArray(shopOrdersTable.status, ["paid", "processing", "shipped", "delivered"]),
        gte(shopOrdersTable.createdAt, fromDate),
        lte(shopOrdersTable.createdAt, toDate),
      ))
      .groupBy(gran(shopOrdersTable.createdAt))
      .orderBy(gran(shopOrdersTable.createdAt));

    const posTrend = await db.select({
      period: gran(posTransactionsTable.transactedAt),
      revenue: sum(posTransactionsTable.totalAmount),
      channel: sql<string>`'pos'`,
    }).from(posTransactionsTable)
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.status, "completed"),
        gte(posTransactionsTable.transactedAt, fromDate),
        lte(posTransactionsTable.transactedAt, toDate),
      ))
      .groupBy(gran(posTransactionsTable.transactedAt))
      .orderBy(gran(posTransactionsTable.transactedAt));

    const fbTrend = await db.select({
      period: gran(fbOrdersTable.createdAt),
      revenue: sum(fbOrdersTable.totalAmount),
      channel: sql<string>`'fb'`,
    }).from(fbOrdersTable)
      .where(and(
        eq(fbOrdersTable.organizationId, orgId),
        inArray(fbOrdersTable.status, ["delivered"]),
        gte(fbOrdersTable.createdAt, fromDate),
        lte(fbOrdersTable.createdAt, toDate),
      ))
      .groupBy(gran(fbOrdersTable.createdAt))
      .orderBy(gran(fbOrdersTable.createdAt));

    const teeTrend = await db.select({
      period: gran(marketplaceBookingsTable.bookedAt),
      revenue: sql<string>`sum(${marketplaceBookingsTable.amountPaise}::numeric / 100)`,
      channel: sql<string>`'tee_times'`,
    }).from(marketplaceBookingsTable)
      .where(and(
        eq(marketplaceBookingsTable.organizationId, orgId),
        eq(marketplaceBookingsTable.paymentStatus, "confirmed"),
        gte(marketplaceBookingsTable.bookedAt, fromDate),
        lte(marketplaceBookingsTable.bookedAt, toDate),
      ))
      .groupBy(gran(marketplaceBookingsTable.bookedAt))
      .orderBy(gran(marketplaceBookingsTable.bookedAt));

    const duesTrend = await db.select({
      period: gran(memberInvoicesTable.paidAt),
      revenue: sum(memberInvoicesTable.paidAmount),
      channel: sql<string>`'memberships'`,
    }).from(memberInvoicesTable)
      .where(and(
        eq(memberInvoicesTable.organizationId, orgId),
        eq(memberInvoicesTable.status, "paid"),
        gte(memberInvoicesTable.paidAt, fromDate),
        lte(memberInvoicesTable.paidAt, toDate),
      ))
      .groupBy(gran(memberInvoicesTable.paidAt))
      .orderBy(gran(memberInvoicesTable.paidAt));

    const tournamentTrend = await db.select({
      period: gran(playersTable.registeredAt),
      revenue: sum(tournamentsTable.entryFee),
      channel: sql<string>`'tournament'`,
    }).from(playersTable)
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .where(and(
        eq(tournamentsTable.organizationId, orgId),
        eq(playersTable.paymentStatus, "paid"),
        gte(playersTable.registeredAt, fromDate),
        lte(playersTable.registeredAt, toDate),
      ))
      .groupBy(gran(playersTable.registeredAt))
      .orderBy(gran(playersTable.registeredAt));

    const leagueTrend = await db.select({
      period: gran(leagueMembersTable.joinedAt),
      revenue: sum(leaguesTable.entryFee),
      channel: sql<string>`'league'`,
    }).from(leagueMembersTable)
      .innerJoin(leaguesTable, eq(leagueMembersTable.leagueId, leaguesTable.id))
      .where(and(
        eq(leaguesTable.organizationId, orgId),
        eq(leagueMembersTable.paymentStatus, "paid"),
        gte(leagueMembersTable.joinedAt, fromDate),
        lte(leagueMembersTable.joinedAt, toDate),
      ))
      .groupBy(gran(leagueMembersTable.joinedAt))
      .orderBy(gran(leagueMembersTable.joinedAt));

    const revenueTrend = [
      ...shopTrend.map(r => ({ period: r.period, revenue: parseFloat(r.revenue ?? "0"), channel: "shop" })),
      ...posTrend.map(r => ({ period: r.period, revenue: parseFloat(r.revenue ?? "0"), channel: "pos" })),
      ...fbTrend.map(r => ({ period: r.period, revenue: parseFloat(r.revenue ?? "0"), channel: "fb" })),
      ...teeTrend.map(r => ({ period: r.period, revenue: parseFloat(r.revenue ?? "0"), channel: "tee_times" })),
      ...duesTrend.map(r => ({ period: r.period, revenue: parseFloat(r.revenue ?? "0"), channel: "memberships" })),
      ...tournamentTrend.map(r => ({ period: r.period, revenue: parseFloat(r.revenue ?? "0"), channel: "tournament" })),
      ...leagueTrend.map(r => ({ period: r.period, revenue: parseFloat(r.revenue ?? "0"), channel: "league" })),
    ].sort((a, b) => new Date(a.period as string).getTime() - new Date(b.period as string).getTime());

    // ── 8. Top Products ───────────────────────────────────────────────────────
    const topShopProducts = await db.select({
      productName: shopProductsTable.name,
      unitsSold: sum(shopOrdersTable.quantity),
      revenue: sum(shopOrdersTable.totalAmount),
    }).from(shopOrdersTable)
      .innerJoin(shopProductsTable, eq(shopOrdersTable.productId, shopProductsTable.id))
      .where(and(
        eq(shopOrdersTable.organizationId, orgId),
        inArray(shopOrdersTable.status, ["paid", "processing", "shipped", "delivered"]),
        gte(shopOrdersTable.createdAt, fromDate),
        lte(shopOrdersTable.createdAt, toDate),
      ))
      .groupBy(shopProductsTable.name)
      .orderBy(desc(sum(shopOrdersTable.totalAmount)))
      .limit(10);

    const topPosItems = await db.select({
      productName: posTransactionItemsTable.productName,
      unitsSold: sum(posTransactionItemsTable.quantity),
      revenue: sum(posTransactionItemsTable.lineTotal),
    }).from(posTransactionItemsTable)
      .innerJoin(posTransactionsTable, eq(posTransactionItemsTable.transactionId, posTransactionsTable.id))
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.status, "completed"),
        gte(posTransactionsTable.transactedAt, fromDate),
        lte(posTransactionsTable.transactedAt, toDate),
      ))
      .groupBy(posTransactionItemsTable.productName)
      .orderBy(desc(sum(posTransactionItemsTable.lineTotal)))
      .limit(10);

    // ── 9. Average Order Value per Channel ───────────────────────────────────
    const shopAov = shopOrderCount > 0 ? shopRevenue / shopOrderCount : 0;
    const posAov = posOrderCount > 0 ? posRevenue / posOrderCount : 0;

    // ── 10. Refund Stats ──────────────────────────────────────────────────────
    const refundRate = shopOrderCount > 0 ? (shopRefundCount / shopOrderCount) * 100 : 0;

    // ── 11. GST Summary ───────────────────────────────────────────────────────
    const gstSummary = await db.select({
      totalInvoices: count(),
      totalTaxable: sum(gstInvoicesTable.taxableAmount),
      totalCgst: sum(gstInvoicesTable.cgstAmount),
      totalSgst: sum(gstInvoicesTable.sgstAmount),
      totalIgst: sum(gstInvoicesTable.igstAmount),
    }).from(gstInvoicesTable)
      .where(and(
        eq(gstInvoicesTable.organizationId, orgId),
        gte(gstInvoicesTable.invoiceDate, fromDate),
        lte(gstInvoicesTable.invoiceDate, toDate),
      ));

    const gstByChannel = await db.select({
      channel: gstInvoicesTable.channel,
      cgst: sum(gstInvoicesTable.cgstAmount),
      sgst: sum(gstInvoicesTable.sgstAmount),
      igst: sum(gstInvoicesTable.igstAmount),
      total: sum(gstInvoicesTable.totalAmount),
    }).from(gstInvoicesTable)
      .where(and(
        eq(gstInvoicesTable.organizationId, orgId),
        gte(gstInvoicesTable.invoiceDate, fromDate),
        lte(gstInvoicesTable.invoiceDate, toDate),
      ))
      .groupBy(gstInvoicesTable.channel);

    const gstByState = await db.select({
      stateOfSupply: gstInvoicesTable.stateOfSupply,
      cgst: sum(gstInvoicesTable.cgstAmount),
      sgst: sum(gstInvoicesTable.sgstAmount),
      igst: sum(gstInvoicesTable.igstAmount),
    }).from(gstInvoicesTable)
      .where(and(
        eq(gstInvoicesTable.organizationId, orgId),
        gte(gstInvoicesTable.invoiceDate, fromDate),
        lte(gstInvoicesTable.invoiceDate, toDate),
      ))
      .groupBy(gstInvoicesTable.stateOfSupply);

    // ── 12. Promotion / Discount Performance ──────────────────────────────────
    // Aggregate discounts from shop orders and POS transactions within the period
    const shopDiscountData = await db.select({
      discountedOrders: sql<number>`count(*) filter (where ${shopOrdersTable.discountTotal}::numeric > 0)`,
      totalDiscountGiven: sum(shopOrdersTable.discountTotal),
      grossRevenue: sql<string>`sum(${shopOrdersTable.totalAmount}::numeric + ${shopOrdersTable.discountTotal}::numeric)`,
    }).from(shopOrdersTable)
      .where(and(
        eq(shopOrdersTable.organizationId, orgId),
        inArray(shopOrdersTable.status, ["paid", "processing", "shipped", "delivered", "returned"]),
        gte(shopOrdersTable.createdAt, fromDate),
        lte(shopOrdersTable.createdAt, toDate),
      ));

    const posDiscountData = await db.select({
      discountedTransactions: sql<number>`count(*) filter (where ${posTransactionsTable.discountAmount}::numeric > 0)`,
      totalDiscountGiven: sum(posTransactionsTable.discountAmount),
    }).from(posTransactionsTable)
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.status, "completed"),
        gte(posTransactionsTable.transactedAt, fromDate),
        lte(posTransactionsTable.transactedAt, toDate),
      ));

    const shopDiscountTotal = parseFloat(shopDiscountData[0]?.totalDiscountGiven ?? "0");
    const posDiscountTotal = parseFloat(posDiscountData[0]?.totalDiscountGiven ?? "0");
    const shopGross = parseFloat(shopDiscountData[0]?.grossRevenue ?? String(shopRevenue));
    const totalDiscountGiven = shopDiscountTotal + posDiscountTotal;
    const promotionRate = shopGross > 0 ? (shopDiscountTotal / shopGross) * 100 : 0;

    // ── 13. Staff POS Performance ─────────────────────────────────────────────
    const staffPerf = await db.select({
      staffUserId: posTransactionsTable.staffUserId,
      staffName: appUsersTable.displayName,
      salesCount: count(),
      totalRevenue: sum(posTransactionsTable.totalAmount),
    }).from(posTransactionsTable)
      .leftJoin(appUsersTable, eq(posTransactionsTable.staffUserId, appUsersTable.id))
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.status, "completed"),
        gte(posTransactionsTable.transactedAt, fromDate),
        lte(posTransactionsTable.transactedAt, toDate),
      ))
      .groupBy(posTransactionsTable.staffUserId, appUsersTable.displayName)
      .orderBy(desc(sum(posTransactionsTable.totalAmount)))
      .limit(20);

    // ── League revenue (summary — also in trend) + combined totals ───────────
    const leagueData = await db.select({
      totalRevenue: sum(leaguesTable.entryFee),
      memberCount: count(),
    }).from(leagueMembersTable)
      .innerJoin(leaguesTable, eq(leagueMembersTable.leagueId, leaguesTable.id))
      .where(and(
        eq(leaguesTable.organizationId, orgId),
        eq(leagueMembersTable.paymentStatus, "paid"),
        gte(leagueMembersTable.joinedAt, fromDate),
        lte(leagueMembersTable.joinedAt, toDate),
      ));

    const leagueRevenue = parseFloat(leagueData[0]?.totalRevenue ?? "0");
    const totalRevenue = shopRevenue + posRevenue + fbRevenue + teeRevenue + duesRevenue + tournamentRevenue + leagueRevenue;

    res.json({
      period: { from: fromDate.toISOString(), to: toDate.toISOString(), granularity },
      summary: {
        totalRevenue,
        channels: {
          shop: { revenue: shopRevenue, orders: shopOrderCount, aov: +shopAov.toFixed(2), refunds: shopRefundCount, refundRate: +refundRate.toFixed(2) },
          pos: { revenue: posRevenue, orders: posOrderCount, aov: +posAov.toFixed(2) },
          fb: { revenue: fbRevenue },
          teeTimes: { revenue: teeRevenue },
          memberships: { revenue: duesRevenue },
          tournament: { revenue: tournamentRevenue },
          league: { revenue: leagueRevenue, members: Number(leagueData[0]?.memberCount ?? 0) },
        },
      },
      revenueTrend,
      topProducts: {
        shop: topShopProducts.map(p => ({
          name: p.productName,
          units: Number(p.unitsSold ?? 0),
          revenue: parseFloat(p.revenue ?? "0"),
        })),
        pos: topPosItems.map(p => ({
          name: p.productName,
          units: Number(p.unitsSold ?? 0),
          revenue: parseFloat(p.revenue ?? "0"),
        })),
      },
      gst: {
        overall: {
          totalInvoices: Number(gstSummary[0]?.totalInvoices ?? 0),
          totalTaxable: parseFloat(gstSummary[0]?.totalTaxable ?? "0"),
          cgst: parseFloat(gstSummary[0]?.totalCgst ?? "0"),
          sgst: parseFloat(gstSummary[0]?.totalSgst ?? "0"),
          igst: parseFloat(gstSummary[0]?.totalIgst ?? "0"),
          totalGstCollected:
            parseFloat(gstSummary[0]?.totalCgst ?? "0") +
            parseFloat(gstSummary[0]?.totalSgst ?? "0") +
            parseFloat(gstSummary[0]?.totalIgst ?? "0"),
        },
        byChannel: gstByChannel.map(r => ({
          channel: r.channel,
          cgst: parseFloat(r.cgst ?? "0"),
          sgst: parseFloat(r.sgst ?? "0"),
          igst: parseFloat(r.igst ?? "0"),
          total: parseFloat(r.total ?? "0"),
        })),
        byStateOfSupply: gstByState
          .filter(r => r.stateOfSupply)
          .map(r => ({
            state: r.stateOfSupply,
            cgst: parseFloat(r.cgst ?? "0"),
            sgst: parseFloat(r.sgst ?? "0"),
            igst: parseFloat(r.igst ?? "0"),
          })),
      },
      promotionPerformance: {
        shopDiscountedOrders: Number(shopDiscountData[0]?.discountedOrders ?? 0),
        shopDiscountTotal: +shopDiscountTotal.toFixed(2),
        posDiscountedTransactions: Number(posDiscountData[0]?.discountedTransactions ?? 0),
        posDiscountTotal: +posDiscountTotal.toFixed(2),
        totalDiscountGiven: +totalDiscountGiven.toFixed(2),
        promotionRate: +promotionRate.toFixed(2),
        netRevenue: +(shopRevenue + posRevenue).toFixed(2),
      },
      staffPerformance: staffPerf.map(s => ({
        userId: s.staffUserId,
        name: s.staffName ?? `Staff #${s.staffUserId}`,
        salesCount: Number(s.salesCount ?? 0),
        totalRevenue: parseFloat(s.totalRevenue ?? "0"),
      })),
    });
  } catch (err) {
    logger.error({ err }, "[commerce-analytics] query failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

export default router;
