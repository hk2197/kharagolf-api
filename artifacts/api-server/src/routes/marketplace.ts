/**
 * Tee Time Marketplace API
 * Scoped to: /organizations/:orgId/marketplace
 *
 * GET    /                              List available slots (public with ?status=open, admin sees all)
 * POST   /                             Create slot (org admin)
 * PATCH  /:slotId                      Update slot (org admin)
 * DELETE /:slotId                      Delete slot (org admin, only if no confirmed bookings)
 * POST   /:slotId/book                 Player books a slot (authenticated portal user)
 * POST   /:slotId/cancel/:bookingId    Cancel own booking (portal user or admin)
 * GET    /:slotId/bookings             List bookings for a slot (org admin)
 * GET    /my-bookings                  Player's own bookings (portal user via ?userId)
 * POST   /:slotId/payment/verify       Verify Razorpay payment and confirm booking
 * GET    /settings                     Get marketplace settings (org admin)
 * PATCH  /settings                     Update marketplace settings (org admin)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  marketplaceSlotsTable,
  marketplaceBookingsTable,
  coursesTable,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, gte, lte, desc, asc, sql } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { getRazorpayClient, getRazorpayKeyId } from "../lib/razorpay";
import { logger } from "../lib/logger";
import { gateFeature } from "../lib/featureGate";
import { notifyDiscoverSlotChange } from "./marketplace-discover";
import crypto from "crypto";

// SSE client registry: orgId → Set of response objects (shared across admin + public streams)
export const marketplaceSSEClients = new Map<number, Set<Response>>();

export function addMarketplaceSSEClient(orgId: number, res: Response) {
  if (!marketplaceSSEClients.has(orgId)) marketplaceSSEClients.set(orgId, new Set());
  marketplaceSSEClients.get(orgId)!.add(res);
}

export function removeMarketplaceSSEClient(orgId: number, res: Response) {
  marketplaceSSEClients.get(orgId)?.delete(res);
}

export function broadcastSlotUpdate(orgId: number, slot?: ReturnType<typeof formatSlot>) {
  // Always notify cross-club discover-stream subscribers (e.g. marketplace
  // map) — they only need to know that this org's open-slot count may have
  // changed and will refetch their filter-aware counts in response.
  notifyDiscoverSlotChange(orgId);

  // Per-org SSE: push the full slot payload (or a bare change ping for
  // bulk operations that don't have a single slot to send) to admin and
  // public-club subscribers.
  const cs = marketplaceSSEClients.get(orgId);
  if (!cs?.size) return;
  const payload = slot ? { type: "slot_update", slot } : { type: "slot_update" };
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of cs) {
    try { c.write(msg); } catch { cs.delete(c); }
  }
}

const router: IRouter = Router({ mergeParams: true });
router.use(gateFeature("marketplace"));

/* ─── Helpers ────────────────────────────────────────────────────── */

/** Non-blocking org-scoped admin check.
 *  Returns true if the user is super_admin OR has org_admin/tournament_director
 *  role within the specific orgId (either on their user record or in memberships).
 */
async function isOrgAdminForOrg(user: { id: number; role?: string; organizationId?: number | null }, orgId: number): Promise<boolean> {
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && user.organizationId === orgId) return true;
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  return !!membership && ["org_admin", "tournament_director"].includes(membership.role);
}

export function formatSlot(slot: typeof marketplaceSlotsTable.$inferSelect, courseName?: string) {
  return {
    id: slot.id,
    organizationId: slot.organizationId,
    courseId: slot.courseId,
    courseName: courseName ?? null,
    slotDate: slot.slotDate.toISOString(),
    startingHole: slot.startingHole,
    maxPlayers: slot.maxPlayers,
    bookedPlayers: slot.bookedPlayers,
    spotsLeft: slot.maxPlayers - slot.bookedPlayers,
    pricePaise: slot.pricePaise,
    basePricePaise: slot.basePricePaise,
    isPublic: slot.isPublic,
    surgeIndicator: slot.surgeIndicator,
    priceDisplay: slot.pricePaise > 0 ? `₹${(slot.pricePaise / 100).toFixed(0)}` : "Free",
    notes: slot.notes,
    status: slot.status,
    createdAt: slot.createdAt.toISOString(),
  };
}

/**
 * Apply the org-configured markup percentage to a base price (paise) and
 * return the listed price paise. Returns base unchanged when markup is 0.
 */
async function computeListedPrice(orgId: number, basePaise: number): Promise<number> {
  const [org] = await db.select({ markup: organizationsTable.marketplaceMarkupPct })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const pct = org?.markup ? Number(org.markup) : 0;
  if (!pct || basePaise <= 0) return basePaise;
  return Math.round(basePaise * (1 + pct / 100));
}

