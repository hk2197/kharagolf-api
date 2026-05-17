/**
 * Rental Equipment Management API
 *
 * Categories
 * GET    /organizations/:orgId/rentals/categories            List categories
 * POST   /organizations/:orgId/rentals/categories            Create category
 * PATCH  /organizations/:orgId/rentals/categories/:id        Update category
 * DELETE /organizations/:orgId/rentals/categories/:id        Delete category
 *
 * Assets
 * GET    /organizations/:orgId/rentals/assets                List assets (with availability)
 * POST   /organizations/:orgId/rentals/assets                Register asset
 * PATCH  /organizations/:orgId/rentals/assets/:id            Update asset
 * DELETE /organizations/:orgId/rentals/assets/:id            Retire/delete asset
 *
 * Availability
 * GET    /organizations/:orgId/rentals/availability          Check availability for a date
 *
 * Bookings
 * GET    /organizations/:orgId/rentals/bookings              List bookings
 * POST   /organizations/:orgId/rentals/bookings              Create booking
 * PATCH  /organizations/:orgId/rentals/bookings/:id/checkout Check out asset
 * PATCH  /organizations/:orgId/rentals/bookings/:id/checkin  Check in / return asset
 * PATCH  /organizations/:orgId/rentals/bookings/:id/cancel   Cancel booking
 * POST   /organizations/:orgId/rentals/bookings/:id/cancel/mine
 *                                                            Self-service cancel (member)
 * POST   /organizations/:orgId/rentals/bookings/:id/damage   File damage report
 *
 * Revenue
 * GET    /organizations/:orgId/rentals/revenue               Revenue report by category/asset
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  rentalCategoriesTable,
  rentalAssetsTable,
  rentalBookingsTable,
  clubMembersTable,
  appUsersTable,
  orgMembershipsTable,
  teeBookingsTable,
} from "@workspace/db";
import { eq, and, or, inArray, desc, asc, gte, lte, sql, isNull, ne } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if (
    (user.role === "org_admin" || user.role === "tournament_director" || user.role === "pro_shop") &&
    Number(user.organizationId) === orgId
  )
    return true;
  const [m] = await db
    .select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(
      and(
        eq(orgMembershipsTable.organizationId, orgId),
        eq(orgMembershipsTable.userId, user.id),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "pro_shop"]),
      ),
    );
  if (!m) {
    res.status(403).json({ error: "Organization admin access required" });
    return false;
  }
  return true;
}

function getAuthUserId(req: Request): number | null {
  const u = req as unknown as {
    portalUser?: { userId?: number };
    user?: { id?: number };
  };
  const id = u.portalUser?.userId ?? u.user?.id;
  return id ? Number(id) : null;
}

// ─── CATEGORIES ───────────────────────────────────────────────────────────────

router.get("/categories", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const cats = await db
    .select()
    .from(rentalCategoriesTable)
    .where(eq(rentalCategoriesTable.organizationId, orgId))
    .orderBy(asc(rentalCategoriesTable.sortOrder), asc(rentalCategoriesTable.name));

  res.json(cats);
});

router.post("/categories", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, dailyRate, currency, icon, sortOrder } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [cat] = await db
    .insert(rentalCategoriesTable)
    .values({
      organizationId: orgId,
      name,
      description: description ?? null,
      dailyRate: dailyRate ?? "0",
      currency: currency ?? "USD",
      icon: icon ?? "package",
      sortOrder: sortOrder ?? 0,
    })
    .returning();

  res.status(201).json(cat);
});

router.patch("/categories/:catId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const catId = parseInt(String((req.params as Record<string, string>).catId));
  const { name, description, dailyRate, currency, icon, isActive, sortOrder } = req.body;

  const [cat] = await db
    .update(rentalCategoriesTable)
    .set({
      ...(name !== undefined && { name }),
      ...(description !== undefined && { description }),
      ...(dailyRate !== undefined && { dailyRate }),
      ...(currency !== undefined && { currency }),
      ...(icon !== undefined && { icon }),
      ...(isActive !== undefined && { isActive }),
      ...(sortOrder !== undefined && { sortOrder }),
      updatedAt: new Date(),
    })
    .where(and(eq(rentalCategoriesTable.id, catId), eq(rentalCategoriesTable.organizationId, orgId)))
    .returning();

  if (!cat) { { res.status(404).json({ error: "Category not found" }); return; } }
  res.json(cat);
});

router.delete("/categories/:catId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const catId = parseInt(String((req.params as Record<string, string>).catId));

  const [assetCheck] = await db
    .select({ id: rentalAssetsTable.id })
    .from(rentalAssetsTable)
    .where(and(eq(rentalAssetsTable.categoryId, catId), eq(rentalAssetsTable.isActive, true)))
    .limit(1);

  if (assetCheck) {
    res.status(409).json({ error: "Category has active assets. Retire all assets first." });
    return;
  }

  await db
    .delete(rentalCategoriesTable)
    .where(and(eq(rentalCategoriesTable.id, catId), eq(rentalCategoriesTable.organizationId, orgId)));

  res.json({ success: true });
});

// ─── ASSETS ───────────────────────────────────────────────────────────────────

router.get("/assets", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { categoryId, includeRetired } = req.query;

  const conditions = [eq(rentalAssetsTable.organizationId, orgId)];
  if (categoryId) conditions.push(eq(rentalAssetsTable.categoryId, parseInt(categoryId as string)));
  if (!includeRetired || includeRetired === "false") conditions.push(eq(rentalAssetsTable.isActive, true));

  const assets = await db
    .select({
      id: rentalAssetsTable.id,
      organizationId: rentalAssetsTable.organizationId,
      categoryId: rentalAssetsTable.categoryId,
      assetCode: rentalAssetsTable.assetCode,
      description: rentalAssetsTable.description,
      condition: rentalAssetsTable.condition,
      dailyRateOverride: rentalAssetsTable.dailyRateOverride,
      notes: rentalAssetsTable.notes,
      isActive: rentalAssetsTable.isActive,
      retiredAt: rentalAssetsTable.retiredAt,
      createdAt: rentalAssetsTable.createdAt,
      updatedAt: rentalAssetsTable.updatedAt,
      categoryName: rentalCategoriesTable.name,
      categoryDailyRate: rentalCategoriesTable.dailyRate,
      categoryCurrency: rentalCategoriesTable.currency,
      categoryIcon: rentalCategoriesTable.icon,
    })
    .from(rentalAssetsTable)
    .innerJoin(rentalCategoriesTable, eq(rentalCategoriesTable.id, rentalAssetsTable.categoryId))
    .where(and(...conditions))
    .orderBy(asc(rentalCategoriesTable.name), asc(rentalAssetsTable.assetCode));

  // Attach active booking status to each asset
  const assetIds = assets.map(a => a.id);
  let activeBookings: Array<{ assetId: number; bookingId: number; status: string; memberName: string | null }> = [];
  if (assetIds.length > 0) {
    activeBookings = await db
      .select({
        assetId: rentalBookingsTable.assetId,
        bookingId: rentalBookingsTable.id,
        status: rentalBookingsTable.status,
        memberName: rentalBookingsTable.memberName,
      })
      .from(rentalBookingsTable)
      .where(
        and(
          inArray(rentalBookingsTable.assetId, assetIds),
          inArray(rentalBookingsTable.status, ["reserved", "checked_out"]),
        ),
      );
  }

  const bookingMap = new Map<number, (typeof activeBookings)[0]>();
  for (const b of activeBookings) bookingMap.set(b.assetId, b);

  res.json(
    assets.map(a => ({
      ...a,
      effectiveRate: a.dailyRateOverride ?? a.categoryDailyRate,
      currency: a.categoryCurrency,
      activeBooking: bookingMap.get(a.id) ?? null,
    })),
  );
});

router.post("/assets", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { categoryId, assetCode, description, condition, dailyRateOverride, notes } = req.body;
  if (!categoryId || !assetCode) {
    res.status(400).json({ error: "categoryId and assetCode are required" });
    return;
  }

  const [catCheck] = await db
    .select({ id: rentalCategoriesTable.id })
    .from(rentalCategoriesTable)
    .where(and(eq(rentalCategoriesTable.id, categoryId), eq(rentalCategoriesTable.organizationId, orgId)));
  if (!catCheck) { { res.status(400).json({ error: "Category not found in this organization" }); return; } }

  const [asset] = await db
    .insert(rentalAssetsTable)
    .values({
      organizationId: orgId,
      categoryId,
      assetCode,
      description: description ?? null,
      condition: condition ?? "good",
      dailyRateOverride: dailyRateOverride ?? null,
      notes: notes ?? null,
    })
    .returning();

  res.status(201).json(asset);
});

router.patch("/assets/:assetId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const assetId = parseInt(String((req.params as Record<string, string>).assetId));
  const { assetCode, description, condition, dailyRateOverride, notes, isActive } = req.body;

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (assetCode !== undefined) updateData.assetCode = assetCode;
  if (description !== undefined) updateData.description = description;
  if (condition !== undefined) updateData.condition = condition;
  if (dailyRateOverride !== undefined) updateData.dailyRateOverride = dailyRateOverride;
  if (notes !== undefined) updateData.notes = notes;
  if (isActive !== undefined) {
    updateData.isActive = isActive;
    if (!isActive) updateData.retiredAt = new Date();
  }

  const [asset] = await db
    .update(rentalAssetsTable)
    .set(updateData)
    .where(and(eq(rentalAssetsTable.id, assetId), eq(rentalAssetsTable.organizationId, orgId)))
    .returning();

  if (!asset) { { res.status(404).json({ error: "Asset not found" }); return; } }
  res.json(asset);
});

router.delete("/assets/:assetId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const assetId = parseInt(String((req.params as Record<string, string>).assetId));

  const [active] = await db
    .select({ id: rentalBookingsTable.id })
    .from(rentalBookingsTable)
    .where(
      and(
        eq(rentalBookingsTable.assetId, assetId),
        inArray(rentalBookingsTable.status, ["reserved", "checked_out"]),
      ),
    )
    .limit(1);

  if (active) {
    res.status(409).json({ error: "Asset has active bookings. Return or cancel them first." });
    return;
  }

  await db
    .delete(rentalAssetsTable)
    .where(and(eq(rentalAssetsTable.id, assetId), eq(rentalAssetsTable.organizationId, orgId)));

  res.json({ success: true });
});

// ─── AVAILABILITY ─────────────────────────────────────────────────────────────

/**
 * GET /organizations/:orgId/rentals/availability?date=YYYY-MM-DD&categoryId=X
 * Returns all active assets with a flag indicating if they are available on that date.
 */
