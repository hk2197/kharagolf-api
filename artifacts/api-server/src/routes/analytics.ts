/**
 * Business Intelligence & Analytics API
 *
 * GET  /organizations/:orgId/analytics/kpi                 - KPI dashboard summary
 * GET  /organizations/:orgId/analytics/reports             - List pre-built reports
 * GET  /organizations/:orgId/analytics/reports/:reportId   - Run a pre-built report
 * POST /organizations/:orgId/analytics/custom              - Run a custom report query
 * GET  /organizations/:orgId/analytics/schedules           - List scheduled reports
 * POST /organizations/:orgId/analytics/schedules           - Create scheduled report
 * DELETE /organizations/:orgId/analytics/schedules/:id     - Delete scheduled report
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  organizationsTable,
  orgMembershipsTable,
  clubMembersTable,
  memberSubscriptionsTable,
  posTransactionsTable,
  posTransactionItemsTable,
  teeBookingsTable,
  courseTeeSlotTable,
  lessonBookingsTable,
  fbOrdersTable,
  fbOrderItemsTable,
  eventBookingsTable,
  tournamentsTable,
  playersTable,
  shopOrdersTable,
  shopProductsTable,
  appUsersTable,
  profileShareEventsTable,
  profileShareDailyAggregatesTable,
  badgeShareEventsTable,
  badgeShareDailyAggregatesTable,
  badgeShareVisitEventsTable,
  badgeShareVisitDailyAggregatesTable,
  analyticsEventsTable,
  analyticsEventMetadataTable,
  analyticsEventMetadataHistoryTable,
  analyticsEventCategoryOrderTable,
} from "@workspace/db";
import {
  eq,
  and,
  gte,
  lte,
  ne,
  sql,
  desc,
  count,
  sum,
  inArray,
  isNotNull,
} from "drizzle-orm";
import { sendBroadcastEmail } from "../lib/mailer";
import { logger } from "../lib/logger";
import { ALL_BADGES } from "../lib/achievementEngine";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser {
  id: number;
  role?: string;
  organizationId?: number;
}

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  const user = req.user as SessionUser | undefined;
  if (!user) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (user.role === "super_admin") return true;
  if (
    (user.role === "org_admin" || user.role === "tournament_director") &&
    Number(user.organizationId) === orgId
  ) return true;
  const [m] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(
      and(
        eq(orgMembershipsTable.organizationId, orgId),
        eq(orgMembershipsTable.userId, user.id),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
      ),
    );
  if (!m) { res.status(403).json({ error: "Admin access required" }); return false; }
  return true;
}

function dateRange(period: string): { from: Date; to: Date; prevFrom: Date; prevTo: Date } {
  const now = new Date();
  let from: Date;
  let to: Date = new Date(now);

  switch (period) {
    case "today":
      from = new Date(now);
      from.setHours(0, 0, 0, 0);
      to = new Date(now);
      to.setHours(23, 59, 59, 999);
      break;
    case "week":
      from = new Date(now);
      from.setDate(from.getDate() - 7);
      break;
    case "month":
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      break;
    case "quarter":
      {
        const q = Math.floor(now.getMonth() / 3);
        from = new Date(now.getFullYear(), q * 3, 1);
        to = new Date(now.getFullYear(), q * 3 + 3, 0, 23, 59, 59, 999);
      }
      break;
    case "year":
      from = new Date(now.getFullYear(), 0, 1);
      to = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      break;
    default:
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  const diffMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - diffMs);

  return { from, to, prevFrom, prevTo };
}

// ─── KPI DASHBOARD ────────────────────────────────────────────────────────────

router.get("/kpi", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const period = String(req.query.period ?? "month");
  const { from, to, prevFrom, prevTo } = dateRange(period);

  try {
    const [
      activeMembers,
      prevActiveMembers,
      posRevenue,
      prevPosRevenue,
      teeBookingsCount,
      prevTeeBookingsCount,
      teeBookingRevenue,
      prevTeeBookingRevenue,
      lessonRevenue,
      prevLessonRevenue,
      fbRevenue,
      prevFbRevenue,
      eventRevenue,
      prevEventRevenue,
      shopRevenue,
      prevShopRevenue,
      totalTeeSlots,
      bookedTeeSlots,
      pendingEvents,
      tournamentsCount,
      tournamentPlayers,
      topShopItems,
    ] = await Promise.all([
      // Active members now
      db.select({ count: count() }).from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, orgId),
          eq(clubMembersTable.subscriptionStatus, "active"),
        )),
      // Active members prev period
      db.select({ count: count() }).from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, orgId),
          eq(clubMembersTable.subscriptionStatus, "active"),
          lte(clubMembersTable.createdAt, prevTo),
        )),
      // POS revenue
      db.select({ total: sum(posTransactionsTable.totalAmount) })
        .from(posTransactionsTable)
        .where(and(
          eq(posTransactionsTable.organizationId, orgId),
          eq(posTransactionsTable.status, "completed"),
          gte(posTransactionsTable.transactedAt, from),
          lte(posTransactionsTable.transactedAt, to),
        )),
      db.select({ total: sum(posTransactionsTable.totalAmount) })
        .from(posTransactionsTable)
        .where(and(
          eq(posTransactionsTable.organizationId, orgId),
          eq(posTransactionsTable.status, "completed"),
          gte(posTransactionsTable.transactedAt, prevFrom),
          lte(posTransactionsTable.transactedAt, prevTo),
        )),
      // Tee bookings count
      db.select({ count: count() }).from(teeBookingsTable)
        .where(and(
          eq(teeBookingsTable.organizationId, orgId),
          inArray(teeBookingsTable.status, ["confirmed", "completed"]),
          gte(teeBookingsTable.createdAt, from),
          lte(teeBookingsTable.createdAt, to),
        )),
      db.select({ count: count() }).from(teeBookingsTable)
        .where(and(
          eq(teeBookingsTable.organizationId, orgId),
          inArray(teeBookingsTable.status, ["confirmed", "completed"]),
          gte(teeBookingsTable.createdAt, prevFrom),
          lte(teeBookingsTable.createdAt, prevTo),
        )),
      // Tee booking revenue
      db.select({ total: sum(teeBookingsTable.totalAmount) })
        .from(teeBookingsTable)
        .where(and(
          eq(teeBookingsTable.organizationId, orgId),
          inArray(teeBookingsTable.status, ["confirmed", "completed"]),
          gte(teeBookingsTable.createdAt, from),
          lte(teeBookingsTable.createdAt, to),
        )),
      db.select({ total: sum(teeBookingsTable.totalAmount) })
        .from(teeBookingsTable)
        .where(and(
          eq(teeBookingsTable.organizationId, orgId),
          inArray(teeBookingsTable.status, ["confirmed", "completed"]),
          gte(teeBookingsTable.createdAt, prevFrom),
          lte(teeBookingsTable.createdAt, prevTo),
        )),
      // Lesson revenue
      db.select({ total: sql<string>`coalesce(sum(${lessonBookingsTable.amountPaise}), 0)` })
        .from(lessonBookingsTable)
        .where(and(
          eq(lessonBookingsTable.organizationId, orgId),
          inArray(lessonBookingsTable.status, ["confirmed", "completed"]),
          eq(lessonBookingsTable.paymentStatus, "paid"),
          gte(lessonBookingsTable.createdAt, from),
          lte(lessonBookingsTable.createdAt, to),
        )),
      db.select({ total: sql<string>`coalesce(sum(${lessonBookingsTable.amountPaise}), 0)` })
        .from(lessonBookingsTable)
        .where(and(
          eq(lessonBookingsTable.organizationId, orgId),
          inArray(lessonBookingsTable.status, ["confirmed", "completed"]),
          eq(lessonBookingsTable.paymentStatus, "paid"),
          gte(lessonBookingsTable.createdAt, prevFrom),
          lte(lessonBookingsTable.createdAt, prevTo),
        )),
      // F&B revenue
      db.select({ total: sum(fbOrdersTable.totalAmount) })
        .from(fbOrdersTable)
        .where(and(
          eq(fbOrdersTable.organizationId, orgId),
          eq(fbOrdersTable.paymentStatus, "paid"),
          gte(fbOrdersTable.createdAt, from),
          lte(fbOrdersTable.createdAt, to),
        )),
      db.select({ total: sum(fbOrdersTable.totalAmount) })
        .from(fbOrdersTable)
        .where(and(
          eq(fbOrdersTable.organizationId, orgId),
          eq(fbOrdersTable.paymentStatus, "paid"),
          gte(fbOrdersTable.createdAt, prevFrom),
          lte(fbOrdersTable.createdAt, prevTo),
        )),
      // Event revenue (confirmed/invoiced bookings)
      db.select({ total: sum(eventBookingsTable.totalAmount) })
        .from(eventBookingsTable)
        .where(and(
          eq(eventBookingsTable.organizationId, orgId),
          inArray(eventBookingsTable.status, ["confirmed", "completed"] as never[]),
          gte(eventBookingsTable.createdAt, from),
          lte(eventBookingsTable.createdAt, to),
        )),
      db.select({ total: sum(eventBookingsTable.totalAmount) })
        .from(eventBookingsTable)
        .where(and(
          eq(eventBookingsTable.organizationId, orgId),
          inArray(eventBookingsTable.status, ["confirmed", "completed"] as never[]),
          gte(eventBookingsTable.createdAt, prevFrom),
          lte(eventBookingsTable.createdAt, prevTo),
        )),
      // Shop revenue
      db.select({ total: sum(shopOrdersTable.totalAmount) })
        .from(shopOrdersTable)
        .where(and(
          eq(shopOrdersTable.organizationId, orgId),
          inArray(shopOrdersTable.status, ["processing", "shipped", "delivered"] as never[]),
          gte(shopOrdersTable.createdAt, from),
          lte(shopOrdersTable.createdAt, to),
        )),
      db.select({ total: sum(shopOrdersTable.totalAmount) })
        .from(shopOrdersTable)
        .where(and(
          eq(shopOrdersTable.organizationId, orgId),
          inArray(shopOrdersTable.status, ["processing", "shipped", "delivered"] as never[]),
          gte(shopOrdersTable.createdAt, prevFrom),
          lte(shopOrdersTable.createdAt, prevTo),
        )),
      // Tee slot utilisation — total slots in period
      db.select({ count: count() }).from(courseTeeSlotTable)
        .where(and(
          eq(courseTeeSlotTable.organizationId, orgId),
          gte(courseTeeSlotTable.slotDate, from.toISOString().slice(0, 10) as never),
          lte(courseTeeSlotTable.slotDate, to.toISOString().slice(0, 10) as never),
        )),
      // Booked slots
      db.select({ count: count() }).from(courseTeeSlotTable)
        .where(and(
          eq(courseTeeSlotTable.organizationId, orgId),
          eq(courseTeeSlotTable.status, "booked"),
          gte(courseTeeSlotTable.slotDate, from.toISOString().slice(0, 10) as never),
          lte(courseTeeSlotTable.slotDate, to.toISOString().slice(0, 10) as never),
        )),
      // Pending event enquiries
      db.select({ count: count() }).from(eventBookingsTable)
        .where(and(
          eq(eventBookingsTable.organizationId, orgId),
          inArray(eventBookingsTable.status, ["enquiry", "quote_sent"] as never[]),
        )),
      // Tournaments
      db.select({ count: count() }).from(tournamentsTable)
        .where(and(
          eq(tournamentsTable.organizationId, orgId),
          gte(tournamentsTable.startDate, from),
          lte(tournamentsTable.startDate, to),
        )),
      // Tournament players
      db.select({ count: count() }).from(playersTable)
        .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
        .where(and(
          eq(tournamentsTable.organizationId, orgId),
          gte(tournamentsTable.startDate, from),
          lte(tournamentsTable.startDate, to),
        )),
      // Top-selling POS items
      db.select({
        productName: posTransactionItemsTable.productName,
        category: posTransactionItemsTable.category,
        totalQty: sum(posTransactionItemsTable.quantity),
        totalRevenue: sum(posTransactionItemsTable.lineTotal),
      })
        .from(posTransactionItemsTable)
        .innerJoin(posTransactionsTable, eq(posTransactionItemsTable.transactionId, posTransactionsTable.id))
        .where(and(
          eq(posTransactionsTable.organizationId, orgId),
          eq(posTransactionsTable.status, "completed"),
          gte(posTransactionsTable.transactedAt, from),
          lte(posTransactionsTable.transactedAt, to),
        ))
        .groupBy(posTransactionItemsTable.productName, posTransactionItemsTable.category)
        .orderBy(desc(sum(posTransactionItemsTable.lineTotal)))
        .limit(5),
    ]);

    const posRev = Number(posRevenue[0]?.total ?? 0);
    const prevPosRev = Number(prevPosRevenue[0]?.total ?? 0);
    const teeRev = Number(teeBookingRevenue[0]?.total ?? 0);
    const prevTeeRev = Number(prevTeeBookingRevenue[0]?.total ?? 0);
    const lessonRev = Number(lessonRevenue[0]?.total ?? 0) / 100;
    const prevLessonRev = Number(prevLessonRevenue[0]?.total ?? 0) / 100;
    const fbRev = Number(fbRevenue[0]?.total ?? 0);
    const prevFbRev = Number(prevFbRevenue[0]?.total ?? 0);
    const eventRev = Number(eventRevenue[0]?.total ?? 0);
    const prevEventRev = Number(prevEventRevenue[0]?.total ?? 0);
    const shopRev = Number(shopRevenue[0]?.total ?? 0);
    const prevShopRev = Number(prevShopRevenue[0]?.total ?? 0);

    const totalRevenue = posRev + teeRev + lessonRev + fbRev + eventRev + shopRev;
    const prevTotalRevenue = prevPosRev + prevTeeRev + prevLessonRev + prevFbRev + prevEventRev + prevShopRev;

    const totalSlots = Number(totalTeeSlots[0]?.count ?? 0);
    const booked = Number(bookedTeeSlots[0]?.count ?? 0);
    const utilisation = totalSlots > 0 ? Math.round((booked / totalSlots) * 100) : 0;

    function pctChange(curr: number, prev: number): number | null {
      if (prev === 0) return curr > 0 ? 100 : null;
      return Math.round(((curr - prev) / prev) * 100);
    }

    res.json({
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      kpis: {
        totalRevenue: {
          value: totalRevenue,
          prevValue: prevTotalRevenue,
          change: pctChange(totalRevenue, prevTotalRevenue),
          breakdown: {
            proShop: posRev,
            teeBookings: teeRev,
            lessons: lessonRev,
            fb: fbRev,
            events: eventRev,
            shop: shopRev,
          },
        },
        activeMembers: {
          value: Number(activeMembers[0]?.count ?? 0),
          prevValue: Number(prevActiveMembers[0]?.count ?? 0),
          change: pctChange(
            Number(activeMembers[0]?.count ?? 0),
            Number(prevActiveMembers[0]?.count ?? 0),
          ),
        },
        teeSheetUtilisation: {
          value: utilisation,
          totalSlots,
          bookedSlots: booked,
        },
        teeBookings: {
          value: Number(teeBookingsCount[0]?.count ?? 0),
          prevValue: Number(prevTeeBookingsCount[0]?.count ?? 0),
          change: pctChange(
            Number(teeBookingsCount[0]?.count ?? 0),
            Number(prevTeeBookingsCount[0]?.count ?? 0),
          ),
        },
        tournaments: {
          value: Number(tournamentsCount[0]?.count ?? 0),
          players: Number(tournamentPlayers[0]?.count ?? 0),
        },
        pendingEventEnquiries: {
          value: Number(pendingEvents[0]?.count ?? 0),
        },
      },
      topShopItems: topShopItems.map((i) => ({
        name: i.productName,
        category: i.category,
        qty: Number(i.totalQty ?? 0),
        revenue: Number(i.totalRevenue ?? 0),
      })),
    });
  } catch (err) {
    logger.error({ err }, "[analytics] KPI error");
    res.status(500).json({ error: "Failed to compute KPIs" });
  }
});

// ─── PRE-BUILT REPORTS LIBRARY ────────────────────────────────────────────────

const PRE_BUILT_REPORTS = [
  { id: "membership-growth", name: "Membership Growth & Churn", category: "Members", description: "Monthly active member count, new joins, and churned members over time." },
  { id: "revenue-by-department", name: "Revenue by Department", category: "Finance", description: "Breakdown of revenue across Pro Shop, Tee Bookings, Lessons, F&B, Events, and Online Shop." },
  { id: "tee-fill-rates", name: "Tee Time Fill Rates", category: "Operations", description: "Daily tee sheet utilisation — booked vs total slots." },
  { id: "lesson-bookings", name: "Lesson Bookings Report", category: "Lessons", description: "Lesson booking volume, revenue, and status by period." },
  { id: "fb-orders", name: "F&B Orders Report", category: "F&B", description: "Food & Beverage order volume and revenue over time." },
  { id: "event-income", name: "Event & Function Income", category: "Events", description: "Event booking pipeline, confirmed revenue, and pending enquiries." },
  { id: "tournament-participation", name: "Tournament Participation", category: "Tournaments", description: "Player registration counts, paid vs unpaid, by tournament." },
  { id: "pos-top-sellers", name: "Pro Shop Top Sellers", category: "Pro Shop", description: "Top products by quantity sold and revenue in the Pro Shop POS." },
  { id: "membership-revenue", name: "Membership Subscription Revenue", category: "Finance", description: "Annual / monthly membership subscription revenue by tier." },
  { id: "revenue-comparison", name: "Year-on-Year Comparison", category: "Finance", description: "Compare revenue across all departments for current vs same period last year." },
];

router.get("/reports", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  res.json({ reports: PRE_BUILT_REPORTS });
});

router.get("/reports/:reportId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { reportId } = (req.params as Record<string, string>);
  const period = String(req.query.period ?? "month");
  const { from, to, prevFrom, prevTo } = dateRange(period);

  try {
    switch (reportId) {
      case "membership-growth": {
        const rows = await db.execute(sql`
          WITH months AS (
            SELECT generate_series(
              date_trunc('month', ${from}::timestamptz),
              date_trunc('month', ${to}::timestamptz),
              '1 month'::interval
            ) AS month
          )
          SELECT
            to_char(m.month, 'Mon YYYY') AS label,
            COUNT(cm.id) FILTER (WHERE cm.created_at >= m.month AND cm.created_at < m.month + INTERVAL '1 month') AS new_members,
            COUNT(cm.id) FILTER (WHERE cm.status = 'active' AND cm.created_at <= m.month + INTERVAL '1 month') AS active_total,
            COUNT(cm.id) FILTER (WHERE cm.status = 'expired' AND cm.created_at >= m.month AND cm.created_at < m.month + INTERVAL '1 month') AS churned
          FROM months m
          LEFT JOIN club_members cm ON cm.organization_id = ${orgId}
          GROUP BY m.month
          ORDER BY m.month
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "revenue-by-department": {
        const [pos, tee, lesson, fb, event, shop] = await Promise.all([
          db.select({ total: sum(posTransactionsTable.totalAmount) })
            .from(posTransactionsTable)
            .where(and(eq(posTransactionsTable.organizationId, orgId), eq(posTransactionsTable.status, "completed"), gte(posTransactionsTable.transactedAt, from), lte(posTransactionsTable.transactedAt, to))),
          db.select({ total: sum(teeBookingsTable.totalAmount) })
            .from(teeBookingsTable)
            .where(and(eq(teeBookingsTable.organizationId, orgId), inArray(teeBookingsTable.status, ["confirmed", "completed"]), gte(teeBookingsTable.createdAt, from), lte(teeBookingsTable.createdAt, to))),
          db.select({ total: sql<string>`coalesce(sum(${lessonBookingsTable.amountPaise}), 0)` })
            .from(lessonBookingsTable)
            .where(and(eq(lessonBookingsTable.organizationId, orgId), eq(lessonBookingsTable.paymentStatus, "paid"), gte(lessonBookingsTable.createdAt, from), lte(lessonBookingsTable.createdAt, to))),
          db.select({ total: sum(fbOrdersTable.totalAmount) })
            .from(fbOrdersTable)
            .where(and(eq(fbOrdersTable.organizationId, orgId), eq(fbOrdersTable.paymentStatus, "paid"), gte(fbOrdersTable.createdAt, from), lte(fbOrdersTable.createdAt, to))),
          db.select({ total: sum(eventBookingsTable.totalAmount) })
            .from(eventBookingsTable)
            .where(and(eq(eventBookingsTable.organizationId, orgId), inArray(eventBookingsTable.status, ["confirmed", "completed"] as never[]), gte(eventBookingsTable.createdAt, from), lte(eventBookingsTable.createdAt, to))),
          db.select({ total: sum(shopOrdersTable.totalAmount) })
            .from(shopOrdersTable)
            .where(and(eq(shopOrdersTable.organizationId, orgId), inArray(shopOrdersTable.status, ["processing", "shipped", "delivered"] as never[]), gte(shopOrdersTable.createdAt, from), lte(shopOrdersTable.createdAt, to))),
        ]);
        res.json({
          reportId, period,
          data: [
            { department: "Pro Shop (POS)", revenue: Number(pos[0]?.total ?? 0) },
            { department: "Tee Bookings", revenue: Number(tee[0]?.total ?? 0) },
            { department: "Lessons", revenue: Number(lesson[0]?.total ?? 0) / 100 },
            { department: "Food & Beverage", revenue: Number(fb[0]?.total ?? 0) },
            { department: "Events & Functions", revenue: Number(event[0]?.total ?? 0) },
            { department: "Online Shop", revenue: Number(shop[0]?.total ?? 0) },
          ],
        });
        break;
      }

      case "tee-fill-rates": {
        const rows = await db.execute(sql`
          SELECT
            to_char(slot_date::date, 'YYYY-MM-DD') AS date,
            COUNT(*) AS total_slots,
            COUNT(*) FILTER (WHERE status = 'booked') AS booked_slots,
            ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'booked') / NULLIF(COUNT(*), 0), 1) AS fill_rate
          FROM course_tee_slots
          WHERE organization_id = ${orgId}
            AND slot_date >= ${from.toISOString().slice(0, 10)}
            AND slot_date <= ${to.toISOString().slice(0, 10)}
          GROUP BY slot_date
          ORDER BY slot_date
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "lesson-bookings": {
        const rows = await db.execute(sql`
          SELECT
            to_char(date_trunc('month', created_at), 'Mon YYYY') AS label,
            COUNT(*) AS bookings,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed,
            COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
            COALESCE(SUM(amount_paise) FILTER (WHERE payment_status = 'paid'), 0) / 100.0 AS revenue
          FROM lesson_bookings
          WHERE organization_id = ${orgId}
            AND created_at >= ${from}
            AND created_at <= ${to}
          GROUP BY date_trunc('month', created_at)
          ORDER BY date_trunc('month', created_at)
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "fb-orders": {
        const rows = await db.execute(sql`
          SELECT
            to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS date,
            COUNT(*) AS orders,
            COALESCE(SUM(total_amount) FILTER (WHERE payment_status = 'paid'), 0)::numeric AS revenue
          FROM fb_orders
          WHERE organization_id = ${orgId}
            AND created_at >= ${from}
            AND created_at <= ${to}
          GROUP BY date_trunc('day', created_at)
          ORDER BY date_trunc('day', created_at)
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "event-income": {
        const rows = await db.execute(sql`
          SELECT
            status,
            COUNT(*) AS count,
            COALESCE(SUM(total_amount), 0)::numeric AS total_revenue,
            COALESCE(SUM(deposit_amount) FILTER (WHERE deposit_paid = true), 0)::numeric AS deposits_collected
          FROM event_bookings
          WHERE organization_id = ${orgId}
            AND created_at >= ${from}
            AND created_at <= ${to}
          GROUP BY status
          ORDER BY total_revenue DESC
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "tournament-participation": {
        const rows = await db.execute(sql`
          SELECT
            t.name AS tournament,
            t.start_date::date AS date,
            t.format,
            COUNT(p.id) AS total_players,
            COUNT(p.id) FILTER (WHERE p.payment_status = 'paid') AS paid_players
          FROM tournaments t
          LEFT JOIN players p ON p.tournament_id = t.id
          WHERE t.organization_id = ${orgId}
            AND t.start_date >= ${from}
            AND t.start_date <= ${to}
          GROUP BY t.id, t.name, t.start_date, t.format
          ORDER BY t.start_date DESC
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "pos-top-sellers": {
        const rows = await db.execute(sql`
          SELECT
            pti.product_name AS name,
            pti.category,
            SUM(pti.quantity)::int AS total_qty,
            SUM(pti.line_total)::numeric AS total_revenue
          FROM pos_transaction_items pti
          JOIN pos_transactions pt ON pt.id = pti.transaction_id
          WHERE pt.organization_id = ${orgId}
            AND pt.status = 'completed'
            AND pt.transacted_at >= ${from}
            AND pt.transacted_at <= ${to}
          GROUP BY pti.product_name, pti.category
          ORDER BY total_revenue DESC
          LIMIT 20
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "membership-revenue": {
        const rows = await db.execute(sql`
          SELECT
            mt.name AS tier,
            COUNT(ms.id) AS subscriptions,
            COALESCE(SUM(mt.annual_fee), 0)::numeric AS annual_revenue,
            COALESCE(SUM(mt.monthly_fee), 0)::numeric AS monthly_revenue
          FROM club_members cm
          JOIN membership_tiers mt ON mt.id = cm.tier_id
          LEFT JOIN member_subscriptions ms ON ms.club_member_id = cm.id AND ms.status = 'active'
          WHERE cm.organization_id = ${orgId}
            AND cm.status = 'active'
          GROUP BY mt.id, mt.name
          ORDER BY annual_revenue DESC
        `);
        res.json({ reportId, period, data: rows.rows });
        break;
      }

      case "revenue-comparison": {
        // Same period last year
        const lastYearFrom = new Date(from);
        lastYearFrom.setFullYear(lastYearFrom.getFullYear() - 1);
        const lastYearTo = new Date(to);
        lastYearTo.setFullYear(lastYearTo.getFullYear() - 1);

        const [curr, prev2] = await Promise.all([
          db.select({ total: sum(posTransactionsTable.totalAmount) }).from(posTransactionsTable)
            .where(and(eq(posTransactionsTable.organizationId, orgId), eq(posTransactionsTable.status, "completed"), gte(posTransactionsTable.transactedAt, from), lte(posTransactionsTable.transactedAt, to))),
          db.select({ total: sum(posTransactionsTable.totalAmount) }).from(posTransactionsTable)
            .where(and(eq(posTransactionsTable.organizationId, orgId), eq(posTransactionsTable.status, "completed"), gte(posTransactionsTable.transactedAt, lastYearFrom), lte(posTransactionsTable.transactedAt, lastYearTo))),
        ]);
        res.json({
          reportId, period,
          data: {
            current: { label: "This Period", revenue: Number(curr[0]?.total ?? 0) },
            previous: { label: "Same Period Last Year", revenue: Number(prev2[0]?.total ?? 0) },
          },
        });
        break;
      }

      default:
        res.status(404).json({ error: "Report not found" });
    }
  } catch (err) {
    logger.error({ err, reportId }, "[analytics] report error");
    res.status(500).json({ error: "Failed to run report" });
  }
});

// ─── CUSTOM REPORT BUILDER ────────────────────────────────────────────────────

interface CustomReportRequest {
  dataSource: "pos_transactions" | "tee_bookings" | "lesson_bookings" | "fb_orders" | "event_bookings" | "club_members" | "tournaments";
  metric: "count" | "sum_revenue" | "avg_revenue";
  groupBy: "day" | "week" | "month" | "quarter";
  from: string;
  to: string;
  filters?: Record<string, string>;
}

router.post("/custom", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { dataSource, metric, groupBy, from: fromStr, to: toStr, filters } = req.body as CustomReportRequest;

  const from = new Date(fromStr);
  const to = new Date(toStr);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    res.status(400).json({ error: "Invalid date range" }); return;
  }

  const groupExpr: Record<string, string> = {
    day: "YYYY-MM-DD",
    week: "IYYY-IW",
    month: "Mon YYYY",
    quarter: "YYYY \"Q\"Q",
  };

  const fmt = groupExpr[groupBy] ?? groupExpr.month;

  try {
    let rows: unknown[];

    switch (dataSource) {
      case "pos_transactions": {
        const metricExpr = metric === "count"
          ? sql`COUNT(*)`
          : metric === "sum_revenue"
            ? sql`COALESCE(SUM(total_amount), 0)::numeric`
            : sql`COALESCE(AVG(total_amount), 0)::numeric`;
        const res2 = await db.execute(sql`
          SELECT to_char(transacted_at, ${fmt}) AS label, ${metricExpr} AS value
          FROM pos_transactions
          WHERE organization_id = ${orgId} AND status = 'completed'
            AND transacted_at >= ${from} AND transacted_at <= ${to}
          GROUP BY to_char(transacted_at, ${fmt})
          ORDER BY MIN(transacted_at)
        `);
        rows = res2.rows;
        break;
      }
      case "tee_bookings": {
        const metricExpr = metric === "count"
          ? sql`COUNT(*)`
          : sql`COALESCE(SUM(total_amount), 0)::numeric`;
        const res2 = await db.execute(sql`
          SELECT to_char(created_at, ${fmt}) AS label, ${metricExpr} AS value
          FROM tee_bookings
          WHERE organization_id = ${orgId} AND status IN ('confirmed','checked_in','completed')
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY to_char(created_at, ${fmt})
          ORDER BY MIN(created_at)
        `);
        rows = res2.rows;
        break;
      }
      case "lesson_bookings": {
        const metricExpr = metric === "count"
          ? sql`COUNT(*)`
          : sql`COALESCE(SUM(amount_paise), 0) / 100.0`;
        const res2 = await db.execute(sql`
          SELECT to_char(created_at, ${fmt}) AS label, ${metricExpr} AS value
          FROM lesson_bookings
          WHERE organization_id = ${orgId}
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY to_char(created_at, ${fmt})
          ORDER BY MIN(created_at)
        `);
        rows = res2.rows;
        break;
      }
      case "fb_orders": {
        const metricExpr = metric === "count"
          ? sql`COUNT(*)`
          : sql`COALESCE(SUM(total_amount), 0)::numeric`;
        const res2 = await db.execute(sql`
          SELECT to_char(created_at, ${fmt}) AS label, ${metricExpr} AS value
          FROM fb_orders
          WHERE organization_id = ${orgId}
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY to_char(created_at, ${fmt})
          ORDER BY MIN(created_at)
        `);
        rows = res2.rows;
        break;
      }
      case "event_bookings": {
        const metricExpr = metric === "count"
          ? sql`COUNT(*)`
          : sql`COALESCE(SUM(total_amount), 0)::numeric`;
        const res2 = await db.execute(sql`
          SELECT to_char(created_at, ${fmt}) AS label, ${metricExpr} AS value
          FROM event_bookings
          WHERE organization_id = ${orgId}
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY to_char(created_at, ${fmt})
          ORDER BY MIN(created_at)
        `);
        rows = res2.rows;
        break;
      }
      case "club_members": {
        const res2 = await db.execute(sql`
          SELECT to_char(created_at, ${fmt}) AS label, COUNT(*) AS value
          FROM club_members
          WHERE organization_id = ${orgId}
            AND created_at >= ${from} AND created_at <= ${to}
          GROUP BY to_char(created_at, ${fmt})
          ORDER BY MIN(created_at)
        `);
        rows = res2.rows;
        break;
      }
      case "tournaments": {
        const res2 = await db.execute(sql`
          SELECT to_char(start_date, ${fmt}) AS label, COUNT(*) AS value
          FROM tournaments
          WHERE organization_id = ${orgId}
            AND start_date >= ${from} AND start_date <= ${to}
          GROUP BY to_char(start_date, ${fmt})
          ORDER BY MIN(start_date)
        `);
        rows = res2.rows;
        break;
      }
      default:
        res.status(400).json({ error: "Invalid data source" });
        return;
    }

    res.json({ dataSource, metric, groupBy, from: fromStr, to: toStr, rows });
  } catch (err) {
    logger.error({ err }, "[analytics] custom report error");
    res.status(500).json({ error: "Failed to run custom report" });
  }
});

// ─── SCHEDULED REPORTS (stored in-memory per server process) ─────────────────
// In production these would persist to the DB, but for this implementation
// we use a simple in-memory store with server-side cron.

interface ScheduledReport {
  id: string;
  orgId: number;
  reportId: string;
  reportName: string;
  frequency: "daily" | "weekly" | "monthly";
  recipientEmail: string;
  recipientName: string;
  period: string;
  createdAt: string;
  nextRunAt: string;
  lastRunAt: string | null;
}

// Module-level store (survives hot reloads in dev via node module cache)
const scheduledReports: Map<string, ScheduledReport> = new Map();

function nextRunDate(frequency: string): Date {
  const d = new Date();
  switch (frequency) {
    case "daily":
      d.setDate(d.getDate() + 1);
      d.setHours(7, 0, 0, 0);
      break;
    case "weekly":
      d.setDate(d.getDate() + (7 - d.getDay()));
      d.setHours(7, 0, 0, 0);
      break;
    case "monthly":
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(7, 0, 0, 0);
      break;
  }
  return d;
}

router.get("/schedules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const list = Array.from(scheduledReports.values()).filter((s) => s.orgId === orgId);
  res.json({ schedules: list });
});

router.post("/schedules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { reportId, frequency, recipientEmail, recipientName, period } = req.body as {
    reportId: string;
    frequency: "daily" | "weekly" | "monthly";
    recipientEmail: string;
    recipientName?: string;
    period?: string;
  };

  if (!reportId || !frequency || !recipientEmail) {
    res.status(400).json({ error: "reportId, frequency, and recipientEmail are required" });
    return;
  }
  if (!["daily", "weekly", "monthly"].includes(frequency)) {
    res.status(400).json({ error: "frequency must be daily, weekly, or monthly" });
    return;
  }
  const report = PRE_BUILT_REPORTS.find((r) => r.id === reportId);
  if (!report) { { res.status(404).json({ error: "Report not found" }); return; } }

  const id = `${orgId}-${reportId}-${Date.now()}`;
  const schedule: ScheduledReport = {
    id,
    orgId,
    reportId,
    reportName: report.name,
    frequency,
    recipientEmail,
    recipientName: recipientName ?? "Admin",
    period: period ?? "month",
    createdAt: new Date().toISOString(),
    nextRunAt: nextRunDate(frequency).toISOString(),
    lastRunAt: null,
  };
  scheduledReports.set(id, schedule);

  logger.info({ id, reportId, frequency, recipientEmail }, "[analytics] scheduled report created");
  res.status(201).json({ schedule });
});

router.delete("/schedules/:scheduleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { scheduleId } = (req.params as Record<string, string>);
  const schedule = scheduledReports.get(scheduleId);
  if (!schedule || schedule.orgId !== orgId) {
    res.status(404).json({ error: "Schedule not found" }); return;
  }
  scheduledReports.delete(scheduleId);
  res.json({ ok: true });
});

// ─── SCHEDULED REPORT RUNNER (called from cron) ───────────────────────────────

export async function runScheduledReports(): Promise<void> {
  const now = new Date();
  for (const [id, schedule] of scheduledReports) {
    if (new Date(schedule.nextRunAt) > now) continue;

    try {
      // Build a simple summary email for the report
      const { from, to } = dateRange(schedule.period);
      const subject = `${schedule.reportName} — Scheduled Report (${schedule.frequency})`;
      const body = `Hi ${schedule.recipientName},\n\nYour scheduled report "${schedule.reportName}" is ready.\n\nPeriod: ${from.toDateString()} to ${to.toDateString()}\n\nPlease log in to KHARAGOLF to view the full report and export data.\n\nThis report runs ${schedule.frequency}.\n\nKHARAGOLF Analytics`;

      await sendBroadcastEmail(
        schedule.recipientEmail,
        schedule.recipientName,
        subject,
        body,
        "KHARAGOLF",
      );

      scheduledReports.set(id, {
        ...schedule,
        lastRunAt: now.toISOString(),
        nextRunAt: nextRunDate(schedule.frequency).toISOString(),
      });
      logger.info({ id, reportId: schedule.reportId }, "[analytics] scheduled report sent");
    } catch (err) {
      logger.error({ err, id }, "[analytics] scheduled report send failed");
    }
  }
}

// ─── PROFILE SHARE LEADERBOARD (Task #786) ───────────────────────────────────
// Aggregates `profile_share_events` rows (logged by the privacy/share UI) into
// a top-N leaderboard of members in this org who are driving the most profile
// traffic, broken down by share method (copy / web_share / native_share /
// qr_open). Drives the "Profile Share Leaderboard" panel in the analytics
// dashboard so product can see which members + methods deserve more growth
// investment. No new event firing — we just read what's already stored.
router.get("/profile-share-leaderboard", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const period = String(req.query.period ?? "month");
  const { from, to } = dateRange(period);
  const limitRaw = parseInt(String(req.query.limit ?? "25"), 10);
  const limit = Math.min(Math.max(isNaN(limitRaw) ? 25 : limitRaw, 1), 100);

  try {
    // Task #1259 — Counts come from two places after the rollup job runs:
    // the raw `profile_share_events` table (recent rows) and the
    // `profile_share_daily_aggregates` table (older rows summarised per
    // day). The rollup job deletes events once they're aggregated, so
    // there's no double-count on the boundary. Aggregate rows are
    // bucketed at UTC midnight; the period range filter on `day` matches
    // whole days, which is the same granularity admins ask for anyway
    // (week / month / quarter / year). Both tables are scoped to org via
    // the same join through appUsersTable.id.
    const [rawRows, aggRows] = await Promise.all([
      db
        .select({
          userId: profileShareEventsTable.userId,
          method: profileShareEventsTable.method,
          n: count(profileShareEventsTable.id),
        })
        .from(profileShareEventsTable)
        .innerJoin(appUsersTable, eq(appUsersTable.id, profileShareEventsTable.userId))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          gte(profileShareEventsTable.createdAt, from),
          lte(profileShareEventsTable.createdAt, to),
        ))
        .groupBy(profileShareEventsTable.userId, profileShareEventsTable.method),
      db
        .select({
          userId: profileShareDailyAggregatesTable.userId,
          method: profileShareDailyAggregatesTable.method,
          n: sql<number>`COALESCE(SUM(${profileShareDailyAggregatesTable.count}), 0)::int`,
        })
        .from(profileShareDailyAggregatesTable)
        .innerJoin(appUsersTable, eq(appUsersTable.id, profileShareDailyAggregatesTable.userId))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          gte(profileShareDailyAggregatesTable.day, from),
          lte(profileShareDailyAggregatesTable.day, to),
        ))
        .groupBy(profileShareDailyAggregatesTable.userId, profileShareDailyAggregatesTable.method),
    ]);
    const perMemberRows = [...rawRows, ...aggRows];

    const byUser = new Map<number, {
      userId: number;
      total: number;
      byMethod: { copy: number; web_share: number; native_share: number; qr_open: number };
    }>();
    const orgByMethod = { copy: 0, web_share: 0, native_share: 0, qr_open: 0 };

    for (const row of perMemberRows) {
      const n = Number(row.n) || 0;
      let entry = byUser.get(row.userId);
      if (!entry) {
        entry = {
          userId: row.userId,
          total: 0,
          byMethod: { copy: 0, web_share: 0, native_share: 0, qr_open: 0 },
        };
        byUser.set(row.userId, entry);
      }
      entry.total += n;
      entry.byMethod[row.method as keyof typeof entry.byMethod] += n;
      orgByMethod[row.method as keyof typeof orgByMethod] += n;
    }

    const sorted = Array.from(byUser.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);

    const userIds = sorted.map(e => e.userId);
    const userRows = userIds.length === 0 ? [] : await db
      .select({
        id: appUsersTable.id,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        publicHandle: appUsersTable.publicHandle,
      })
      .from(appUsersTable)
      .where(inArray(appUsersTable.id, userIds));
    const userById = new Map(userRows.map(u => [u.id, u]));

    const leaderboard = sorted.map(e => {
      const u = userById.get(e.userId);
      return {
        userId: e.userId,
        displayName: u?.displayName ?? u?.username ?? null,
        username: u?.username ?? null,
        publicHandle: u?.publicHandle ?? null,
        total: e.total,
        byMethod: e.byMethod,
      };
    });

    const totalShares =
      orgByMethod.copy + orgByMethod.web_share + orgByMethod.native_share + orgByMethod.qr_open;

    res.json({
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      limit,
      totals: { total: totalShares, byMethod: orgByMethod },
      leaderboard,
    });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] profile-share leaderboard failed");
    res.status(500).json({ error: "Failed to load profile share leaderboard" });
  }
});

// ─── BADGE SHARE LEADERBOARD (Task #926) ─────────────────────────────────────
// Aggregates `badge_share_events` rows into per-badge counts for members of
// this org over the requested period. Drives club-admin dashboards that want
// to see which achievements drive the most viral traffic. Joins handles back
// to org membership so we only count shares of profiles that belong to this
// org. No new event firing — we just read what's already stored. Returns
// totals by method and a per-badge breakdown enriched with badge metadata
// (label/icon/category) so the UI can render without another lookup.
router.get("/badge-share-leaderboard", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const period = String(req.query.period ?? "month");
  const { from, to } = dateRange(period);

  try {
    // Join through appUsersTable (handle → user → org) so a renamed handle
    // still attributes shares to whichever user currently owns it. This
    // matches how `profile-share-leaderboard` scopes events to the org.
    // Task #1096 — Counts come from two places after the rollup job
    // runs: the raw `badge_share_events` table (recent rows) and the
    // `badge_share_daily_aggregates` table (older rows summarised per
    // day). The rollup job deletes events once they're aggregated, so
    // there's no double-count on the boundary. Aggregate rows are
    // bucketed at UTC midnight; the period range filter on `day`
    // matches whole days, which is the same granularity admins ask for
    // anyway (week / month / quarter / year).
    // Task #1798 — also pull per-badge VISIT counts for the same period
    // so we can show admins how each shared badge converted into actual
    // profile/badge-page visits. Visits live in `badge_share_visit_events`,
    // populated by the `/api/public/p/:handle/badge/:type/visit-event`
    // ping fired client-side from the public-badge React page on mount.
    // Crawler hits (Facebook, Slack, etc. link previewers) are stored
    // in-band but excluded from the conversion-rate denominator here so
    // the ratio reflects human eyeballs only.
    const [rawRows, aggRows, visitRows] = await Promise.all([
      db
        .select({
          badgeType: badgeShareEventsTable.badgeType,
          method: badgeShareEventsTable.method,
          n: count(badgeShareEventsTable.id),
        })
        .from(badgeShareEventsTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareEventsTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          gte(badgeShareEventsTable.createdAt, from),
          lte(badgeShareEventsTable.createdAt, to),
        ))
        .groupBy(badgeShareEventsTable.badgeType, badgeShareEventsTable.method),
      db
        .select({
          badgeType: badgeShareDailyAggregatesTable.badgeType,
          method: badgeShareDailyAggregatesTable.method,
          n: sql<number>`COALESCE(SUM(${badgeShareDailyAggregatesTable.count}), 0)::int`,
        })
        .from(badgeShareDailyAggregatesTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareDailyAggregatesTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          gte(badgeShareDailyAggregatesTable.day, from),
          lte(badgeShareDailyAggregatesTable.day, to),
        ))
        .groupBy(badgeShareDailyAggregatesTable.badgeType, badgeShareDailyAggregatesTable.method),
      db
        .select({
          badgeType: badgeShareVisitEventsTable.badgeType,
          source: badgeShareVisitEventsTable.source,
          n: count(badgeShareVisitEventsTable.id),
        })
        .from(badgeShareVisitEventsTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareVisitEventsTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          gte(badgeShareVisitEventsTable.createdAt, from),
          lte(badgeShareVisitEventsTable.createdAt, to),
        ))
        .groupBy(badgeShareVisitEventsTable.badgeType, badgeShareVisitEventsTable.source),
      // Task #2255 — UNION the per-day visit-event aggregate so totals
      // (and the conversion-rate ratio derived from them) stay correct
      // after the rollup deletes raw rows older than 30 days. Grouped
      // by `source` so Task #2254's per-source breakdown survives the
      // rollup boundary; crawler rows are kept here (rather than
      // filtered in SQL) because the controller bucketises them and
      // only excludes them from the conversion-rate denominator.
      db
        .select({
          badgeType: badgeShareVisitDailyAggregatesTable.badgeType,
          source: badgeShareVisitDailyAggregatesTable.source,
          n: sql<number>`COALESCE(SUM(${badgeShareVisitDailyAggregatesTable.count}), 0)::int`,
        })
        .from(badgeShareVisitDailyAggregatesTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareVisitDailyAggregatesTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          gte(badgeShareVisitDailyAggregatesTable.day, from),
          lte(badgeShareVisitDailyAggregatesTable.day, to),
        ))
        .groupBy(badgeShareVisitDailyAggregatesTable.badgeType, badgeShareVisitDailyAggregatesTable.source),
    ]).then(([raw, agg, visit, visitAgg]) => [raw, agg, [...visit, ...visitAgg]] as const);
    const rows = [...rawRows, ...aggRows];

    type MethodCounts = { copy: number; web_share: number; native_share: number };
    const blank = (): MethodCounts => ({ copy: 0, web_share: 0, native_share: 0 });
    type SourceCounts = { web: number; mobile: number; crawler: number; unknown: number };
    const blankSources = (): SourceCounts => ({ web: 0, mobile: 0, crawler: 0, unknown: 0 });
    const orgByMethod = blank();
    const orgVisitsBySource = blankSources();
    const byBadge = new Map<string, { total: number; byMethod: MethodCounts; visits: number; visitsBySource: SourceCounts }>();

    for (const row of rows) {
      const n = Number(row.n) || 0;
      let entry = byBadge.get(row.badgeType);
      if (!entry) {
        entry = { total: 0, byMethod: blank(), visits: 0, visitsBySource: blankSources() };
        byBadge.set(row.badgeType, entry);
      }
      entry.byMethod[row.method as keyof MethodCounts] += n;
      entry.total += n;
      orgByMethod[row.method as keyof MethodCounts] += n;
    }

    let visitsTotal = 0;
    for (const v of visitRows) {
      const n = Number(v.n) || 0;
      // A badge can receive visits even when nobody shared it during the
      // period (someone bookmarked the link, an old post is still being
      // clicked, etc.) so we still surface those rows in the leaderboard
      // — they will sort to the bottom because their share total is 0.
      let entry = byBadge.get(v.badgeType);
      if (!entry) {
        entry = { total: 0, byMethod: blank(), visits: 0, visitsBySource: blankSources() };
        byBadge.set(v.badgeType, entry);
      }
      const src = (v.source as keyof SourceCounts) in entry.visitsBySource
        ? (v.source as keyof SourceCounts)
        : "unknown";
      entry.visitsBySource[src] += n;
      orgVisitsBySource[src] += n;
      if (src !== "crawler") {
        entry.visits += n;
        visitsTotal += n;
      }
    }

    const badges = Array.from(byBadge.entries())
      .map(([badgeType, e]) => {
        const def = ALL_BADGES.find(b => b.type === badgeType);
        return {
          badgeType,
          label: def?.label ?? badgeType,
          icon: def?.icon ?? "🏅",
          category: def?.category ?? null,
          total: e.total,
          byMethod: e.byMethod,
          visits: e.visits,
          visitsBySource: e.visitsBySource,
          // Per-badge ratio (human visits / outbound shares). `null` when
          // there were no shares, so the UI can render "—" instead of
          // dividing by zero. We cap at 0 on the floor; >100% is real and
          // expected (one share can drive multiple visits — a friend
          // forwards the link, the recipient opens it twice, etc.).
          conversionRate: e.total > 0 ? e.visits / e.total : null,
        };
      })
      .sort((a, b) => b.total - a.total);

    const totalShares = orgByMethod.copy + orgByMethod.web_share + orgByMethod.native_share;

    res.json({
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        total: totalShares,
        byMethod: orgByMethod,
        // Org-wide totals so the leaderboard card can show a single
        // "shares → visits" headline next to the per-badge breakdown.
        visits: visitsTotal,
        visitsBySource: orgVisitsBySource,
        conversionRate: totalShares > 0 ? visitsTotal / totalShares : null,
      },
      badges,
    });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] badge-share leaderboard failed");
    res.status(500).json({ error: "Failed to load badge share leaderboard" });
  }
});

// ─── BADGE SHARE MEMBER BREAKDOWN (Task #1248) ───────────────────────────────
// Drill-down for a single badge from the Badge Share Leaderboard panel: returns
// the members in this org who shared `:badgeType` over the requested period,
// broken down by share method. Same data sources as the leaderboard above —
// raw `badge_share_events` UNION the `badge_share_daily_aggregates` rollup —
// just grouped by handle instead of badge so admins can see whether a viral
// badge is driven by one power-user or broad-based sharing. Both tables key on
// `handle`, so we join through `appUsersTable.publicHandle` to scope to this
// org and to surface display names.
router.get("/badge-share-leaderboard/:badgeType", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const badgeType = String((req.params as Record<string, string>).badgeType ?? "");
  if (!badgeType) { { res.status(400).json({ error: "Missing badgeType" }); return; } }

  const period = String(req.query.period ?? "month");
  const { from, to } = dateRange(period);

  try {
    // Task #1798 — also pull per-member visit counts for THIS badge so
    // the drill-down sheet can show "Visits attributed" per member next
    // to their share count. Visits are grouped by handle (not user id)
    // because the visit table only carries the handle snapshot — we
    // join back through `appUsersTable.publicHandle` to scope to org and
    // map to a stable user id for the merge below. Crawler hits are
    // excluded so the conversion ratio reflects human eyeballs only.
    const [rawRows, aggRows, visitRows] = await Promise.all([
      db
        .select({
          userId: appUsersTable.id,
          method: badgeShareEventsTable.method,
          n: count(badgeShareEventsTable.id),
        })
        .from(badgeShareEventsTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareEventsTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          eq(badgeShareEventsTable.badgeType, badgeType),
          gte(badgeShareEventsTable.createdAt, from),
          lte(badgeShareEventsTable.createdAt, to),
        ))
        .groupBy(appUsersTable.id, badgeShareEventsTable.method),
      db
        .select({
          userId: appUsersTable.id,
          method: badgeShareDailyAggregatesTable.method,
          n: sql<number>`COALESCE(SUM(${badgeShareDailyAggregatesTable.count}), 0)::int`,
        })
        .from(badgeShareDailyAggregatesTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareDailyAggregatesTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          eq(badgeShareDailyAggregatesTable.badgeType, badgeType),
          gte(badgeShareDailyAggregatesTable.day, from),
          lte(badgeShareDailyAggregatesTable.day, to),
        ))
        .groupBy(appUsersTable.id, badgeShareDailyAggregatesTable.method),
      db
        .select({
          userId: appUsersTable.id,
          source: badgeShareVisitEventsTable.source,
          n: count(badgeShareVisitEventsTable.id),
        })
        .from(badgeShareVisitEventsTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareVisitEventsTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          eq(badgeShareVisitEventsTable.badgeType, badgeType),
          gte(badgeShareVisitEventsTable.createdAt, from),
          lte(badgeShareVisitEventsTable.createdAt, to),
        ))
        .groupBy(appUsersTable.id, badgeShareVisitEventsTable.source),
      // Task #2255 — UNION the per-day visit-event aggregate for the
      // same reason as the listing endpoint above: once the rollup has
      // collapsed rows older than 30 days into the aggregate table,
      // reading only the raw table would silently drop those visits
      // from the per-member conversion-rate cell. Grouped by `source`
      // so Task #2254's per-member source breakdown stays correct after
      // the rollup; the controller buckets crawlers separately so we
      // include them in SQL rather than filtering here.
      db
        .select({
          userId: appUsersTable.id,
          source: badgeShareVisitDailyAggregatesTable.source,
          n: sql<number>`COALESCE(SUM(${badgeShareVisitDailyAggregatesTable.count}), 0)::int`,
        })
        .from(badgeShareVisitDailyAggregatesTable)
        .innerJoin(appUsersTable, eq(appUsersTable.publicHandle, badgeShareVisitDailyAggregatesTable.handle))
        .where(and(
          eq(appUsersTable.organizationId, orgId),
          eq(badgeShareVisitDailyAggregatesTable.badgeType, badgeType),
          gte(badgeShareVisitDailyAggregatesTable.day, from),
          lte(badgeShareVisitDailyAggregatesTable.day, to),
        ))
        .groupBy(appUsersTable.id, badgeShareVisitDailyAggregatesTable.source),
    ]).then(([raw, agg, visit, visitAgg]) => [raw, agg, [...visit, ...visitAgg]] as const);
    const rows = [...rawRows, ...aggRows];

    type MethodCounts = { copy: number; web_share: number; native_share: number };
    const blank = (): MethodCounts => ({ copy: 0, web_share: 0, native_share: 0 });
    type SourceCounts = { web: number; mobile: number; crawler: number; unknown: number };
    const blankSources = (): SourceCounts => ({ web: 0, mobile: 0, crawler: 0, unknown: 0 });
    const totalsByMethod = blank();
    const totalsVisitsBySource = blankSources();
    const byUser = new Map<number, { userId: number; total: number; byMethod: MethodCounts; visits: number; visitsBySource: SourceCounts }>();

    for (const row of rows) {
      const n = Number(row.n) || 0;
      let entry = byUser.get(row.userId);
      if (!entry) {
        entry = { userId: row.userId, total: 0, byMethod: blank(), visits: 0, visitsBySource: blankSources() };
        byUser.set(row.userId, entry);
      }
      entry.byMethod[row.method as keyof MethodCounts] += n;
      entry.total += n;
      totalsByMethod[row.method as keyof MethodCounts] += n;
    }

    let visitsTotal = 0;
    for (const v of visitRows) {
      const n = Number(v.n) || 0;
      // Surface members whose badge attracted visits even if they didn't
      // share themselves during the period — someone else's share, or an
      // older share, can still be driving traffic to their badge page.
      let entry = byUser.get(v.userId);
      if (!entry) {
        entry = { userId: v.userId, total: 0, byMethod: blank(), visits: 0, visitsBySource: blankSources() };
        byUser.set(v.userId, entry);
      }
      const src = (v.source as keyof SourceCounts) in entry.visitsBySource
        ? (v.source as keyof SourceCounts)
        : "unknown";
      entry.visitsBySource[src] += n;
      totalsVisitsBySource[src] += n;
      if (src !== "crawler") {
        entry.visits += n;
        visitsTotal += n;
      }
    }

    const sorted = Array.from(byUser.values()).sort((a, b) => b.total - a.total);

    const userIds = sorted.map(e => e.userId);
    const userRows = userIds.length === 0 ? [] : await db
      .select({
        id: appUsersTable.id,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        publicHandle: appUsersTable.publicHandle,
      })
      .from(appUsersTable)
      .where(inArray(appUsersTable.id, userIds));
    const userById = new Map(userRows.map(u => [u.id, u]));

    const members = sorted.map(e => {
      const u = userById.get(e.userId);
      return {
        userId: e.userId,
        displayName: u?.displayName ?? u?.username ?? null,
        username: u?.username ?? null,
        publicHandle: u?.publicHandle ?? null,
        total: e.total,
        byMethod: e.byMethod,
        // Per-member share→visit conversion. `null` when there were no
        // shares from this member during the period so the UI can render
        // "—" instead of dividing by zero. Values >100% are valid (one
        // share can drive multiple visits — friends forward the link, a
        // visitor reloads the page, etc.).
        visits: e.visits,
        visitsBySource: e.visitsBySource,
        conversionRate: e.total > 0 ? e.visits / e.total : null,
      };
    });

    const def = ALL_BADGES.find(b => b.type === badgeType);
    const totalShares = totalsByMethod.copy + totalsByMethod.web_share + totalsByMethod.native_share;

    res.json({
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      badge: {
        badgeType,
        label: def?.label ?? badgeType,
        icon: def?.icon ?? "🏅",
        category: def?.category ?? null,
      },
      totals: {
        total: totalShares,
        byMethod: totalsByMethod,
        // Badge-wide visit total + conversion ratio so the drill-down
        // sheet header can show the same headline metric as the org-wide
        // leaderboard, scoped to this badge.
        visits: visitsTotal,
        visitsBySource: totalsVisitsBySource,
        conversionRate: totalShares > 0 ? visitsTotal / totalShares : null,
      },
      members,
    });
  } catch (err) {
    logger.error({ err, orgId, badgeType }, "[analytics] badge-share member breakdown failed");
    res.status(500).json({ error: "Failed to load badge share member breakdown" });
  }
});

// ─── ANALYTICS EVENTS FEED (Task #982) ───────────────────────────────────────
// Surfaces the `analytics_events` table (populated by track() in lib/analytics)
// in an admin UI. Wave 0 instrumented these 5 high-traffic flows:
//   player_login, tournament_registration, tee_booking_created,
//   scorecard_submitted, payment_settled
// Endpoints:
//   GET /events/summary  → totals + per-day time series, scoped to org & range
//   GET /events/raw      → super-admin only, paginated raw rows for debugging
//   GET /events/export   → CSV download (org-scoped) for offline analysis

// Wave 0 seed list — used as the fallback when the analytics_events table is
// empty or the org has not yet emitted anything. The real list is now
// discovered dynamically via GET /events/names so the dashboard auto-picks up
// any new event names instrumented anywhere in the codebase.
const INSTRUMENTED_EVENTS = [
  "player_login",
  "tournament_registration",
  "tee_booking_created",
  "scorecard_submitted",
  "payment_settled",
  "lesson_booked",
  "fb_order_placed",
  "shop_checkout_completed",
  "notification_opened",
] as const;

// Task #1958 — Sensible default category for built-in event names so the
// Customize tab grouping and the trends category filter aren't blank on a
// fresh install. Admins can still override any of these via PUT
// /events/metadata/:eventName — an admin-set category (including an
// explicit empty string saved as NULL) on `analytics_event_metadata` always
// wins over the default. Events not listed here have no default and stay
// "Uncategorized" until an admin assigns one. Keep keys to the canonical
// event_name strings emitted by `track()` calls across the codebase plus a
// few well-known names from upcoming flows that the task description called
// out (shop_order_paid, spectator_push_opened) so they bucket correctly the
// moment they start firing.
const DEFAULT_EVENT_CATEGORIES: Record<string, string> = {
  // Authentication
  player_login: "Authentication",
  // Bookings
  tee_booking_created: "Bookings",
  lesson_booked: "Bookings",
  // Tournaments
  tournament_registration: "Tournaments",
  scorecard_submitted: "Tournaments",
  // Commerce
  payment_settled: "Commerce",
  shop_checkout_completed: "Commerce",
  shop_order_paid: "Commerce",
  fb_order_placed: "Commerce",
  // Engagement
  notification_opened: "Engagement",
  spectator_push_opened: "Engagement",
  ai_caddie_blocked: "Engagement",
  // Communications (delivery channel pings from lib/comms.ts)
  email: "Communications",
  sms: "Communications",
  whatsapp: "Communications",
};

function defaultCategoryFor(eventName: string): string | null {
  return DEFAULT_EVENT_CATEGORIES[eventName] ?? null;
}

function parseEventsRange(req: Request): { from: Date; to: Date } {
  const now = new Date();
  const fromQ = req.query.from ? new Date(String(req.query.from)) : null;
  const toQ = req.query.to ? new Date(String(req.query.to)) : null;
  const from = fromQ && !isNaN(fromQ.getTime())
    ? fromQ
    : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const to = toQ && !isNaN(toQ.getTime()) ? toQ : now;
  return { from, to };
}

function parseEventNames(req: Request): string[] {
  const raw = req.query.events ?? req.query.event;
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  return list.map((s) => String(s).trim()).filter(Boolean);
}

// Task #1948 — admins can toggle the Push and In-App channels independently
// on the analytics dashboard. The summary endpoint accepts an optional
// `channel` query param (CSV — `push,in_app` or just one of them) that
// scopes the `notification_opened` totals/series/breakdown to those
// channels only. Missing/empty/invalid values fall back to "both", which
// preserves the pre-#1948 behavior where push + in_app == combined total.
type NotificationChannel = "push" | "in_app";
function parseChannels(req: Request): NotificationChannel[] {
  const raw = req.query.channel ?? req.query.channels;
  if (!raw) return ["push", "in_app"];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const valid = list
    .map((s) => String(s).trim())
    .filter((s): s is NotificationChannel => s === "push" || s === "in_app");
  if (valid.length === 0) return ["push", "in_app"];
  return Array.from(new Set(valid));
}

// GET /events/names — distinct event names recently emitted in this org,
// merged with the seed list, sorted alphabetically. Drives the dashboard's
// filter list so newly instrumented events appear automatically (Task #1143).
//
// The response also includes the per-event metadata overrides (display name,
// description, color) admins have configured (Task #1318) so the dashboard
// can render friendly labels and stable colors without a second round-trip.
router.get("/events/names", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Look back 90 days by default — long enough to surface low-volume flows
  // without scanning the whole table.
  const lookbackDays = Math.min(
    Math.max(parseInt(String(req.query.days ?? "90")) || 90, 1),
    365,
  );
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  try {
    const [rows, metaRows, orderRows] = await Promise.all([
      db
        .selectDistinct({ eventName: analyticsEventsTable.eventName })
        .from(analyticsEventsTable)
        .where(and(
          eq(analyticsEventsTable.organizationId, orgId),
          gte(analyticsEventsTable.occurredAt, since),
        )),
      db
        .select({
          eventName: analyticsEventMetadataTable.eventName,
          displayName: analyticsEventMetadataTable.displayName,
          description: analyticsEventMetadataTable.description,
          color: analyticsEventMetadataTable.color,
          category: analyticsEventMetadataTable.category,
          updatedAt: analyticsEventMetadataTable.updatedAt,
          updatedByUserId: analyticsEventMetadataTable.updatedByUserId,
          updatedByDisplayName: appUsersTable.displayName,
          updatedByUsername: appUsersTable.username,
          updatedByEmail: appUsersTable.email,
        })
        .from(analyticsEventMetadataTable)
        .leftJoin(
          appUsersTable,
          eq(appUsersTable.id, analyticsEventMetadataTable.updatedByUserId),
        )
        .where(eq(analyticsEventMetadataTable.organizationId, orgId)),
      // Task #1959 — admin-chosen category order. We fetch every saved
      // row regardless of whether the category still has events; the
      // dashboard intersects this with `categories` below so stale
      // entries don't surface.
      db
        .select({
          category: analyticsEventCategoryOrderTable.category,
          position: analyticsEventCategoryOrderTable.position,
        })
        .from(analyticsEventCategoryOrderTable)
        .where(eq(analyticsEventCategoryOrderTable.organizationId, orgId)),
    ]);
    const seen = new Set<string>(rows.map(r => r.eventName));
    for (const e of INSTRUMENTED_EVENTS) seen.add(e);
    // Surface admin-customized events even if they haven't fired in the
    // lookback window — admins should still be able to see/edit them.
    for (const m of metaRows) seen.add(m.eventName);
    const events = Array.from(seen).sort((a, b) => a.localeCompare(b));

    const metadata: Record<string, {
      displayName: string | null;
      description: string | null;
      color: string | null;
      category: string | null;
      updatedAt: string | null;
      updatedByUserId: number | null;
      updatedByName: string | null;
    }> = {};
    const metaByName = new Map(metaRows.map((m) => [m.eventName, m] as const));

    // Task #1958 — Walk the union of seen + admin-customized + built-in
    // event names so the dashboard sees a default category for any
    // recognized name even when the org has never customized it. Admin
    // overrides on `analytics_event_metadata` always win: a row with
    // `category` set keeps that value; a row with `category = NULL`
    // is treated as "no override yet" and the default fills in. Events
    // not in `DEFAULT_EVENT_CATEGORIES` continue to read as null
    // (Uncategorized) until an admin assigns one.
    for (const evt of events) {
      const m = metaByName.get(evt);
      const fallback = defaultCategoryFor(evt);
      if (m) {
        metadata[evt] = {
          displayName: m.displayName,
          description: m.description,
          color: m.color,
          category: m.category ?? fallback,
          updatedAt: m.updatedAt instanceof Date ? m.updatedAt.toISOString() : (m.updatedAt as string | null),
          updatedByUserId: m.updatedByUserId,
          updatedByName: editorDisplayName(m),
        };
      } else if (fallback) {
        // Synthesize a metadata stub purely so the default category
        // surfaces. No admin has touched this event yet, so all the
        // editor-attribution fields stay null.
        metadata[evt] = {
          displayName: null,
          description: null,
          color: null,
          category: fallback,
          updatedAt: null,
          updatedByUserId: null,
          updatedByName: null,
        };
      }
    }

    // The "admin-managed list" of categories is the distinct set of
    // non-empty categories actually in use across this org's events.
    // Surfacing it lets the Customize tab show a datalist of suggestions
    // and powers the trends-page category filter dropdown without a
    // second round-trip. Task #1569.
    //
    // Task #1958 — iterating the merged metadata (which already folds in
    // the built-in defaults via `m.category ?? fallback` above) means
    // the dropdown isn't empty on a fresh install: any default category
    // that applies to a known event will show up here automatically.
    const categoriesSet = new Set<string>();
    for (const evt of Object.keys(metadata)) {
      const c = metadata[evt]?.category;
      if (c && c.length > 0) categoriesSet.add(c);
    }

    // Task #1959 — apply the admin-chosen order. Categories with a
    // saved position come first in that order; anything left over
    // (newly created categories that haven't been re-ordered yet)
    // falls back to alphabetical so the dashboard still renders
    // deterministically. The Customize panel uses this same list
    // as its drag source.
    const orderMap = new Map<string, number>();
    for (const r of orderRows) orderMap.set(r.category, r.position);
    const categories = Array.from(categoriesSet).sort((a, b) => {
      const pa = orderMap.has(a) ? orderMap.get(a)! : Number.POSITIVE_INFINITY;
      const pb = orderMap.has(b) ? orderMap.get(b)! : Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });
    // Echo back only the saved order rows that still correspond to
    // a known category, sorted by position. Stale rows (a category
    // that's been removed from every event) are filtered out so the
    // client never has to reconcile a phantom entry.
    const categoryOrder = orderRows
      .filter((r) => categoriesSet.has(r.category))
      .sort((a, b) => a.position - b.position)
      .map((r) => r.category);

    res.json({ events, metadata, categories, categoryOrder, lookbackDays });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] events names failed");
    res.status(500).json({ error: "Failed to load event names" });
  }
});

// ─── EVENT METADATA (Task #1318) ──────────────────────────────────────────
//
// Org admins assign friendly names, descriptions, and chart colors to any
// emitted event. The dashboard merges these overrides on top of the raw
// event names so newly instrumented flows can read naturally without a
// code change.

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const EVENT_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

// Task #1570 — pick the best human-readable label for the editor across the
// optional name fields on `app_users`, mirroring how the raw events table
// renders user attribution. Returns null when the editor has been erased
// or the SET-NULL FK was triggered.
function editorDisplayName(row: {
  updatedByUserId: number | null;
  updatedByDisplayName?: string | null;
  updatedByUsername?: string | null;
  updatedByEmail?: string | null;
}): string | null {
  if (row.updatedByUserId == null) return null;
  return (
    row.updatedByDisplayName?.trim() ||
    row.updatedByUsername?.trim() ||
    row.updatedByEmail?.trim() ||
    `User #${row.updatedByUserId}`
  );
}

function normalizeMetadataInput(body: unknown): {
  displayName: string | null;
  description: string | null;
  color: string | null;
  category: string | null;
  error?: string;
} {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const trimOrNull = (v: unknown, max: number): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (s.length === 0) return null;
    return s.slice(0, max);
  };

  const displayName = trimOrNull(b.displayName, 120);
  const description = trimOrNull(b.description, 500);
  const colorRaw = trimOrNull(b.color, 16);
  // Free-text category (Task #1569). 64 chars is enough for "Bookings",
  // "Member engagement", etc. without letting a runaway paste corrupt
  // the dashboard's category groupings.
  const category = trimOrNull(b.category, 64);
  if (colorRaw && !HEX_COLOR_RE.test(colorRaw)) {
    return {
      displayName, description, color: null, category,
      error: "color must be a hex code like #3b82f6 or #abc",
    };
  }
  return { displayName, description, color: colorRaw, category };
}

// GET /events/metadata — list every metadata override for this org. The
// dashboard preloads this list when the admin opens the Customize tab.
//
// Each row also includes the editor's display name + timestamp (Task
// #1570) so the Customize tab can render "Last edited by <name> on
// <date>" without a second round-trip per row.
router.get("/events/metadata", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    const rows = await db
      .select({
        eventName: analyticsEventMetadataTable.eventName,
        displayName: analyticsEventMetadataTable.displayName,
        description: analyticsEventMetadataTable.description,
        color: analyticsEventMetadataTable.color,
        category: analyticsEventMetadataTable.category,
        updatedAt: analyticsEventMetadataTable.updatedAt,
        updatedByUserId: analyticsEventMetadataTable.updatedByUserId,
        updatedByDisplayName: appUsersTable.displayName,
        updatedByUsername: appUsersTable.username,
        updatedByEmail: appUsersTable.email,
      })
      .from(analyticsEventMetadataTable)
      .leftJoin(
        appUsersTable,
        eq(appUsersTable.id, analyticsEventMetadataTable.updatedByUserId),
      )
      .where(eq(analyticsEventMetadataTable.organizationId, orgId));
    res.json({
      metadata: rows.map((r) => ({
        eventName: r.eventName,
        displayName: r.displayName,
        description: r.description,
        color: r.color,
        updatedAt: r.updatedAt,
        updatedByUserId: r.updatedByUserId,
        updatedByName: editorDisplayName(r),
      })),
    });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] events metadata list failed");
    res.status(500).json({ error: "Failed to load event metadata" });
  }
});

// GET /events/metadata/:eventName/history — return the most recent
// edits for a single event so the Customize tab can render a small
// "Recent changes" timeline (Task #1570). Capped at 10 rows since the
// UI only shows the latest few.
router.get("/events/metadata/:eventName/history", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const eventName = String((req.params as Record<string, string>).eventName ?? "").trim();
  if (!EVENT_NAME_RE.test(eventName)) {
    res.status(400).json({ error: "Invalid event name" });
    return;
  }

  try {
    const rows = await db
      .select({
        id: analyticsEventMetadataHistoryTable.id,
        action: analyticsEventMetadataHistoryTable.action,
        displayName: analyticsEventMetadataHistoryTable.displayName,
        description: analyticsEventMetadataHistoryTable.description,
        color: analyticsEventMetadataHistoryTable.color,
        changedAt: analyticsEventMetadataHistoryTable.changedAt,
        changedByUserId: analyticsEventMetadataHistoryTable.changedByUserId,
        changedByDisplayName: appUsersTable.displayName,
        changedByUsername: appUsersTable.username,
        changedByEmail: appUsersTable.email,
      })
      .from(analyticsEventMetadataHistoryTable)
      .leftJoin(
        appUsersTable,
        eq(appUsersTable.id, analyticsEventMetadataHistoryTable.changedByUserId),
      )
      .where(and(
        eq(analyticsEventMetadataHistoryTable.organizationId, orgId),
        eq(analyticsEventMetadataHistoryTable.eventName, eventName),
      ))
      .orderBy(desc(analyticsEventMetadataHistoryTable.changedAt))
      .limit(10);

    res.json({
      eventName,
      history: rows.map((r) => ({
        id: r.id,
        action: r.action,
        displayName: r.displayName,
        description: r.description,
        color: r.color,
        changedAt: r.changedAt,
        changedByUserId: r.changedByUserId,
        changedByName: editorDisplayName({
          updatedByUserId: r.changedByUserId,
          updatedByDisplayName: r.changedByDisplayName,
          updatedByUsername: r.changedByUsername,
          updatedByEmail: r.changedByEmail,
        }),
      })),
    });
  } catch (err) {
    logger.error({ err, orgId, eventName }, "[analytics] events metadata history failed");
    res.status(500).json({ error: "Failed to load event metadata history" });
  }
});

// PUT /events/metadata/:eventName — upsert the friendly label, description,
// and color for an event in this org. Returns the persisted row so the
// client can update its local cache without a refetch.
//
// Task #1570 — also stamps `updatedByUserId` with the editing admin and
// appends a row to `analytics_event_metadata_history` so the Customize
// tab can show "Last edited by <name> on <date>" plus a recent-changes
// timeline. The history row is best-effort (logged but not awaited as a
// hard failure) so a transient audit-log write never blocks the user's
// edit from being saved.
router.put("/events/metadata/:eventName", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const eventName = String((req.params as Record<string, string>).eventName ?? "").trim();
  if (!EVENT_NAME_RE.test(eventName)) {
    res.status(400).json({ error: "Invalid event name" });
    return;
  }

  const { displayName, description, color, category, error } = normalizeMetadataInput(req.body);
  if (error) { { res.status(400).json({ error }); return; } }

  const editorId = (req.user as SessionUser | undefined)?.id ?? null;

  // Task #1950 — chart colors must be unique per (org, event) so the
  // trends chart and totals tiles stay legible. If another event in this
  // org already owns the same hex, reject with a 409 that names the
  // conflicting event so the Customize panel can render
  // "This color is already used by <name>" inline. Comparison is
  // case-insensitive because the input is a hex code (#3B82F6 == #3b82f6).
  if (color) {
    try {
      const conflicts = await db
        .select({
          eventName: analyticsEventMetadataTable.eventName,
          displayName: analyticsEventMetadataTable.displayName,
        })
        .from(analyticsEventMetadataTable)
        .where(and(
          eq(analyticsEventMetadataTable.organizationId, orgId),
          ne(analyticsEventMetadataTable.eventName, eventName),
          sql`lower(${analyticsEventMetadataTable.color}) = lower(${color})`,
        ))
        .limit(1);
      if (conflicts.length > 0) {
        const c = conflicts[0];
        const label = c.displayName?.trim() || c.eventName;
        res.status(409).json({
          error: `This color is already used by ${label}`,
          conflictEventName: c.eventName,
        });
        return;
      }
    } catch (err) {
      logger.error({ err, orgId, eventName }, "[analytics] color uniqueness check failed");
      res.status(500).json({ error: "Failed to save event metadata" });
      return;
    }
  }

  try {
    const [row] = await db
      .insert(analyticsEventMetadataTable)
      .values({
        organizationId: orgId,
        eventName,
        displayName,
        description,
        color,
        category,
        updatedByUserId: editorId,
      })
      .onConflictDoUpdate({
        target: [
          analyticsEventMetadataTable.organizationId,
          analyticsEventMetadataTable.eventName,
        ],
        set: {
          displayName,
          description,
          color,
          category,
          updatedByUserId: editorId,
          updatedAt: new Date(),
        },
      })
      .returning({
        eventName: analyticsEventMetadataTable.eventName,
        displayName: analyticsEventMetadataTable.displayName,
        description: analyticsEventMetadataTable.description,
        color: analyticsEventMetadataTable.color,
        category: analyticsEventMetadataTable.category,
        updatedAt: analyticsEventMetadataTable.updatedAt,
        updatedByUserId: analyticsEventMetadataTable.updatedByUserId,
      });

    let editorName: string | null = null;
    if (editorId != null) {
      const [editor] = await db
        .select({
          displayName: appUsersTable.displayName,
          username: appUsersTable.username,
          email: appUsersTable.email,
        })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, editorId));
      if (editor) {
        editorName = editorDisplayName({
          updatedByUserId: editorId,
          updatedByDisplayName: editor.displayName,
          updatedByUsername: editor.username,
          updatedByEmail: editor.email,
        });
      }
    }

    try {
      await db.insert(analyticsEventMetadataHistoryTable).values({
        organizationId: orgId,
        eventName,
        action: "upsert",
        displayName,
        description,
        color,
        changedByUserId: editorId,
      });
    } catch (auditErr) {
      logger.error(
        { err: auditErr, orgId, eventName },
        "[analytics] events metadata history append failed",
      );
    }

    res.json({
      metadata: {
        ...row,
        updatedByName: editorName,
      },
    });
  } catch (err) {
    logger.error({ err, orgId, eventName }, "[analytics] events metadata upsert failed");
    res.status(500).json({ error: "Failed to save event metadata" });
  }
});

// DELETE /events/metadata/:eventName — remove the override so the dashboard
// falls back to the raw event name + deterministic palette color.
//
// Task #1570 — also writes an `action='delete'` row to the history
// table so teammates can see who reset an event back to the auto label
// and when. The history insert is best-effort.
router.delete("/events/metadata/:eventName", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const eventName = String((req.params as Record<string, string>).eventName ?? "").trim();
  if (!EVENT_NAME_RE.test(eventName)) {
    res.status(400).json({ error: "Invalid event name" });
    return;
  }

  const editorId = (req.user as SessionUser | undefined)?.id ?? null;

  try {
    const deleted = await db
      .delete(analyticsEventMetadataTable)
      .where(and(
        eq(analyticsEventMetadataTable.organizationId, orgId),
        eq(analyticsEventMetadataTable.eventName, eventName),
      ))
      .returning({ id: analyticsEventMetadataTable.id });

    // Only append a history row if we actually removed an override —
    // double-clicking Reset shouldn't clutter the timeline with
    // identical no-op delete rows.
    if (deleted.length > 0) {
      try {
        await db.insert(analyticsEventMetadataHistoryTable).values({
          organizationId: orgId,
          eventName,
          action: "delete",
          displayName: null,
          description: null,
          color: null,
          changedByUserId: editorId,
        });
      } catch (auditErr) {
        logger.error(
          { err: auditErr, orgId, eventName },
          "[analytics] events metadata history append failed",
        );
      }
    }

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, orgId, eventName }, "[analytics] events metadata delete failed");
    res.status(500).json({ error: "Failed to delete event metadata" });
  }
});

// ─── EVENT CATEGORY ORDER (Task #1959) ────────────────────────────────────
//
// Admins can drag categories into a deliberate order (e.g. Bookings before
// Marketing before Engagement). The order is persisted per organization as
// a list of (category, position) rows and used everywhere categories are
// listed: the Customize tab, totals tiles, chart legend, and the filter
// dropdown. Categories without a saved row fall back to alphabetical.
//
// The order is also echoed back inside GET /events/names so the dashboard
// can render the correct order on first paint without a second round-trip.

const CATEGORY_NAME_RE = /^.{1,64}$/;

router.get("/events/categories/order", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    const rows = await db
      .select({
        category: analyticsEventCategoryOrderTable.category,
        position: analyticsEventCategoryOrderTable.position,
      })
      .from(analyticsEventCategoryOrderTable)
      .where(eq(analyticsEventCategoryOrderTable.organizationId, orgId))
      .orderBy(analyticsEventCategoryOrderTable.position);
    res.json({ order: rows.map((r) => r.category) });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] events category order load failed");
    res.status(500).json({ error: "Failed to load category order" });
  }
});

// PUT /events/categories/order — replace the saved category order with the
// supplied list. `Uncategorized` is implicit (always pinned last) and is
// silently ignored if it appears in the body. Duplicate or empty entries
// are rejected so the admin can't save a corrupted list.
router.put("/events/categories/order", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
    order?: unknown;
  };
  const raw = Array.isArray(body.order) ? body.order : null;
  if (!raw) { res.status(400).json({ error: "order must be an array of category names" }); return; }

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") {
      res.status(400).json({ error: "order entries must be strings" });
      return;
    }
    const s = v.trim();
    // The "Uncategorized" bucket is rendered separately and always
    // pinned last — treating it like a real category here would let
    // it leak into the saved order and confuse later loads.
    if (s.length === 0 || s === "Uncategorized") continue;
    if (!CATEGORY_NAME_RE.test(s)) {
      res.status(400).json({ error: "category names must be 1–64 characters" });
      return;
    }
    if (seen.has(s)) {
      res.status(400).json({ error: "duplicate category in order" });
      return;
    }
    seen.add(s);
    cleaned.push(s);
  }

  try {
    // Replace-all is the simplest model that matches what the UI does
    // when the admin drops a card: it ships the full new ordering.
    // We keep it inside a transaction so a half-applied wipe can never
    // leave the org with partial ordering data.
    await db.transaction(async (tx) => {
      await tx
        .delete(analyticsEventCategoryOrderTable)
        .where(eq(analyticsEventCategoryOrderTable.organizationId, orgId));
      if (cleaned.length > 0) {
        await tx
          .insert(analyticsEventCategoryOrderTable)
          .values(
            cleaned.map((category, index) => ({
              organizationId: orgId,
              category,
              position: index,
              updatedAt: new Date(),
            })),
          );
      }
    });
    res.json({ order: cleaned });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] events category order save failed");
    res.status(500).json({ error: "Failed to save category order" });
  }
});

// `notification_opened` is emitted from two very different sources (Task #1317
// instrumented native push opens; the in-app handicap notifications fire the
// same event). Combined into one number admins can't tell whether a spike
// came from native push or in-app card opens, so the summary endpoint
// surfaces an extra per-channel breakdown for this event (Task #1563).
//
// Channel discriminator:
//   push    : surface = 'mobile'  OR  payload.channel = 'push'
//   in_app  : everything else
//
// SQL helper kept identical between the totals and series queries so push +
// in_app == total always holds (subject to the same WHERE clause).
const NOTIFICATION_CHANNEL_SQL = sql<string>`CASE WHEN ${analyticsEventsTable.surface} = 'mobile' OR ${analyticsEventsTable.payload}->>'channel' = 'push' THEN 'push' ELSE 'in_app' END`;

router.get("/events/summary", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = parseEventsRange(req);
  const wantedEvents = parseEventNames(req);
  const eventsFilter = wantedEvents.length > 0 ? wantedEvents : [...INSTRUMENTED_EVENTS];
  const wantsNotificationOpened = eventsFilter.includes("notification_opened");
  // Task #1948 — channel filter (push / in_app). Only meaningful for the
  // `notification_opened` event. When both are selected (the default), the
  // dashboard renders the same combined totals it always did.
  const selectedChannels = parseChannels(req);
  const channelsRestricted =
    selectedChannels.length === 1 && selectedChannels[0] !== undefined;
  const onlyPush = channelsRestricted && selectedChannels[0] === "push";
  const onlyInApp = channelsRestricted && selectedChannels[0] === "in_app";

  try {
    const totalsRows = await db
      .select({
        eventName: analyticsEventsTable.eventName,
        n: count(analyticsEventsTable.id),
      })
      .from(analyticsEventsTable)
      .where(and(
        eq(analyticsEventsTable.organizationId, orgId),
        gte(analyticsEventsTable.occurredAt, from),
        lte(analyticsEventsTable.occurredAt, to),
        inArray(analyticsEventsTable.eventName, eventsFilter),
      ))
      .groupBy(analyticsEventsTable.eventName);

    const seriesQueryRows = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${analyticsEventsTable.occurredAt}), 'YYYY-MM-DD')`,
        eventName: analyticsEventsTable.eventName,
        n: count(analyticsEventsTable.id),
      })
      .from(analyticsEventsTable)
      .where(and(
        eq(analyticsEventsTable.organizationId, orgId),
        gte(analyticsEventsTable.occurredAt, from),
        lte(analyticsEventsTable.occurredAt, to),
        inArray(analyticsEventsTable.eventName, eventsFilter),
      ))
      .groupBy(
        sql`to_char(date_trunc('day', ${analyticsEventsTable.occurredAt}), 'YYYY-MM-DD')`,
        analyticsEventsTable.eventName,
      )
      .orderBy(sql`to_char(date_trunc('day', ${analyticsEventsTable.occurredAt}), 'YYYY-MM-DD')`);

    const totals: Record<string, number> = {};
    for (const e of eventsFilter) totals[e] = 0;
    for (const row of totalsRows) totals[row.eventName] = Number(row.n) || 0;

    const dayMap = new Map<string, Record<string, number>>();
    for (const r of seriesQueryRows) {
      let bucket = dayMap.get(r.day);
      if (!bucket) {
        bucket = {};
        for (const e of eventsFilter) bucket[e] = 0;
        dayMap.set(r.day, bucket);
      }
      bucket[r.eventName] = Number(r.n) || 0;
    }
    const series: Array<Record<string, string | number> & { day: string }> = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, counts]) => ({ day, ...counts }));

    // Optional per-channel breakdown for `notification_opened`. Only computed
    // when the event is in the requested filter — otherwise we'd run a
    // useless extra query on every dashboard load.
    let breakdowns: {
      notification_opened?: {
        totals: { push: number; in_app: number };
        series: Array<{ day: string; push: number; in_app: number }>;
      };
    } | undefined;
    if (wantsNotificationOpened) {
      const breakdownRows = await db
        .select({
          day: sql<string>`to_char(date_trunc('day', ${analyticsEventsTable.occurredAt}), 'YYYY-MM-DD')`,
          channel: NOTIFICATION_CHANNEL_SQL,
          n: count(analyticsEventsTable.id),
        })
        .from(analyticsEventsTable)
        .where(and(
          eq(analyticsEventsTable.organizationId, orgId),
          gte(analyticsEventsTable.occurredAt, from),
          lte(analyticsEventsTable.occurredAt, to),
          eq(analyticsEventsTable.eventName, "notification_opened"),
        ))
        .groupBy(
          sql`to_char(date_trunc('day', ${analyticsEventsTable.occurredAt}), 'YYYY-MM-DD')`,
          NOTIFICATION_CHANNEL_SQL,
        )
        .orderBy(sql`to_char(date_trunc('day', ${analyticsEventsTable.occurredAt}), 'YYYY-MM-DD')`);

      let totalPush = 0;
      let totalInApp = 0;
      const channelDayMap = new Map<string, { push: number; in_app: number }>();
      for (const r of breakdownRows) {
        const n = Number(r.n) || 0;
        let bucket = channelDayMap.get(r.day);
        if (!bucket) { bucket = { push: 0, in_app: 0 }; channelDayMap.set(r.day, bucket); }
        if (r.channel === "push") { bucket.push = n; totalPush += n; }
        else { bucket.in_app = n; totalInApp += n; }
      }

      // Task #1948 — when only one channel is selected, scope the
      // notification_opened combined totals/series down to that channel
      // so totals tiles and the trend chart reflect the toggle. Days that
      // had no events on the selected channel show 0 (or are dropped from
      // the breakdown series if no other event keeps them alive).
      const effectivePush = onlyInApp ? 0 : totalPush;
      const effectiveInApp = onlyPush ? 0 : totalInApp;
      if (channelsRestricted) {
        totals.notification_opened = effectivePush + effectiveInApp;
        for (const row of series) {
          const c = channelDayMap.get(row.day);
          const push = onlyInApp ? 0 : (c?.push ?? 0);
          const inApp = onlyPush ? 0 : (c?.in_app ?? 0);
          row.notification_opened = push + inApp;
        }
      }

      breakdowns = {
        notification_opened: {
          totals: { push: effectivePush, in_app: effectiveInApp },
          series: Array.from(channelDayMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, c]) => ({
              day,
              push: onlyInApp ? 0 : c.push,
              in_app: onlyPush ? 0 : c.in_app,
            }))
            .filter((r) => r.push + r.in_app > 0),
        },
      };
    }

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      events: eventsFilter,
      totals,
      series,
      ...(breakdowns ? { breakdowns } : {}),
    });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] events summary failed");
    res.status(500).json({ error: "Failed to load events summary" });
  }
});

router.get("/events/raw", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as SessionUser | undefined;
  if (!user || user.role !== "super_admin") {
    res.status(403).json({ error: "Super admin access required" });
    return;
  }

  const { from, to } = parseEventsRange(req);
  const wantedEvents = parseEventNames(req);
  const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
  const limit = Math.min(Math.max(isNaN(limitRaw) ? 100 : limitRaw, 1), 500);
  const offsetRaw = parseInt(String(req.query.offset ?? "0"), 10);
  const offset = Math.max(isNaN(offsetRaw) ? 0 : offsetRaw, 0);
  const userFilterRaw = typeof req.query.user === "string" ? req.query.user.trim() : "";

  try {
    const conditions = [
      eq(analyticsEventsTable.organizationId, orgId),
      gte(analyticsEventsTable.occurredAt, from),
      lte(analyticsEventsTable.occurredAt, to),
    ];
    if (wantedEvents.length > 0) {
      conditions.push(inArray(analyticsEventsTable.eventName, wantedEvents));
    }
    if (userFilterRaw.length > 0) {
      const asNum = Number(userFilterRaw);
      if (Number.isInteger(asNum) && asNum > 0) {
        conditions.push(eq(analyticsEventsTable.userId, asNum));
      } else {
        const like = `%${userFilterRaw.toLowerCase()}%`;
        conditions.push(sql`(
          lower(${appUsersTable.displayName}) like ${like}
          or lower(${appUsersTable.email}) like ${like}
          or lower(${appUsersTable.username}) like ${like}
        )`);
      }
    }

    const [rows, totalRow] = await Promise.all([
      db.select({
        id: analyticsEventsTable.id,
        eventName: analyticsEventsTable.eventName,
        organizationId: analyticsEventsTable.organizationId,
        userId: analyticsEventsTable.userId,
        surface: analyticsEventsTable.surface,
        payload: analyticsEventsTable.payload,
        requestId: analyticsEventsTable.requestId,
        occurredAt: analyticsEventsTable.occurredAt,
        userDisplayName: appUsersTable.displayName,
        userEmail: appUsersTable.email,
        userUsername: appUsersTable.username,
      })
        .from(analyticsEventsTable)
        .leftJoin(appUsersTable, eq(appUsersTable.id, analyticsEventsTable.userId))
        .where(and(...conditions))
        .orderBy(desc(analyticsEventsTable.occurredAt))
        .limit(limit)
        .offset(offset),
      db.select({ n: count() })
        .from(analyticsEventsTable)
        .leftJoin(appUsersTable, eq(appUsersTable.id, analyticsEventsTable.userId))
        .where(and(...conditions)),
    ]);

    res.json({
      from: from.toISOString(),
      to: to.toISOString(),
      events: wantedEvents,
      total: Number(totalRow[0]?.n ?? 0),
      limit,
      offset,
      rows,
    });
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] events raw failed");
    res.status(500).json({ error: "Failed to load raw events" });
  }
});

router.get("/events/export", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = parseEventsRange(req);
  const wantedEvents = parseEventNames(req);
  const userFilterRaw = typeof req.query.user === "string" ? req.query.user.trim() : "";

  try {
    const conditions = [
      eq(analyticsEventsTable.organizationId, orgId),
      gte(analyticsEventsTable.occurredAt, from),
      lte(analyticsEventsTable.occurredAt, to),
    ];
    if (wantedEvents.length > 0) {
      conditions.push(inArray(analyticsEventsTable.eventName, wantedEvents));
    }
    if (userFilterRaw.length > 0) {
      const asNum = Number(userFilterRaw);
      if (Number.isInteger(asNum) && asNum > 0) {
        conditions.push(eq(analyticsEventsTable.userId, asNum));
      } else {
        const like = `%${userFilterRaw.toLowerCase()}%`;
        conditions.push(sql`(
          lower(${appUsersTable.displayName}) like ${like}
          or lower(${appUsersTable.email}) like ${like}
          or lower(${appUsersTable.username}) like ${like}
        )`);
      }
    }

    const rows = await db.select({
      id: analyticsEventsTable.id,
      eventName: analyticsEventsTable.eventName,
      organizationId: analyticsEventsTable.organizationId,
      userId: analyticsEventsTable.userId,
      surface: analyticsEventsTable.surface,
      payload: analyticsEventsTable.payload,
      requestId: analyticsEventsTable.requestId,
      occurredAt: analyticsEventsTable.occurredAt,
      userDisplayName: appUsersTable.displayName,
      userEmail: appUsersTable.email,
    })
      .from(analyticsEventsTable)
      .leftJoin(appUsersTable, eq(appUsersTable.id, analyticsEventsTable.userId))
      .where(and(...conditions))
      .orderBy(desc(analyticsEventsTable.occurredAt))
      .limit(10000);

    const headers = ["id", "occurred_at", "event_name", "organization_id", "user_id", "surface", "request_id", "payload", "user_display_name", "user_email"];
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push([
        escape(r.id),
        escape(r.occurredAt instanceof Date ? r.occurredAt.toISOString() : r.occurredAt),
        escape(r.eventName),
        escape(r.organizationId),
        escape(r.userId),
        escape(r.surface),
        escape(r.requestId),
        escape(r.payload),
        escape(r.userDisplayName),
        escape(r.userEmail),
      ].join(","));
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="analytics-events-${orgId}-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`,
    );
    res.send(lines.join("\n"));
  } catch (err) {
    logger.error({ err, orgId }, "[analytics] events export failed");
    res.status(500).json({ error: "Failed to export events" });
  }
});

export default router;