/* ─── GET /my-bookings — Player's own bookings (must be before /:slotId) ─── */

router.get("/my-bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number };

  const bookings = await db
    .select({
      booking: marketplaceBookingsTable,
      slotDate: marketplaceSlotsTable.slotDate,
      startingHole: marketplaceSlotsTable.startingHole,
      courseName: coursesTable.name,
      slotStatus: marketplaceSlotsTable.status,
    })
    .from(marketplaceBookingsTable)
    .innerJoin(marketplaceSlotsTable, eq(marketplaceBookingsTable.slotId, marketplaceSlotsTable.id))
    .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
    .where(and(eq(marketplaceBookingsTable.userId, user.id), eq(marketplaceBookingsTable.organizationId, orgId)))
    .orderBy(desc(marketplaceSlotsTable.slotDate));

  res.json(bookings.map(r => ({
    ...r.booking,
    bookedAt: r.booking.bookedAt.toISOString(),
    cancelledAt: r.booking.cancelledAt?.toISOString() ?? null,
    slotDate: r.slotDate.toISOString(),
    startingHole: r.startingHole,
    courseName: r.courseName,
    slotStatus: r.slotStatus,
  })));
});

/* ─── GET / — List Slots ─────────────────────────────────────────── */

router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const status = typeof req.query.status === "string" ? req.query.status : "open";
  const from = typeof req.query.from === "string" ? new Date(req.query.from) : new Date();

  const conditions = [eq(marketplaceSlotsTable.organizationId, orgId)];
  if (status !== "all") conditions.push(eq(marketplaceSlotsTable.status, status));
  if (from) conditions.push(gte(marketplaceSlotsTable.slotDate, from));

  const slots = await db
    .select({
      slot: marketplaceSlotsTable,
      courseName: coursesTable.name,
    })
    .from(marketplaceSlotsTable)
    .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
    .where(and(...conditions))
    .orderBy(asc(marketplaceSlotsTable.slotDate));

  res.json(slots.map(r => formatSlot(r.slot, r.courseName ?? undefined)));
});

/* ─── POST / — Create Slot (admin) ──────────────────────────────── */

router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { slotDate, startingHole, maxPlayers, pricePaise, notes, courseId, isPublic, surgeIndicator } = req.body as {
    slotDate: string;
    startingHole?: number;
    maxPlayers?: number;
    pricePaise?: number;
    notes?: string;
    courseId?: number;
    isPublic?: boolean;
    surgeIndicator?: "off_peak" | "normal" | "surge";
  };

  if (!slotDate) { { res.status(400).json({ error: "slotDate is required" }); return; } }
  const date = new Date(slotDate);
  if (isNaN(date.getTime())) { { res.status(400).json({ error: "Invalid slotDate" }); return; } }

  // Marketplace exposure default comes from org-level marketplaceDefaultPublic
  const [orgRow] = await db.select({
    defaultPublic: organizationsTable.marketplaceDefaultPublic,
    enabled: organizationsTable.marketplaceEnabled,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const expose = (isPublic !== undefined ? isPublic : (orgRow?.defaultPublic ?? false)) && (orgRow?.enabled ?? false);

  const basePaise = pricePaise ?? 0;
  const listedPaise = expose ? await computeListedPrice(orgId, basePaise) : basePaise;

  const [slot] = await db.insert(marketplaceSlotsTable).values({
    organizationId: orgId,
    courseId: courseId ?? null,
    slotDate: date,
    startingHole: startingHole ?? 1,
    maxPlayers: maxPlayers ?? 4,
    pricePaise: listedPaise,
    basePricePaise: basePaise,
    isPublic: expose,
    surgeIndicator: surgeIndicator ?? "normal",
    notes: notes ?? null,
  }).returning();

  if (slot.isPublic) broadcastSlotUpdate(orgId, formatSlot(slot));
  res.status(201).json(formatSlot(slot));
});

/* ─── POST /bulk — Bulk create slots over a date range (admin) ───── */
/* NOTE: must be declared BEFORE /:slotId to avoid shadowing */