router.get("/availability", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { date, categoryId } = req.query;
  if (!date) { { res.status(400).json({ error: "date query param is required" }); return; } }

  const targetDate = new Date(date as string);
  if (isNaN(targetDate.getTime())) { { res.status(400).json({ error: "Invalid date" }); return; } }

  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const conditions = [
    eq(rentalAssetsTable.organizationId, orgId),
    eq(rentalAssetsTable.isActive, true),
  ];
  if (categoryId) conditions.push(eq(rentalAssetsTable.categoryId, parseInt(categoryId as string)));

  const assets = await db
    .select({
      id: rentalAssetsTable.id,
      assetCode: rentalAssetsTable.assetCode,
      description: rentalAssetsTable.description,
      condition: rentalAssetsTable.condition,
      dailyRateOverride: rentalAssetsTable.dailyRateOverride,
      categoryId: rentalAssetsTable.categoryId,
      categoryName: rentalCategoriesTable.name,
      categoryDailyRate: rentalCategoriesTable.dailyRate,
      categoryCurrency: rentalCategoriesTable.currency,
      categoryIcon: rentalCategoriesTable.icon,
    })
    .from(rentalAssetsTable)
    .innerJoin(rentalCategoriesTable, eq(rentalCategoriesTable.id, rentalAssetsTable.categoryId))
    .where(and(...conditions))
    .orderBy(asc(rentalCategoriesTable.sortOrder), asc(rentalAssetsTable.assetCode));

  if (assets.length === 0) { { res.json([]); return; } }

  const assetIds = assets.map(a => a.id);

  const bookedAssets = await db
    .select({ assetId: rentalBookingsTable.assetId })
    .from(rentalBookingsTable)
    .where(
      and(
        inArray(rentalBookingsTable.assetId, assetIds),
        inArray(rentalBookingsTable.status, ["reserved", "checked_out"]),
        lte(rentalBookingsTable.rentalDate, endOfDay),
        or(
          isNull(rentalBookingsTable.expectedReturnAt),
          gte(rentalBookingsTable.expectedReturnAt, startOfDay),
        ),
      ),
    );

  const bookedSet = new Set(bookedAssets.map(b => b.assetId));

  res.json(
    assets.map(a => ({
      ...a,
      effectiveRate: a.dailyRateOverride ?? a.categoryDailyRate,
      currency: a.categoryCurrency,
      available: !bookedSet.has(a.id),
    })),
  );
});

