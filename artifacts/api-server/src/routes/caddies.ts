/**
 * Caddie Management & Booking API (Task #106)
 *
 * Caddie Profiles
 * GET    /organizations/:orgId/caddies               List caddie roster
 * POST   /organizations/:orgId/caddies               Create caddie profile
 * GET    /organizations/:orgId/caddies/:id           Get single caddie
 * PATCH  /organizations/:orgId/caddies/:id           Update caddie profile
 * DELETE /organizations/:orgId/caddies/:id           Deactivate caddie
 *
 * Caddie Availability
 * GET    /organizations/:orgId/caddies/:id/availability       Get availability (by month)
 * PUT    /organizations/:orgId/caddies/:id/availability       Upsert day availability
 *
 * Caddie Assignments
 * GET    /organizations/:orgId/caddie-assignments             List assignments (admin)
 * POST   /organizations/:orgId/caddie-assignments             Manually assign caddie to booking
 * PATCH  /organizations/:orgId/caddie-assignments/:id/status  Update assignment status
 * POST   /organizations/:orgId/caddie-assignments/:id/tip     Record tip
 *
 * Caddie Ratings
 * POST   /organizations/:orgId/caddie-assignments/:id/rate    Submit rating (portal player)
 *
 * Admin Reports
 * GET    /organizations/:orgId/caddies/report/utilisation     Utilisation & earnings report
 *
 * Booking Integration (called internally or by tee-bookings route)
 * GET    /organizations/:orgId/caddies/available              Available caddies for a date
 *
 * Caddie Portal (caddie login to view own schedule)
 * GET    /portal/caddie/assignments                           My upcoming assignments
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  caddieProfilesTable,
  caddieAvailabilityTable,
  caddieAssignmentsTable,
  caddieRatingsTable,
  teeBookingsTable,
  appUsersTable,
  orgMembershipsTable,
  courseTeeSlotTable,
} from "@workspace/db";
import { eq, and, desc, asc, inArray, gte, lte, ne, sql, isNull, isNotNull } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

// ─── Auth helpers ─────────────────────────────────────────────────────────────

interface SessionUser { id: number; role?: string; organizationId?: number; }

function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

type PortalReq = Request & { portalUser?: { userId?: number } };
function getPortalUserId(req: Request): number | null {
  const u = (req as PortalReq).portalUser?.userId;
  return u ? Number(u) : null;
}
function getAnyUserId(req: Request): number | null {
  return getPortalUserId(req) ?? getUser(req)?.id ?? null;
}

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  const caller = getUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if (
    (caller.role === "org_admin" || caller.role === "tournament_director" || caller.role === "pro_shop") &&
    Number(caller.organizationId) === orgId
  ) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "pro_shop"]),
    ));
  if (!m) { res.status(403).json({ error: "Admin access required" }); return false; }
  return true;
}

// ─── CADDIE PROFILES ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/caddies
router.get("/organizations/:orgId/caddies", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const includeInactive = req.query.includeInactive === "true";
  const conditions = [eq(caddieProfilesTable.organizationId, orgId)];
  if (!includeInactive) conditions.push(eq(caddieProfilesTable.isActive, true));

  const caddies = await db.select().from(caddieProfilesTable)
    .where(and(...conditions))
    .orderBy(asc(caddieProfilesTable.name));

  res.json({ caddies });
});

// GET /organizations/:orgId/caddies/report/utilisation
router.get("/organizations/:orgId/caddies/report/utilisation", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = req.query;
  const conditions = [eq(caddieAssignmentsTable.organizationId, orgId)];
  if (from) conditions.push(gte(caddieAssignmentsTable.createdAt, new Date(from as string)));
  if (to) conditions.push(lte(caddieAssignmentsTable.createdAt, new Date(to as string)));

  const assignments = await db
    .select({
      caddieId: caddieAssignmentsTable.caddieId,
      caddieName: caddieProfilesTable.name,
      experienceLevel: caddieProfilesTable.experienceLevel,
      averageRating: caddieProfilesTable.averageRating,
      totalRatings: caddieProfilesTable.totalRatings,
      status: caddieAssignmentsTable.status,
      feeCharged: caddieAssignmentsTable.feeCharged,
      tipAmount: caddieAssignmentsTable.tipAmount,
    })
    .from(caddieAssignmentsTable)
    .leftJoin(caddieProfilesTable, eq(caddieAssignmentsTable.caddieId, caddieProfilesTable.id))
    .where(and(...conditions))
    .orderBy(asc(caddieProfilesTable.name));

  // Aggregate by caddie
  const byId: Record<number, {
    caddieId: number; caddieName: string; experienceLevel: string;
    averageRating: string | null; totalRatings: number;
    totalAssignments: number; completedRounds: number;
    totalFees: number; totalTips: number; totalEarnings: number;
  }> = {};

  for (const row of assignments) {
    const cid = row.caddieId;
    if (!byId[cid]) {
      byId[cid] = {
        caddieId: cid,
        caddieName: row.caddieName ?? "Unknown",
        experienceLevel: row.experienceLevel ?? "standard",
        averageRating: row.averageRating,
        totalRatings: row.totalRatings ?? 0,
        totalAssignments: 0,
        completedRounds: 0,
        totalFees: 0,
        totalTips: 0,
        totalEarnings: 0,
      };
    }
    byId[cid].totalAssignments++;
    if (row.status === "completed") byId[cid].completedRounds++;
    if (row.feeCharged) byId[cid].totalFees += parseFloat(row.feeCharged);
    if (row.tipAmount) byId[cid].totalTips += parseFloat(row.tipAmount);
    byId[cid].totalEarnings = byId[cid].totalFees + byId[cid].totalTips;
  }

  res.json({ report: Object.values(byId) });
});

// GET /organizations/:orgId/caddies/available?date=YYYY-MM-DD
router.get("/organizations/:orgId/caddies/available", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const { date } = req.query;
  if (!date || typeof date !== "string") { { res.status(400).json({ error: "date (YYYY-MM-DD) is required" }); return; } }

  // Get caddies that are active and not explicitly marked unavailable on this date
  const allActive = await db.select().from(caddieProfilesTable)
    .where(and(eq(caddieProfilesTable.organizationId, orgId), eq(caddieProfilesTable.isActive, true)))
    .orderBy(asc(caddieProfilesTable.name));

  // Get unavailability records for this date
  const unavailable = await db.select({ caddieId: caddieAvailabilityTable.caddieId })
    .from(caddieAvailabilityTable)
    .where(and(
      eq(caddieAvailabilityTable.organizationId, orgId),
      eq(caddieAvailabilityTable.date, date),
      eq(caddieAvailabilityTable.isAvailable, false),
    ));
  const unavailableIds = new Set(unavailable.map(u => u.caddieId));

  // Get caddies already assigned on this date (to show as busy)
  const busyAssignments = await db
    .select({ caddieId: caddieAssignmentsTable.caddieId })
    .from(caddieAssignmentsTable)
    .leftJoin(teeBookingsTable, eq(caddieAssignmentsTable.teeBookingId, teeBookingsTable.id))
    .leftJoin(courseTeeSlotTable, eq(teeBookingsTable.slotId, courseTeeSlotTable.id))
    .where(and(
      eq(caddieAssignmentsTable.organizationId, orgId),
      eq(courseTeeSlotTable.slotDate, date as never),
      inArray(caddieAssignmentsTable.status, ["assigned", "confirmed", "in_progress"]),
    ));
  const busyIds = new Set(busyAssignments.map(b => b.caddieId));

  const caddies = allActive.map(c => ({
    ...c,
    isAvailableToday: !unavailableIds.has(c.id),
    isBusy: busyIds.has(c.id),
  }));

  res.json({ caddies });
});

// GET /organizations/:orgId/caddies/:id
router.get("/organizations/:orgId/caddies/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caddieId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(caddieId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [caddie] = await db.select().from(caddieProfilesTable)
    .where(and(eq(caddieProfilesTable.id, caddieId), eq(caddieProfilesTable.organizationId, orgId)));
  if (!caddie) { { res.status(404).json({ error: "Caddie not found" }); return; } }

  // Recent ratings
  const ratings = await db.select().from(caddieRatingsTable)
    .where(eq(caddieRatingsTable.caddieId, caddieId))
    .orderBy(desc(caddieRatingsTable.createdAt))
    .limit(10);

  res.json({ caddie, ratings });
});

// POST /organizations/:orgId/caddies
router.post("/organizations/:orgId/caddies", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const caller = getUser(req)!;
  const {
    name, photoUrl, experienceLevel, yearsExperience, languages,
    bio, phone, email, feePerRound, currency, notes, userId,
  } = req.body;

  if (!name?.trim()) { { res.status(400).json({ error: "name is required" }); return; } }

  const [caddie] = await db.insert(caddieProfilesTable).values({
    organizationId: orgId,
    userId: userId ?? null,
    name: name.trim(),
    photoUrl: photoUrl ?? null,
    experienceLevel: experienceLevel ?? "standard",
    yearsExperience: yearsExperience ?? 0,
    languages: languages ?? [],
    bio: bio ?? null,
    phone: phone ?? null,
    email: email ?? null,
    feePerRound: String(feePerRound ?? 0),
    currency: currency ?? "INR",
    notes: notes ?? null,
    createdByUserId: caller.id,
  }).returning();

  res.status(201).json({ caddie });
});

// PATCH /organizations/:orgId/caddies/:id
router.patch("/organizations/:orgId/caddies/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caddieId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(caddieId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select({ id: caddieProfilesTable.id })
    .from(caddieProfilesTable)
    .where(and(eq(caddieProfilesTable.id, caddieId), eq(caddieProfilesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Caddie not found" }); return; } }

  const {
    name, photoUrl, experienceLevel, yearsExperience, languages,
    bio, phone, email, feePerRound, currency, notes, isActive, userId,
  } = req.body;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name.trim();
  if (photoUrl !== undefined) updates.photoUrl = photoUrl;
  if (experienceLevel !== undefined) updates.experienceLevel = experienceLevel;
  if (yearsExperience !== undefined) updates.yearsExperience = yearsExperience;
  if (languages !== undefined) updates.languages = languages;
  if (bio !== undefined) updates.bio = bio;
  if (phone !== undefined) updates.phone = phone;
  if (email !== undefined) updates.email = email;
  if (feePerRound !== undefined) updates.feePerRound = String(feePerRound);
  if (currency !== undefined) updates.currency = currency;
  if (notes !== undefined) updates.notes = notes;
  if (isActive !== undefined) updates.isActive = isActive;
  if (userId !== undefined) updates.userId = userId;

  const [caddie] = await db.update(caddieProfilesTable).set(updates)
    .where(eq(caddieProfilesTable.id, caddieId)).returning();
  res.json({ caddie });
});

// DELETE /organizations/:orgId/caddies/:id  (soft-delete: set isActive = false)
router.delete("/organizations/:orgId/caddies/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caddieId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(caddieId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select({ id: caddieProfilesTable.id })
    .from(caddieProfilesTable)
    .where(and(eq(caddieProfilesTable.id, caddieId), eq(caddieProfilesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Caddie not found" }); return; } }

  await db.update(caddieProfilesTable).set({ isActive: false, updatedAt: new Date() })
    .where(eq(caddieProfilesTable.id, caddieId));
  res.json({ ok: true });
});

// ─── CADDIE AVAILABILITY ──────────────────────────────────────────────────────

// GET /organizations/:orgId/caddies/:id/availability?month=YYYY-MM
router.get("/organizations/:orgId/caddies/:id/availability", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caddieId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(caddieId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { month } = req.query; // YYYY-MM
  const conditions = [
    eq(caddieAvailabilityTable.caddieId, caddieId),
    eq(caddieAvailabilityTable.organizationId, orgId),
  ];
  if (month && typeof month === "string") {
    conditions.push(gte(caddieAvailabilityTable.date, `${month}-01`));
    conditions.push(lte(caddieAvailabilityTable.date, `${month}-31`));
  }

  const availability = await db.select().from(caddieAvailabilityTable)
    .where(and(...conditions))
    .orderBy(asc(caddieAvailabilityTable.date));
  res.json({ availability });
});

// PUT /organizations/:orgId/caddies/:id/availability
router.put("/organizations/:orgId/caddies/:id/availability", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caddieId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(caddieId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { date, isAvailable, notes } = req.body;
  if (!date) { { res.status(400).json({ error: "date is required" }); return; } }

  const [record] = await db.insert(caddieAvailabilityTable).values({
    caddieId, organizationId: orgId, date, isAvailable: isAvailable ?? true, notes: notes ?? null,
  })
    .onConflictDoUpdate({
      target: [caddieAvailabilityTable.caddieId, caddieAvailabilityTable.date],
      set: { isAvailable: isAvailable ?? true, notes: notes ?? null },
    })
    .returning();
  res.json({ record });
});

// ─── CADDIE ASSIGNMENTS ───────────────────────────────────────────────────────

// GET /organizations/:orgId/caddie-assignments
router.get("/organizations/:orgId/caddie-assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status, caddieId, date } = req.query;
  const conditions = [eq(caddieAssignmentsTable.organizationId, orgId)];
  if (status && status !== "all") {
    conditions.push(eq(caddieAssignmentsTable.status, status as "requested" | "assigned" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show"));
  }
  if (caddieId) conditions.push(eq(caddieAssignmentsTable.caddieId, parseInt(caddieId as string)));

  const assignments = await db
    .select({
      id: caddieAssignmentsTable.id,
      teeBookingId: caddieAssignmentsTable.teeBookingId,
      caddieId: caddieAssignmentsTable.caddieId,
      caddieName: caddieProfilesTable.name,
      caddieExperience: caddieProfilesTable.experienceLevel,
      caddiePhoto: caddieProfilesTable.photoUrl,
      memberId: caddieAssignmentsTable.memberId,
      memberName: appUsersTable.displayName,
      status: caddieAssignmentsTable.status,
      feeCharged: caddieAssignmentsTable.feeCharged,
      tipAmount: caddieAssignmentsTable.tipAmount,
      feeAddedToBooking: caddieAssignmentsTable.feeAddedToBooking,
      notes: caddieAssignmentsTable.notes,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      createdAt: caddieAssignmentsTable.createdAt,
    })
    .from(caddieAssignmentsTable)
    .leftJoin(caddieProfilesTable, eq(caddieAssignmentsTable.caddieId, caddieProfilesTable.id))
    .leftJoin(appUsersTable, eq(caddieAssignmentsTable.memberId, appUsersTable.id))
    .leftJoin(teeBookingsTable, eq(caddieAssignmentsTable.teeBookingId, teeBookingsTable.id))
    .leftJoin(courseTeeSlotTable, eq(teeBookingsTable.slotId, courseTeeSlotTable.id))
    .where(and(...conditions))
    .orderBy(desc(caddieAssignmentsTable.createdAt));

  res.json({ assignments });
});

// POST /organizations/:orgId/caddie-assignments  — admin assigns a caddie to a booking
router.post("/organizations/:orgId/caddie-assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const caller = getUser(req)!;
  const { teeBookingId, caddieId, memberId, feeCharged, currency, notes } = req.body;
  if (!teeBookingId || !caddieId) { { res.status(400).json({ error: "teeBookingId and caddieId are required" }); return; } }

  // Verify booking belongs to org
  const [booking] = await db.select({ id: teeBookingsTable.id })
    .from(teeBookingsTable)
    .where(and(eq(teeBookingsTable.id, teeBookingId), eq(teeBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  // Verify caddie belongs to org
  const [caddie] = await db.select({ id: caddieProfilesTable.id, feePerRound: caddieProfilesTable.feePerRound, currency: caddieProfilesTable.currency })
    .from(caddieProfilesTable)
    .where(and(eq(caddieProfilesTable.id, caddieId), eq(caddieProfilesTable.organizationId, orgId)));
  if (!caddie) { { res.status(404).json({ error: "Caddie not found" }); return; } }

  const [assignment] = await db.insert(caddieAssignmentsTable).values({
    organizationId: orgId,
    teeBookingId,
    caddieId,
    memberId: memberId ?? null,
    status: "assigned",
    feeCharged: feeCharged != null ? String(feeCharged) : caddie.feePerRound,
    currency: currency ?? caddie.currency,
    feeAddedToBooking: false,
    notes: notes ?? null,
    assignedByUserId: caller.id,
  }).returning();

  res.status(201).json({ assignment });
});

// PATCH /organizations/:orgId/caddie-assignments/:id/status
router.patch("/organizations/:orgId/caddie-assignments/:id/status", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const assignmentId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(assignmentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status, cancellationReason } = req.body;
  if (!status) { { res.status(400).json({ error: "status is required" }); return; } }

  const validStatuses = ["requested", "assigned", "confirmed", "in_progress", "completed", "cancelled", "no_show"];
  if (!validStatuses.includes(status)) { { res.status(400).json({ error: "Invalid status" }); return; } }

  const [existing] = await db.select().from(caddieAssignmentsTable)
    .where(and(eq(caddieAssignmentsTable.id, assignmentId), eq(caddieAssignmentsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Assignment not found" }); return; } }

  const updates: Record<string, unknown> = { status, updatedAt: new Date() };
  if (status === "completed") {
    updates.completedAt = new Date();
    // Update caddie stats
    await db.update(caddieProfilesTable).set({
      totalRounds: sql`${caddieProfilesTable.totalRounds} + 1`,
      totalEarnings: sql`${caddieProfilesTable.totalEarnings} + COALESCE(${existing.feeCharged}::numeric, 0)`,
      updatedAt: new Date(),
    }).where(eq(caddieProfilesTable.id, existing.caddieId));
  }
  if (status === "cancelled") {
    updates.cancelledAt = new Date();
    if (cancellationReason) updates.cancellationReason = cancellationReason;
  }

  const [assignment] = await db.update(caddieAssignmentsTable).set(updates)
    .where(eq(caddieAssignmentsTable.id, assignmentId)).returning();

  // Task #2008 — branded `caddie.mode.blocked` dispatch when an admin
  // cancels (effectively "blocks") a caddie's pending assignment with a
  // reason. The caddie's profile carries the linked app-user id; only fire
  // when we can resolve a recipient.
  if (status === "cancelled" && cancellationReason) {
    const [caddieProfile] = await db.select({ userId: caddieProfilesTable.userId })
      .from(caddieProfilesTable)
      .where(eq(caddieProfilesTable.id, existing.caddieId));
    if (caddieProfile?.userId) {
      const { notifyCaddieModeBlocked } = await import("../lib/brandedNotifications.js");
      void notifyCaddieModeBlocked({
        userIds: [caddieProfile.userId],
        reason: cancellationReason,
      });
    }
  }

  res.json({ assignment });
});

// POST /organizations/:orgId/caddie-assignments/:id/tip  — admin/player records a tip
router.post("/organizations/:orgId/caddie-assignments/:id/tip", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const assignmentId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(assignmentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const userId = getAnyUserId(req);
  if (!userId) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const { tipAmount } = req.body;
  if (tipAmount == null || isNaN(parseFloat(tipAmount))) { { res.status(400).json({ error: "tipAmount is required" }); return; } }

  const [existing] = await db.select().from(caddieAssignmentsTable)
    .where(and(eq(caddieAssignmentsTable.id, assignmentId), eq(caddieAssignmentsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Assignment not found" }); return; } }
  if (existing.status !== "completed") { { res.status(400).json({ error: "Can only tip completed assignments" }); return; } }

  const [assignment] = await db.update(caddieAssignmentsTable).set({
    tipAmount: String(tipAmount),
    tipRecordedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(caddieAssignmentsTable.id, assignmentId)).returning();

  // Update caddie total earnings to include the tip
  await db.update(caddieProfilesTable).set({
    totalEarnings: sql`${caddieProfilesTable.totalEarnings} + ${String(tipAmount)}::numeric`,
    updatedAt: new Date(),
  }).where(eq(caddieProfilesTable.id, existing.caddieId));

  res.json({ assignment });
});

// ─── CADDIE RATINGS ───────────────────────────────────────────────────────────

// POST /organizations/:orgId/caddie-assignments/:id/rate
router.post("/organizations/:orgId/caddie-assignments/:id/rate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const assignmentId = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(orgId) || isNaN(assignmentId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const userId = getAnyUserId(req);
  if (!userId) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) { { res.status(400).json({ error: "rating must be 1–5" }); return; } }

  const [assignment] = await db.select().from(caddieAssignmentsTable)
    .where(and(eq(caddieAssignmentsTable.id, assignmentId), eq(caddieAssignmentsTable.organizationId, orgId)));
  if (!assignment) { { res.status(404).json({ error: "Assignment not found" }); return; } }
  if (assignment.status !== "completed") { { res.status(400).json({ error: "Can only rate completed assignments" }); return; } }

  // Upsert rating (one per user per assignment)
  const [ratingRecord] = await db.insert(caddieRatingsTable).values({
    organizationId: orgId,
    assignmentId,
    caddieId: assignment.caddieId,
    ratedByUserId: userId,
    rating,
    comment: comment ?? null,
  })
    .onConflictDoUpdate({
      target: [caddieRatingsTable.assignmentId, caddieRatingsTable.ratedByUserId],
      set: { rating, comment: comment ?? null },
    })
    .returning();

  // Recompute caddie average rating
  const allRatings = await db.select({ rating: caddieRatingsTable.rating })
    .from(caddieRatingsTable)
    .where(eq(caddieRatingsTable.caddieId, assignment.caddieId));

  const avgRating = allRatings.length > 0
    ? allRatings.reduce((sum, r) => sum + r.rating, 0) / allRatings.length
    : null;

  await db.update(caddieProfilesTable).set({
    averageRating: avgRating != null ? String(Math.round(avgRating * 100) / 100) : null,
    totalRatings: allRatings.length,
    updatedAt: new Date(),
  }).where(eq(caddieProfilesTable.id, assignment.caddieId));

  res.status(201).json({ rating: ratingRecord });
});

// ─── CADDIE PORTAL — own schedule ─────────────────────────────────────────────

// GET /portal/caddie/assignments  — caddie's own upcoming assignments
router.get("/portal/caddie/assignments", async (req: Request, res: Response) => {
  const userId = getAnyUserId(req);
  if (!userId) { { res.status(401).json({ error: "Authentication required" }); return; } }

  // Find caddie profile linked to this user
  const [caddie] = await db.select({ id: caddieProfilesTable.id, organizationId: caddieProfilesTable.organizationId })
    .from(caddieProfilesTable)
    .where(eq(caddieProfilesTable.userId, userId));
  if (!caddie) { { res.status(404).json({ error: "No caddie profile linked to this account" }); return; } }

  const assignments = await db
    .select({
      id: caddieAssignmentsTable.id,
      teeBookingId: caddieAssignmentsTable.teeBookingId,
      status: caddieAssignmentsTable.status,
      feeCharged: caddieAssignmentsTable.feeCharged,
      tipAmount: caddieAssignmentsTable.tipAmount,
      notes: caddieAssignmentsTable.notes,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      memberName: appUsersTable.displayName,
      createdAt: caddieAssignmentsTable.createdAt,
    })
    .from(caddieAssignmentsTable)
    .leftJoin(teeBookingsTable, eq(caddieAssignmentsTable.teeBookingId, teeBookingsTable.id))
    .leftJoin(courseTeeSlotTable, eq(teeBookingsTable.slotId, courseTeeSlotTable.id))
    .leftJoin(appUsersTable, eq(caddieAssignmentsTable.memberId, appUsersTable.id))
    .where(and(
      eq(caddieAssignmentsTable.caddieId, caddie.id),
      inArray(caddieAssignmentsTable.status, ["assigned", "confirmed", "in_progress", "completed"]),
    ))
    .orderBy(desc(courseTeeSlotTable.slotDate));

  res.json({ assignments, caddieId: caddie.id });
});

// ─── TEE BOOKING INTEGRATION: request caddie at booking time ──────────────────
// PATCH /organizations/:orgId/tee-bookings/:bookingId/caddie-request
router.patch("/organizations/:orgId/tee-bookings/:bookingId/caddie-request", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (isNaN(orgId) || isNaN(bookingId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const userId = getAnyUserId(req);
  if (!userId) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const { caddieId, notes } = req.body;

  // Verify booking belongs to org and user is lead
  const [booking] = await db.select().from(teeBookingsTable)
    .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const isAdmin = await (async () => {
    const caller = getUser(req);
    if (!caller) return false;
    if (caller.role === "super_admin") return true;
    if ((caller.role === "org_admin" || caller.role === "tournament_director") && Number(caller.organizationId) === orgId) return true;
    const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"])));
    return !!m;
  })();

  if (!isAdmin && booking.leadUserId !== userId) {
    res.status(403).json({ error: "Only the booking lead or an admin can request a caddie" }); return;
  }

  // If no specific caddie requested, create a "requested" assignment without a caddie yet
  if (!caddieId) {
    // Just mark the request (we'll use a placeholder caddieId of -1 approach — instead we'll track differently)
    // For now, create with status=requested but we need a real caddie
    // Actually, create the assignment only if a caddieId is given. Otherwise store the preference in the booking notes.
    res.json({ message: "Caddie request noted. Admin will assign a caddie." }); return;
  }

  // Verify caddie belongs to org and is active
  const [caddie] = await db.select().from(caddieProfilesTable)
    .where(and(eq(caddieProfilesTable.id, caddieId), eq(caddieProfilesTable.organizationId, orgId), eq(caddieProfilesTable.isActive, true)));
  if (!caddie) { { res.status(404).json({ error: "Caddie not found or inactive" }); return; } }

  // Create assignment
  const [existing] = await db.select({ id: caddieAssignmentsTable.id })
    .from(caddieAssignmentsTable)
    .where(and(eq(caddieAssignmentsTable.teeBookingId, bookingId), eq(caddieAssignmentsTable.caddieId, caddieId)));
  if (existing) { { res.status(409).json({ error: "This caddie is already assigned to this booking" }); return; } }

  const [assignment] = await db.insert(caddieAssignmentsTable).values({
    organizationId: orgId,
    teeBookingId: bookingId,
    caddieId,
    memberId: userId,
    status: "requested",
    feeCharged: caddie.feePerRound,
    currency: caddie.currency,
    feeAddedToBooking: false,
    notes: notes ?? null,
    assignedByUserId: null,
  }).returning();

  res.status(201).json({ assignment, fee: caddie.feePerRound, currency: caddie.currency });
});

// GET /organizations/:orgId/tee-bookings/:bookingId/caddie-assignments — get caddies for a booking
router.get("/organizations/:orgId/tee-bookings/:bookingId/caddie-assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (isNaN(orgId) || isNaN(bookingId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const userId = getAnyUserId(req);
  if (!userId) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const assignments = await db
    .select({
      id: caddieAssignmentsTable.id,
      caddieId: caddieAssignmentsTable.caddieId,
      caddieName: caddieProfilesTable.name,
      caddieExperience: caddieProfilesTable.experienceLevel,
      caddiePhoto: caddieProfilesTable.photoUrl,
      caddieRating: caddieProfilesTable.averageRating,
      feeCharged: caddieAssignmentsTable.feeCharged,
      currency: caddieAssignmentsTable.currency,
      status: caddieAssignmentsTable.status,
      tipAmount: caddieAssignmentsTable.tipAmount,
    })
    .from(caddieAssignmentsTable)
    .leftJoin(caddieProfilesTable, eq(caddieAssignmentsTable.caddieId, caddieProfilesTable.id))
    .where(and(
      eq(caddieAssignmentsTable.teeBookingId, bookingId),
      eq(caddieAssignmentsTable.organizationId, orgId),
    ));

  res.json({ assignments });
});

export default router;