router.post("/bulk", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    fromDate, toDate,
    startTime, endTime,
    intervalMinutes,
    maxPlayers, pricePaise, notes, courseId, startingHole, daysOfWeek,
  } = req.body as {
    fromDate: string; toDate: string;
    startTime: string; endTime: string;
    intervalMinutes: number;
    maxPlayers?: number;
    pricePaise?: number;
    notes?: string;
    courseId?: number;
    startingHole?: number;
    daysOfWeek?: number[]; // 0=Sun,1=Mon...6=Sat; omit for all days
  };

  if (!fromDate || !toDate || !startTime || !endTime || !intervalMinutes) {
    res.status(400).json({ error: "fromDate, toDate, startTime, endTime, intervalMinutes are required" }); return;
  }
  const interval = Math.max(5, Math.min(120, Math.round(intervalMinutes)));

  // Build list of dates in range
  const from = new Date(fromDate + "T00:00:00");
  const to   = new Date(toDate   + "T00:00:00");
  if (isNaN(from.getTime()) || isNaN(to.getTime())) { { res.status(400).json({ error: "Invalid date range" }); return; } }
  if (to < from) { { res.status(400).json({ error: "toDate must be >= fromDate" }); return; } }

  const allowedDays = Array.isArray(daysOfWeek) && daysOfWeek.length > 0 ? new Set(daysOfWeek) : null;

  // Build all time slots for each date
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM]     = endTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes   = endH   * 60 + endM;

  if (endMinutes <= startMinutes) { { res.status(400).json({ error: "endTime must be after startTime" }); return; } }

  const slotsToInsert: (typeof marketplaceSlotsTable.$inferInsert)[] = [];

  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    if (allowedDays && !allowedDays.has(d.getDay())) continue;
    for (let m = startMinutes; m < endMinutes; m += interval) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const slotDate = new Date(d);
      slotDate.setHours(h, min, 0, 0);
      slotsToInsert.push({
        organizationId: orgId,
        courseId: courseId ?? null,
        slotDate,
        startingHole: startingHole ?? 1,
        maxPlayers: maxPlayers ?? 4,
        pricePaise: pricePaise ?? 0,
        notes: notes ?? null,
      });
    }
  }

  if (slotsToInsert.length === 0) {
    res.status(400).json({ error: "No slots generated — check your date/time range and days-of-week filter" }); return;
  }
  if (slotsToInsert.length > 500) {
    res.status(400).json({ error: `Too many slots (${slotsToInsert.length}). Limit is 500 per bulk operation. Narrow your date range.` }); return;
  }

  const inserted = await db.insert(marketplaceSlotsTable).values(slotsToInsert).onConflictDoNothing().returning();

  broadcastSlotUpdate(orgId);
  res.status(201).json({ created: inserted.length, skipped: slotsToInsert.length - inserted.length });
});

/* ─── GET /settings — Marketplace settings for this org (admin) ─── */
/* NOTE: must be declared BEFORE router.patch("/:slotId") to avoid shadowing */