// ─── BOOKINGS ─────────────────────────────────────────────────────────────────

router.get("/bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status, assetId, memberId, fromDate, toDate } = req.query;

  const conditions = [eq(rentalBookingsTable.organizationId, orgId)];
  if (status) {
    const statuses = (status as string).split(",");
    conditions.push(inArray(rentalBookingsTable.status, statuses as never[]));
  }
  if (assetId) conditions.push(eq(rentalBookingsTable.assetId, parseInt(assetId as string)));
  if (memberId) conditions.push(eq(rentalBookingsTable.memberId, parseInt(memberId as string)));
  if (fromDate) conditions.push(gte(rentalBookingsTable.rentalDate, new Date(fromDate as string)));
  if (toDate) conditions.push(lte(rentalBookingsTable.rentalDate, new Date(toDate as string)));

  const bookings = await db
    .select({
      id: rentalBookingsTable.id,
      assetId: rentalBookingsTable.assetId,
      teeBookingId: rentalBookingsTable.teeBookingId,
      memberId: rentalBookingsTable.memberId,
      memberName: rentalBookingsTable.memberName,
      status: rentalBookingsTable.status,
      rentalDate: rentalBookingsTable.rentalDate,
      expectedReturnAt: rentalBookingsTable.expectedReturnAt,
      checkedOutAt: rentalBookingsTable.checkedOutAt,
      returnedAt: rentalBookingsTable.returnedAt,
      rateCharged: rentalBookingsTable.rateCharged,
      currency: rentalBookingsTable.currency,
      damageReported: rentalBookingsTable.damageReported,
      damageNotes: rentalBookingsTable.damageNotes,
      damagePhotoUrls: rentalBookingsTable.damagePhotoUrls,
      notes: rentalBookingsTable.notes,
      createdAt: rentalBookingsTable.createdAt,
      updatedAt: rentalBookingsTable.updatedAt,
      assetCode: rentalAssetsTable.assetCode,
      assetDescription: rentalAssetsTable.description,
      categoryId: rentalCategoriesTable.id,
      categoryName: rentalCategoriesTable.name,
      categoryIcon: rentalCategoriesTable.icon,
    })
    .from(rentalBookingsTable)
    .innerJoin(rentalAssetsTable, eq(rentalAssetsTable.id, rentalBookingsTable.assetId))
    .innerJoin(rentalCategoriesTable, eq(rentalCategoriesTable.id, rentalAssetsTable.categoryId))
    .where(and(...conditions))
    .orderBy(desc(rentalBookingsTable.rentalDate));

  res.json(bookings);
});