router.get("/settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number };
  if (!(await isOrgAdminForOrg(user, orgId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const [org] = await db.select({
    cancelWindowHours: organizationsTable.marketplaceCancelWindowHours,
    marketplaceEnabled: organizationsTable.marketplaceEnabled,
    marketplaceDefaultPublic: organizationsTable.marketplaceDefaultPublic,
    marketplaceCommissionPct: organizationsTable.marketplaceCommissionPct,
    marketplaceMarkupPct: organizationsTable.marketplaceMarkupPct,
    latitude: organizationsTable.latitude,
    longitude: organizationsTable.longitude,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  res.json({
    cancelWindowHours: org?.cancelWindowHours ?? 24,
    marketplaceEnabled: org?.marketplaceEnabled ?? false,
    marketplaceDefaultPublic: org?.marketplaceDefaultPublic ?? false,
    marketplaceCommissionPct: org?.marketplaceCommissionPct ? Number(org.marketplaceCommissionPct) : 0,
    marketplaceMarkupPct: org?.marketplaceMarkupPct ? Number(org.marketplaceMarkupPct) : 0,
    latitude: org?.latitude != null ? Number(org.latitude) : null,
    longitude: org?.longitude != null ? Number(org.longitude) : null,
  });
});

/* ─── PATCH /settings — Update marketplace settings (admin) ─────── */
/* NOTE: must be declared BEFORE router.patch("/:slotId") to avoid shadowing */

router.patch("/settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number };
  if (!(await isOrgAdminForOrg(user, orgId))) { { res.status(403).json({ error: "Forbidden" }); return; } }
  const body = req.body as {
    cancelWindowHours?: number;
    marketplaceEnabled?: boolean;
    marketplaceDefaultPublic?: boolean;
    marketplaceCommissionPct?: number;
    marketplaceMarkupPct?: number;
    latitude?: number | null;
    longitude?: number | null;
  };

  const updates: Partial<typeof organizationsTable.$inferInsert> = {};
  if (typeof body.cancelWindowHours === "number") {
    updates.marketplaceCancelWindowHours = Math.max(0, Math.min(168, Math.round(body.cancelWindowHours)));
  }
  if (typeof body.marketplaceEnabled === "boolean") updates.marketplaceEnabled = body.marketplaceEnabled;
  if (typeof body.marketplaceDefaultPublic === "boolean") updates.marketplaceDefaultPublic = body.marketplaceDefaultPublic;
  if (typeof body.marketplaceCommissionPct === "number") {
    updates.marketplaceCommissionPct = String(Math.max(0, Math.min(50, body.marketplaceCommissionPct)));
  }
  if (typeof body.marketplaceMarkupPct === "number") {
    updates.marketplaceMarkupPct = String(Math.max(0, Math.min(100, body.marketplaceMarkupPct)));
  }
  if (body.latitude !== undefined) updates.latitude = body.latitude == null ? null : String(body.latitude);
  if (body.longitude !== undefined) updates.longitude = body.longitude == null ? null : String(body.longitude);

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No updatable settings provided" }); return;
  }

  await db.update(organizationsTable).set(updates).where(eq(organizationsTable.id, orgId));
  res.json({ success: true });
});

/* ─── PATCH /:slotId — Update Slot (admin) ───────────────────────── */

router.patch("/:slotId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [slot] = await db.select().from(marketplaceSlotsTable)
    .where(and(eq(marketplaceSlotsTable.id, slotId), eq(marketplaceSlotsTable.organizationId, orgId)));
  if (!slot) { { res.status(404).json({ error: "Slot not found" }); return; } }

  const updates: Partial<typeof marketplaceSlotsTable.$inferInsert> = {};
  if (req.body.slotDate) updates.slotDate = new Date(req.body.slotDate);
  if (req.body.startingHole != null) updates.startingHole = req.body.startingHole;
  if (req.body.maxPlayers != null) updates.maxPlayers = req.body.maxPlayers;
  if (req.body.notes !== undefined) updates.notes = req.body.notes;
  if (req.body.status) updates.status = req.body.status;
  if (req.body.courseId !== undefined) updates.courseId = req.body.courseId;
  if (req.body.surgeIndicator) updates.surgeIndicator = req.body.surgeIndicator;

  // Price + exposure: when basePrice or isPublic changes, recompute listed price.
  const willExpose = req.body.isPublic !== undefined ? !!req.body.isPublic : slot.isPublic;
  if (req.body.isPublic !== undefined) updates.isPublic = willExpose;

  if (req.body.pricePaise != null) {
    // Treat incoming pricePaise as the new base price (admin-facing)
    const newBase = req.body.pricePaise as number;
    updates.basePricePaise = newBase;
    updates.pricePaise = willExpose ? await computeListedPrice(orgId, newBase) : newBase;
  } else if (req.body.isPublic !== undefined) {
    // Exposure changed without price change → recompute on existing base
    const base = slot.basePricePaise ?? slot.pricePaise;
    updates.pricePaise = willExpose ? await computeListedPrice(orgId, base) : base;
  }

  const [updated] = await db.update(marketplaceSlotsTable).set(updates)
    .where(and(eq(marketplaceSlotsTable.id, slotId), eq(marketplaceSlotsTable.organizationId, orgId))).returning();

  broadcastSlotUpdate(orgId, formatSlot(updated));
  res.json(formatSlot(updated));
});

/* ─── DELETE /:slotId — Delete Slot (admin) ─────────────────────── */

router.delete("/:slotId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify slot belongs to this org before any mutation
  const [slot] = await db.select({ id: marketplaceSlotsTable.id })
    .from(marketplaceSlotsTable)
    .where(and(eq(marketplaceSlotsTable.id, slotId), eq(marketplaceSlotsTable.organizationId, orgId)));
  if (!slot) { { res.status(404).json({ error: "Slot not found" }); return; } }

  const confirmedBookings = await db.select({ id: marketplaceBookingsTable.id })
    .from(marketplaceBookingsTable)
    .where(and(
      eq(marketplaceBookingsTable.slotId, slotId),
      eq(marketplaceBookingsTable.organizationId, orgId),
      eq(marketplaceBookingsTable.paymentStatus, "confirmed"),
    ));

  if (confirmedBookings.length > 0) {
    res.status(400).json({ error: "Cannot delete a slot with confirmed bookings. Cancel the bookings first." });
    return;
  }

  await db.delete(marketplaceBookingsTable)
    .where(and(eq(marketplaceBookingsTable.slotId, slotId), eq(marketplaceBookingsTable.organizationId, orgId)));
  await db.delete(marketplaceSlotsTable)
    .where(and(eq(marketplaceSlotsTable.id, slotId), eq(marketplaceSlotsTable.organizationId, orgId)));

  broadcastSlotUpdate(orgId);
  res.json({ success: true });
});

/* ─── GET /dashboard — Aggregate bookings list + revenue KPIs ────── */
/* NOTE: declared before /:slotId routes to avoid route conflict */

async function loadDashboardData(orgId: number, fromDate: Date, toDate: Date) {
  const [org] = await db.select({
    commissionPct: organizationsTable.marketplaceCommissionPct,
    name: organizationsTable.name,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const commissionPct = org?.commissionPct ? Number(org.commissionPct) : 0;

  const rows = await db
    .select({
      booking: marketplaceBookingsTable,
      slotDate: marketplaceSlotsTable.slotDate,
      basePricePaise: marketplaceSlotsTable.basePricePaise,
      listedPricePaise: marketplaceSlotsTable.pricePaise,
      courseName: coursesTable.name,
      displayName: appUsersTable.displayName,
    })
    .from(marketplaceBookingsTable)
    .innerJoin(marketplaceSlotsTable, eq(marketplaceSlotsTable.id, marketplaceBookingsTable.slotId))
    .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
    .leftJoin(appUsersTable, eq(marketplaceBookingsTable.userId, appUsersTable.id))
    .where(and(
      eq(marketplaceBookingsTable.organizationId, orgId),
      gte(marketplaceSlotsTable.slotDate, fromDate),
      lte(marketplaceSlotsTable.slotDate, toDate),
    ))
    .orderBy(desc(marketplaceSlotsTable.slotDate));

  const enriched = rows.map(r => {
    const players = r.booking.players;
    const listedPerPlayer = r.listedPricePaise ?? 0;
    const basePerPlayer = r.basePricePaise ?? listedPerPlayer;
    const markupPerPlayer = Math.max(0, listedPerPlayer - basePerPlayer);
    const markupPaise = markupPerPlayer * players;
    const commissionPaise = r.booking.paymentStatus === "confirmed"
      ? Math.round((r.booking.amountPaise * commissionPct) / 100)
      : 0;
    return { ...r, markupPaise, commissionPaise, basePerPlayer, listedPerPlayer };
  });

  const confirmed = enriched.filter(r => r.booking.paymentStatus === "confirmed");
  const revenue = confirmed.reduce((t, r) => t + r.booking.amountPaise, 0);
  const players = confirmed.reduce((t, r) => t + r.booking.players, 0);
  const markupRetained = confirmed.reduce((t, r) => t + r.markupPaise, 0);
  const commissionAccrued = confirmed.reduce((t, r) => t + r.commissionPaise, 0);

  return {
    orgName: org?.name ?? null,
    commissionPct,
    rows: enriched,
    kpis: {
      totalBookings: enriched.length,
      confirmedBookings: confirmed.length,
      cancelledBookings: enriched.filter(r => r.booking.paymentStatus === "cancelled").length,
      totalRevenuePaise: revenue,
      totalPlayers: players,
      totalMarkupRetainedPaise: markupRetained,
      totalCommissionAccruedPaise: commissionAccrued,
    },
  };
}

router.get("/dashboard", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = req.query as { from?: string; to?: string };
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
  const toDate = to ? new Date(to) : new Date(Date.now() + 365 * 86_400_000);

  const data = await loadDashboardData(orgId, fromDate, toDate);

  res.json({
    kpis: data.kpis,
    commissionPct: data.commissionPct,
    bookings: data.rows.map(r => ({
      ...r.booking,
      slotDate: r.slotDate.toISOString(),
      bookedAt: r.booking.bookedAt.toISOString(),
      cancelledAt: r.booking.cancelledAt?.toISOString() ?? null,
      courseName: r.courseName ?? null,
      displayName: r.displayName ?? null,
      basePricePaise: r.basePerPlayer,
      listedPricePaise: r.listedPerPlayer,
      markupPaise: r.markupPaise,
      commissionPaise: r.commissionPaise,
    })),
  });
});

/* ─── GET /dashboard/export.csv — Finance CSV export ─────────────── */

router.get("/dashboard/export.csv", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = req.query as { from?: string; to?: string };
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86_400_000);
  const toDate = to ? new Date(to) : new Date(Date.now() + 365 * 86_400_000);

  const data = await loadDashboardData(orgId, fromDate, toDate);

  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // Prevent CSV formula injection: prefix risky leading characters with a single quote.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rupees = (paise: number) => (paise / 100).toFixed(2);

  const header = [
    "booking_id", "slot_date", "course", "player", "players",
    "payment_status", "base_price_per_player_inr", "listed_price_per_player_inr",
    "gross_revenue_inr", "markup_retained_inr",
    "commission_pct", "commission_accrued_inr", "booked_at",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of data.rows) {
    lines.push([
      r.booking.id,
      r.slotDate.toISOString(),
      r.courseName ?? "",
      r.booking.playerName,
      r.booking.players,
      r.booking.paymentStatus,
      rupees(r.basePerPlayer),
      rupees(r.listedPerPlayer),
      rupees(r.booking.amountPaise),
      rupees(r.markupPaise),
      data.commissionPct.toFixed(2),
      rupees(r.commissionPaise),
      r.booking.bookedAt.toISOString(),
    ].map(escape).join(","));
  }
  // Totals row
  lines.push("");
  lines.push([
    "TOTALS (confirmed)", "", "", "", data.kpis.totalPlayers, "confirmed",
    "", "",
    rupees(data.kpis.totalRevenuePaise),
    rupees(data.kpis.totalMarkupRetainedPaise),
    data.commissionPct.toFixed(2),
    rupees(data.kpis.totalCommissionAccruedPaise),
    "",
  ].map(escape).join(","));

  const safeName = (data.orgName ?? `org-${orgId}`).replace(/[^a-z0-9]+/gi, "_");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="marketplace-finance-${safeName}-${fromDate.toISOString().slice(0,10)}-to-${toDate.toISOString().slice(0,10)}.csv"`);
  res.send(lines.join("\n"));
});

/* ─── GET /:slotId/bookings — Admin view bookings ───────────────── */

router.get("/:slotId/bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bookings = await db
    .select({
      booking: marketplaceBookingsTable,
      displayName: appUsersTable.displayName,
    })
    .from(marketplaceBookingsTable)
    .leftJoin(appUsersTable, eq(marketplaceBookingsTable.userId, appUsersTable.id))
    .where(and(
      eq(marketplaceBookingsTable.slotId, slotId),
      eq(marketplaceBookingsTable.organizationId, orgId),
    ))
    .orderBy(desc(marketplaceBookingsTable.bookedAt));

  res.json(bookings.map(r => ({
    ...r.booking,
    bookedAt: r.booking.bookedAt.toISOString(),
    cancelledAt: r.booking.cancelledAt?.toISOString() ?? null,
    displayName: r.displayName,
  })));
});

/* ─── POST /:slotId/book — Player books a slot ───────────────────── */

router.post("/:slotId/book", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));

  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number; displayName?: string; email?: string };

  const { players, notes } = req.body as { players?: number; notes?: string };
  const numPlayers = Math.max(1, Math.min(players ?? 1, 4));

  // Fetch slot and verify availability
  const [slot] = await db.select().from(marketplaceSlotsTable)
    .where(and(eq(marketplaceSlotsTable.id, slotId), eq(marketplaceSlotsTable.organizationId, orgId)));
  if (!slot) { { res.status(404).json({ error: "Slot not found" }); return; } }
  if (slot.status !== "open") { { res.status(400).json({ error: `Slot is ${slot.status}` }); return; } }
  if (slot.bookedPlayers + numPlayers > slot.maxPlayers) {
    res.status(400).json({ error: `Only ${slot.maxPlayers - slot.bookedPlayers} spots remaining` });
    return;
  }

  const totalPaise = slot.pricePaise * numPlayers;
  const isFree = totalPaise === 0;

  // Create booking (pending until payment confirmed or free)
  const [booking] = await db.insert(marketplaceBookingsTable).values({
    slotId,
    organizationId: orgId,
    userId: user.id,
    playerName: user.displayName ?? "Guest",
    playerEmail: user.email,
    players: numPlayers,
    amountPaise: totalPaise,
    paymentStatus: isFree ? "confirmed" : "pending",
    notes: notes ?? null,
  }).returning();

  if (isFree) {
    // Immediately reserve spots for free slots
    await db.update(marketplaceSlotsTable)
      .set({ bookedPlayers: sql`${marketplaceSlotsTable.bookedPlayers} + ${numPlayers}` })
      .where(eq(marketplaceSlotsTable.id, slotId));

    // Auto-close if full
    const updatedSlot = await db.select().from(marketplaceSlotsTable).where(eq(marketplaceSlotsTable.id, slotId)).then(r => r[0]);
    if (updatedSlot && updatedSlot.bookedPlayers >= updatedSlot.maxPlayers) {
      await db.update(marketplaceSlotsTable).set({ status: "full" }).where(eq(marketplaceSlotsTable.id, slotId));
      if (updatedSlot) updatedSlot.status = "full";
    }
    if (updatedSlot) broadcastSlotUpdate(orgId, formatSlot(updatedSlot));

    res.json({ booking: { ...booking, bookedAt: booking.bookedAt.toISOString() }, requiresPayment: false });
    return;
  }

  // Paid slot — create Razorpay order
  try {
    const rzp = getRazorpayClient();
    const keyId = getRazorpayKeyId();
    const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    const order = await rzp.orders.create({
      amount: totalPaise,
      currency: "INR",
      receipt: `mkt-booking-${booking.id}`,
      notes: { bookingId: String(booking.id), slotId: String(slotId), orgName: org?.name ?? "" },
    });

    await db.update(marketplaceBookingsTable)
      .set({ razorpayOrderId: order.id })
      .where(eq(marketplaceBookingsTable.id, booking.id));

    res.json({
      booking: { ...booking, razorpayOrderId: order.id, bookedAt: booking.bookedAt.toISOString() },
      requiresPayment: true,
      razorpayOrder: { orderId: order.id, amount: totalPaise, currency: "INR", keyId },
    });
  } catch (e) {
    logger.error({ e }, "[marketplace] Razorpay order creation failed");
    await db.delete(marketplaceBookingsTable).where(eq(marketplaceBookingsTable.id, booking.id));
    res.status(500).json({ error: "Payment gateway error. Please try again." });
  }
});

/* ─── POST /:slotId/payment/verify — Confirm Razorpay payment ───── */

router.post("/:slotId/payment/verify", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as {
    bookingId: number;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  };

  // 1. Fetch booking first to validate ownership + order binding
  const [booking] = await db.select().from(marketplaceBookingsTable)
    .where(and(
      eq(marketplaceBookingsTable.id, bookingId),
      eq(marketplaceBookingsTable.slotId, slotId),
      eq(marketplaceBookingsTable.organizationId, orgId),
    ));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  // 2. Verify ownership with org-scoped admin check
  const user = req.user as { id: number; role?: string; organizationId?: number | null };
  const adminForOrg = await isOrgAdminForOrg(user, orgId);
  if (!adminForOrg && booking.userId !== user.id) {
    res.status(403).json({ error: "You do not own this booking" });
    return;
  }

  // 3. Verify that the razorpayOrderId matches what we issued for this booking
  if (!booking.razorpayOrderId || booking.razorpayOrderId !== razorpayOrderId) {
    res.status(400).json({ error: "Order ID does not match booking record" });
    return;
  }

  // 4. Verify that booking is still pending (prevent duplicate confirmation)
  if (booking.paymentStatus === "confirmed") {
    res.json({ success: true, alreadyConfirmed: true }); return;
  }
  if (booking.paymentStatus === "cancelled") {
    res.status(400).json({ error: "Booking has been cancelled" }); return;
  }

  // 5. Verify Razorpay HMAC signature (binding orderId + paymentId)
  const secret = process.env.RAZORPAY_KEY_SECRET ?? "";
  const body = razorpayOrderId + "|" + razorpayPaymentId;
  const expectedSignature = crypto.createHmac("sha256", secret).update(body).digest("hex");

  if (expectedSignature !== razorpaySignature) {
    res.status(400).json({ error: "Invalid payment signature" });
    return;
  }

  await db.update(marketplaceBookingsTable).set({
    paymentStatus: "confirmed",
    razorpayPaymentId,
  }).where(eq(marketplaceBookingsTable.id, bookingId));

  // Reserve spots in slot
  await db.update(marketplaceSlotsTable)
    .set({ bookedPlayers: sql`${marketplaceSlotsTable.bookedPlayers} + ${booking.players}` })
    .where(eq(marketplaceSlotsTable.id, slotId));

  // Auto-close if full
  const updatedSlot = await db.select().from(marketplaceSlotsTable).where(eq(marketplaceSlotsTable.id, slotId)).then(r => r[0]);
  if (updatedSlot && updatedSlot.bookedPlayers >= updatedSlot.maxPlayers) {
    await db.update(marketplaceSlotsTable).set({ status: "full" }).where(eq(marketplaceSlotsTable.id, slotId));
  }

  // Broadcast slot update over SSE
  const finalSlotRows = await db.select({ slot: marketplaceSlotsTable, courseName: coursesTable.name })
    .from(marketplaceSlotsTable)
    .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
    .where(eq(marketplaceSlotsTable.id, slotId));
  if (finalSlotRows[0]) broadcastSlotUpdate(orgId, formatSlot(finalSlotRows[0].slot, finalSlotRows[0].courseName ?? undefined));

  res.json({ success: true });
});

/* ─── GET /stream — SSE live slot availability ──────────────────── */

router.get("/stream", (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(": connected\n\n");
  addMarketplaceSSEClient(orgId, res);

  const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); } }, 30000);

  req.on("close", () => {
    clearInterval(hb);
    removeMarketplaceSSEClient(orgId, res);
  });
});

/* ─── POST /:slotId/cancel/:bookingId — Cancel booking ──────────── */

router.post("/:slotId/cancel/:bookingId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));

  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number; role?: string; organizationId?: number | null };

  // Fetch booking with full org scoping to prevent cross-org access
  const [booking] = await db.select().from(marketplaceBookingsTable)
    .where(and(
      eq(marketplaceBookingsTable.id, bookingId),
      eq(marketplaceBookingsTable.slotId, slotId),
      eq(marketplaceBookingsTable.organizationId, orgId),
    ));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  // Org-scoped admin check: membership in THIS org, not just global role
  const adminForOrg = await isOrgAdminForOrg(user, orgId);
  if (!adminForOrg && booking.userId !== user.id) {
    res.status(403).json({ error: "You can only cancel your own bookings" });
    return;
  }
  if (booking.cancelledAt) { { res.status(400).json({ error: "Booking already cancelled" }); return; } }

  // Club-configurable cancellation window (defaults to 24h).
  // A value of 0 means player self-cancellation is completely disabled.
  // Admins bypass this restriction so they can manage last-minute issues.
  if (!adminForOrg) {
    const [orgRow] = await db.select({ cancelWindowHours: organizationsTable.marketplaceCancelWindowHours, slotDate: marketplaceSlotsTable.slotDate })
      .from(organizationsTable)
      .innerJoin(marketplaceSlotsTable, eq(marketplaceSlotsTable.id, slotId))
      .where(eq(organizationsTable.id, orgId));
    const cancelWindowHours = orgRow?.cancelWindowHours ?? 24;
    if (cancelWindowHours === 0) {
      res.status(400).json({ error: "Player self-cancellation is not allowed for this club. Please contact the club directly." });
      return;
    }
    const slotDate = orgRow?.slotDate;
    const hoursToSlot = slotDate ? (slotDate.getTime() - Date.now()) / 3_600_000 : Infinity;
    if (hoursToSlot < cancelWindowHours) {
      res.status(400).json({ error: `Cancellation is not allowed within ${cancelWindowHours} hour${cancelWindowHours !== 1 ? "s" : ""} of the tee time.` });
      return;
    }
  }

  // For paid confirmed bookings: attempt Razorpay refund BEFORE marking cancelled.
  // If refund fails, cancellation is aborted and the error is surfaced to the caller.
  let refundId: string | null = null;
  if (booking.paymentStatus === "confirmed" && booking.razorpayPaymentId && booking.amountPaise > 0) {
    try {
      const rzp = getRazorpayClient();
      const refund = await rzp.payments.refund(booking.razorpayPaymentId, {
        amount: booking.amountPaise,
        notes: { reason: "Booking cancelled", bookingId: String(bookingId) },
      });
      refundId = refund.id as string;
      logger.info({ bookingId, refundId }, "[marketplace] Refund issued");
    } catch (e) {
      logger.error({ e, bookingId }, "[marketplace] Razorpay refund failed — cancellation aborted");
      res.status(500).json({ error: "Refund could not be processed. Please contact the club to cancel." });
      return;
    }
  }

  await db.update(marketplaceBookingsTable)
    .set({ cancelledAt: new Date(), paymentStatus: "cancelled" })
    .where(eq(marketplaceBookingsTable.id, bookingId));

  // Return spots if booking was confirmed
  if (booking.paymentStatus === "confirmed") {
    await db.update(marketplaceSlotsTable)
      .set({
        bookedPlayers: sql`GREATEST(0, ${marketplaceSlotsTable.bookedPlayers} - ${booking.players})`,
        status: "open",
      })
      .where(eq(marketplaceSlotsTable.id, slotId));

    // Broadcast updated slot availability over SSE
    const updatedSlotRows = await db.select({ slot: marketplaceSlotsTable, courseName: coursesTable.name })
      .from(marketplaceSlotsTable)
      .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
      .where(eq(marketplaceSlotsTable.id, slotId));
    if (updatedSlotRows[0]) broadcastSlotUpdate(orgId, formatSlot(updatedSlotRows[0].slot, updatedSlotRows[0].courseName ?? undefined));
  }

  res.json({ success: true, refundId });
});

export default router;