// GET /organizations/:orgId/rentals/my-bookings — member's own rental bookings
// Member-facing list endpoint, mirroring the lessons `/my-bookings` pattern
// (artifacts/api-server/src/routes/lessons.ts:553). The mobile portal's
// `(tabs)/rentals.tsx` "My Bookings" tab and the deep-link highlight from
// `MyUpcomingWidget` both call this — using the admin-only `/bookings` route
// previously returned 403 for player accounts and the row never appeared.
router.get("/my-bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const { status } = req.query;
  const conditions = [
    eq(rentalBookingsTable.organizationId, orgId),
    eq(rentalBookingsTable.bookedByUserId, userId),
  ];
  if (status) {
    const statuses = (status as string).split(",");
    conditions.push(inArray(rentalBookingsTable.status, statuses as never[]));
  }

  const bookings = await db
    .select({
      id: rentalBookingsTable.id,
      assetId: rentalBookingsTable.assetId,
      teeBookingId: rentalBookingsTable.teeBookingId,
      memberId: rentalBookingsTable.memberId,
      memberName: rentalBookingsTable.memberName,
      status: rentalBookingsTable.status,
      rentalDate: rentalBookingsTable.rentalDate,
      expectedReturnAt: rentalBookingsTable.expectedReturnAt,
      checkedOutAt: rentalBookingsTable.checkedOutAt,
      returnedAt: rentalBookingsTable.returnedAt,
      rateCharged: rentalBookingsTable.rateCharged,
      currency: rentalBookingsTable.currency,
      damageReported: rentalBookingsTable.damageReported,
      damageNotes: rentalBookingsTable.damageNotes,
      damagePhotoUrls: rentalBookingsTable.damagePhotoUrls,
      notes: rentalBookingsTable.notes,
      createdAt: rentalBookingsTable.createdAt,
      updatedAt: rentalBookingsTable.updatedAt,
      assetCode: rentalAssetsTable.assetCode,
      assetDescription: rentalAssetsTable.description,
      categoryId: rentalCategoriesTable.id,
      categoryName: rentalCategoriesTable.name,
      categoryIcon: rentalCategoriesTable.icon,
    })
    .from(rentalBookingsTable)
    .innerJoin(rentalAssetsTable, eq(rentalAssetsTable.id, rentalBookingsTable.assetId))
    .innerJoin(rentalCategoriesTable, eq(rentalCategoriesTable.id, rentalAssetsTable.categoryId))
    .where(and(...conditions))
    .orderBy(desc(rentalBookingsTable.rentalDate));

  res.json(bookings);
});

// GET /organizations/:orgId/rentals/bookings/:bookingId/mine — member's single booking detail
// Member-facing endpoint that surfaces a single rental booking with its asset
// and category info, only when the caller is the booker (bookedByUserId match).
// Returns 404 if the booking belongs to someone else, so we don't leak the
// existence of other members' bookings. Used by the web
// /rentals/bookings/:bookingId detail page (Task #1728).
router.get("/bookings/:bookingId/mine", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const callerId = getAuthUserId(req);
  if (callerId === null) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!Number.isFinite(bookingId)) { { res.status(400).json({ error: "Invalid bookingId" }); return; } }

  const [row] = await db
    .select({
      id: rentalBookingsTable.id,
      organizationId: rentalBookingsTable.organizationId,
      assetId: rentalBookingsTable.assetId,
      teeBookingId: rentalBookingsTable.teeBookingId,
      memberId: rentalBookingsTable.memberId,
      bookedByUserId: rentalBookingsTable.bookedByUserId,
      memberName: rentalBookingsTable.memberName,
      status: rentalBookingsTable.status,
      rentalDate: rentalBookingsTable.rentalDate,
      expectedReturnAt: rentalBookingsTable.expectedReturnAt,
      checkedOutAt: rentalBookingsTable.checkedOutAt,
      returnedAt: rentalBookingsTable.returnedAt,
      rateCharged: rentalBookingsTable.rateCharged,
      currency: rentalBookingsTable.currency,
      damageReported: rentalBookingsTable.damageReported,
      damageNotes: rentalBookingsTable.damageNotes,
      damagePhotoUrls: rentalBookingsTable.damagePhotoUrls,
      notes: rentalBookingsTable.notes,
      createdAt: rentalBookingsTable.createdAt,
      updatedAt: rentalBookingsTable.updatedAt,
      assetCode: rentalAssetsTable.assetCode,
      assetDescription: rentalAssetsTable.description,
      categoryId: rentalCategoriesTable.id,
      categoryName: rentalCategoriesTable.name,
      categoryIcon: rentalCategoriesTable.icon,
    })
    .from(rentalBookingsTable)
    .innerJoin(rentalAssetsTable, eq(rentalAssetsTable.id, rentalBookingsTable.assetId))
    .innerJoin(rentalCategoriesTable, eq(rentalCategoriesTable.id, rentalAssetsTable.categoryId))
    .where(and(
      eq(rentalBookingsTable.id, bookingId),
      eq(rentalBookingsTable.organizationId, orgId),
      eq(rentalBookingsTable.bookedByUserId, callerId),
    ));

  if (!row) { { res.status(404).json({ error: "Booking not found" }); return; } }

  res.json(row);
});

// POST /organizations/:orgId/rentals/bookings/:bookingId/cancel/mine — self-service cancel
// Member-facing companion to the admin PATCH /bookings/:id/cancel route.
// Lets the booker cancel their own rental from the web detail page (Task #2146)
// while the booking is still `reserved`. The admin route stays unchanged so
// pro-shop staff can still cancel post-checkout if needed; this one only
// flips reservations to `cancelled` and rejects every other state with 409.
// 404 (rather than 403) when the booking belongs to someone else, mirroring
// the `/mine` getter so we don't leak the existence of other members' rows.
router.post("/bookings/:bookingId/cancel/mine", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const callerId = getAuthUserId(req);
  if (callerId === null) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!Number.isFinite(bookingId)) { { res.status(400).json({ error: "Invalid bookingId" }); return; } }

  const [existing] = await db
    .select({ id: rentalBookingsTable.id, status: rentalBookingsTable.status })
    .from(rentalBookingsTable)
    .where(and(
      eq(rentalBookingsTable.id, bookingId),
      eq(rentalBookingsTable.organizationId, orgId),
      eq(rentalBookingsTable.bookedByUserId, callerId),
    ));

  if (!existing) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (existing.status !== "reserved") {
    res.status(409).json({ error: `Cannot cancel a booking with status '${existing.status}'` });
    return;
  }

  // Re-assert every guard in the UPDATE WHERE clause so the transition is
  // atomic — if the booking is concurrently checked out or cancelled
  // between the SELECT above and this statement, the UPDATE matches zero
  // rows and we surface 409 instead of silently overwriting a fresher
  // status. (Code review hardening for Task #2146.)
  const [booking] = await db
    .update(rentalBookingsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(
      eq(rentalBookingsTable.id, bookingId),
      eq(rentalBookingsTable.organizationId, orgId),
      eq(rentalBookingsTable.bookedByUserId, callerId),
      eq(rentalBookingsTable.status, "reserved"),
    ))
    .returning();

  if (!booking) {
    res.status(409).json({ error: "Booking is no longer reservable" });
    return;
  }

  // Re-fetch with the same join shape as `/mine` so the client can replace
  // its local state with one round-trip and keep rendering the page.
  const [row] = await db
    .select({
      id: rentalBookingsTable.id,
      organizationId: rentalBookingsTable.organizationId,
      assetId: rentalBookingsTable.assetId,
      teeBookingId: rentalBookingsTable.teeBookingId,
      memberId: rentalBookingsTable.memberId,
      bookedByUserId: rentalBookingsTable.bookedByUserId,
      memberName: rentalBookingsTable.memberName,
      status: rentalBookingsTable.status,
      rentalDate: rentalBookingsTable.rentalDate,
      expectedReturnAt: rentalBookingsTable.expectedReturnAt,
      checkedOutAt: rentalBookingsTable.checkedOutAt,
      returnedAt: rentalBookingsTable.returnedAt,
      rateCharged: rentalBookingsTable.rateCharged,
      currency: rentalBookingsTable.currency,
      damageReported: rentalBookingsTable.damageReported,
      damageNotes: rentalBookingsTable.damageNotes,
      damagePhotoUrls: rentalBookingsTable.damagePhotoUrls,
      notes: rentalBookingsTable.notes,
      createdAt: rentalBookingsTable.createdAt,
      updatedAt: rentalBookingsTable.updatedAt,
      assetCode: rentalAssetsTable.assetCode,
      assetDescription: rentalAssetsTable.description,
      categoryId: rentalCategoriesTable.id,
      categoryName: rentalCategoriesTable.name,
      categoryIcon: rentalCategoriesTable.icon,
    })
    .from(rentalBookingsTable)
    .innerJoin(rentalAssetsTable, eq(rentalAssetsTable.id, rentalBookingsTable.assetId))
    .innerJoin(rentalCategoriesTable, eq(rentalCategoriesTable.id, rentalAssetsTable.categoryId))
    .where(eq(rentalBookingsTable.id, booking.id));

  res.json(row ?? booking);
});

router.post("/bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    assetId, teeBookingId, memberId, memberName,
    rentalDate, expectedReturnAt, rateCharged, currency, notes,
  } = req.body;

  if (!assetId || !rentalDate) {
    res.status(400).json({ error: "assetId and rentalDate are required" });
    return;
  }

  const bookedByUserId = getAuthUserId(req);

  try {
    const [booking] = await db
      .insert(rentalBookingsTable)
      .values({
        organizationId: orgId,
        assetId,
        teeBookingId: teeBookingId ?? null,
        memberId: memberId ?? null,
        bookedByUserId,
        memberName: memberName ?? null,
        status: "reserved",
        rentalDate: new Date(rentalDate),
        expectedReturnAt: expectedReturnAt ? new Date(expectedReturnAt) : null,
        rateCharged: rateCharged ?? null,
        currency: currency ?? "USD",
        notes: notes ?? null,
      })
      .returning();

    res.status(201).json(booking);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("rental_bookings_asset_active_unique")) {
      res.status(409).json({ error: "Asset is already booked for this period" });
      return;
    }
    throw err;
  }
});

// Check-out
router.patch("/bookings/:bookingId/checkout", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const checkedOutByUserId = getAuthUserId(req);

  const [existing] = await db
    .select({ id: rentalBookingsTable.id, status: rentalBookingsTable.status })
    .from(rentalBookingsTable)
    .where(and(eq(rentalBookingsTable.id, bookingId), eq(rentalBookingsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (existing.status !== "reserved") {
    res.status(409).json({ error: `Cannot check out a booking with status '${existing.status}'` });
    return;
  }

  const [booking] = await db
    .update(rentalBookingsTable)
    .set({
      status: "checked_out",
      checkedOutAt: new Date(),
      checkedOutByUserId,
      updatedAt: new Date(),
    })
    .where(eq(rentalBookingsTable.id, bookingId))
    .returning();

  res.json(booking);
});

// Check-in (return)
router.patch("/bookings/:bookingId/checkin", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const returnedByUserId = getAuthUserId(req);
  const { damageReported, damageNotes, damagePhotoUrls, notes, condition } = req.body;

  const [existing] = await db
    .select({
      id: rentalBookingsTable.id,
      status: rentalBookingsTable.status,
      assetId: rentalBookingsTable.assetId,
    })
    .from(rentalBookingsTable)
    .where(and(eq(rentalBookingsTable.id, bookingId), eq(rentalBookingsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (existing.status !== "checked_out") {
    res.status(409).json({ error: `Cannot check in a booking with status '${existing.status}'` });
    return;
  }

  const updateData: Record<string, unknown> = {
    status: "returned",
    returnedAt: new Date(),
    returnedByUserId,
    updatedAt: new Date(),
  };
  if (damageReported !== undefined) updateData.damageReported = damageReported;
  if (damageNotes !== undefined) updateData.damageNotes = damageNotes;
  if (damagePhotoUrls !== undefined) updateData.damagePhotoUrls = damagePhotoUrls;
  if (notes !== undefined) updateData.notes = notes;

  const [booking] = await db
    .update(rentalBookingsTable)
    .set(updateData)
    .where(eq(rentalBookingsTable.id, bookingId))
    .returning();

  // Update asset condition if specified
  if (condition && existing.assetId) {
    await db
      .update(rentalAssetsTable)
      .set({ condition, updatedAt: new Date() })
      .where(eq(rentalAssetsTable.id, existing.assetId));
  }

  res.json(booking);
});

// Cancel booking
router.patch("/bookings/:bookingId/cancel", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));

  const [existing] = await db
    .select({ id: rentalBookingsTable.id, status: rentalBookingsTable.status })
    .from(rentalBookingsTable)
    .where(and(eq(rentalBookingsTable.id, bookingId), eq(rentalBookingsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (!["reserved", "checked_out"].includes(existing.status)) {
    res.status(409).json({ error: `Cannot cancel a booking with status '${existing.status}'` });
    return;
  }

  const [booking] = await db
    .update(rentalBookingsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(rentalBookingsTable.id, bookingId))
    .returning();

  res.json(booking);
});

// File damage report
router.post("/bookings/:bookingId/damage", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const { damageNotes, damagePhotoUrls, condition } = req.body;

  if (!damageNotes) { { res.status(400).json({ error: "damageNotes is required" }); return; } }

  const [existing] = await db
    .select({
      id: rentalBookingsTable.id,
      assetId: rentalBookingsTable.assetId,
    })
    .from(rentalBookingsTable)
    .where(and(eq(rentalBookingsTable.id, bookingId), eq(rentalBookingsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const [booking] = await db
    .update(rentalBookingsTable)
    .set({
      damageReported: true,
      damageNotes,
      damagePhotoUrls: damagePhotoUrls ?? [],
      updatedAt: new Date(),
    })
    .where(eq(rentalBookingsTable.id, bookingId))
    .returning();

  if (condition && existing.assetId) {
    await db
      .update(rentalAssetsTable)
      .set({ condition, updatedAt: new Date() })
      .where(eq(rentalAssetsTable.id, existing.assetId));
  }

  res.json(booking);
});

// ─── REVENUE REPORT ───────────────────────────────────────────────────────────

router.get("/revenue", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { fromDate, toDate } = req.query;

  const conditions = [
    eq(rentalBookingsTable.organizationId, orgId),
    inArray(rentalBookingsTable.status, ["checked_out", "returned"]),
  ];
  if (fromDate) conditions.push(gte(rentalBookingsTable.rentalDate, new Date(fromDate as string)));
  if (toDate) conditions.push(lte(rentalBookingsTable.rentalDate, new Date(toDate as string)));

  const rows = await db
    .select({
      categoryId: rentalCategoriesTable.id,
      categoryName: rentalCategoriesTable.name,
      categoryIcon: rentalCategoriesTable.icon,
      assetId: rentalAssetsTable.id,
      assetCode: rentalAssetsTable.assetCode,
      totalBookings: sql<number>`count(${rentalBookingsTable.id})`,
      totalRevenue: sql<string>`coalesce(sum(${rentalBookingsTable.rateCharged}), 0)`,
      currency: rentalBookingsTable.currency,
    })
    .from(rentalBookingsTable)
    .innerJoin(rentalAssetsTable, eq(rentalAssetsTable.id, rentalBookingsTable.assetId))
    .innerJoin(rentalCategoriesTable, eq(rentalCategoriesTable.id, rentalAssetsTable.categoryId))
    .where(and(...conditions))
    .groupBy(
      rentalCategoriesTable.id,
      rentalCategoriesTable.name,
      rentalCategoriesTable.icon,
      rentalAssetsTable.id,
      rentalAssetsTable.assetCode,
      rentalBookingsTable.currency,
    )
    .orderBy(asc(rentalCategoriesTable.name), asc(rentalAssetsTable.assetCode));

  // Group by category
  const categoryMap = new Map<
    number,
    {
      categoryId: number;
      categoryName: string;
      categoryIcon: string;
      totalBookings: number;
      totalRevenue: number;
      currency: string;
      assets: { assetId: number; assetCode: string; totalBookings: number; totalRevenue: number }[];
    }
  >();

  for (const r of rows) {
    let cat = categoryMap.get(r.categoryId);
    if (!cat) {
      cat = {
        categoryId: r.categoryId,
        categoryName: r.categoryName,
        categoryIcon: r.categoryIcon,
        totalBookings: 0,
        totalRevenue: 0,
        currency: r.currency,
        assets: [],
      };
      categoryMap.set(r.categoryId, cat);
    }
    const bookings = Number(r.totalBookings);
    const revenue = Number(r.totalRevenue);
    cat.totalBookings += bookings;
    cat.totalRevenue += revenue;
    cat.assets.push({ assetId: r.assetId, assetCode: r.assetCode, totalBookings: bookings, totalRevenue: revenue });
  }

  res.json({
    categories: Array.from(categoryMap.values()),
    grandTotal: Array.from(categoryMap.values()).reduce((sum, c) => sum + c.totalRevenue, 0),
  });
});

export default router;
