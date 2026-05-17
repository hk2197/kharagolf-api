/**
 * Tee Time Booking API
 *
 * GET    /organizations/:orgId/tee-bookings/slots         Available slots for a date
 * POST   /organizations/:orgId/tee-bookings/slots         Admin: create slot
 * PATCH  /organizations/:orgId/tee-bookings/slots/:id     Admin: update slot
 * GET    /organizations/:orgId/tee-bookings/pricing        Get pricing rules
 * PUT    /organizations/:orgId/tee-bookings/pricing        Admin: update pricing rules
 * POST   /organizations/:orgId/tee-bookings               Create booking
 * GET    /organizations/:orgId/tee-bookings               Admin: list all bookings
 * GET    /organizations/:orgId/tee-bookings/my            Player: my bookings
 * PATCH  /organizations/:orgId/tee-bookings/:id/cancel    Cancel booking
 * POST   /organizations/:orgId/tee-bookings/:id/confirm-player  Player confirms/declines invite
 */

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import {
  courseTeeSlotTable,
  teeBookingsTable,
  teeBookingPlayersTable,
  teePricingRulesTable,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  cartsTable,
  cartAssignmentsTable,
  clubMembersTable,
  teeBookingWindowsTable,
  teePlayerCountRulesTable,
  membershipTiersTable,
  clubCurrencyProfilesTable,
} from "@workspace/db";
import { eq, and, gte, lte, desc, sql, isNull, ilike, or } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendPushToUsers } from "../lib/push";
import { sendMarketplaceBookingEmail, sendTeeCancellationEmail } from "../lib/mailer";
import { logger } from "../lib/logger";
import { track } from "../lib/analytics";
import { awardPoints } from "./loyalty";
import { validateTeeBooking } from "../lib/teeValidation";
import { resolveBookingRates, resolveEffectivePrice } from "../lib/dynamicPricing";
import { recordEmailConversionForRequest } from "../lib/emailCtaConversion";
import {
  notifyBookingConfirmed,
  notifyBookingCancelled,
} from "../lib/brandedNotifications";

const router: IRouter = Router({ mergeParams: true });

/** Local type for portal (player) sessions added by portal-auth middleware */
type PortalReq = Request & { portalUser?: { userId?: number } };

function getAuthUserId(req: Request): number | null {
  const portalUserId = (req as PortalReq).portalUser?.userId;
  const userId = portalUserId ?? req.user?.id;
  return userId ? Number(userId) : null;
}

// Reusable middleware: gate all tee-booking routes that require Starter+ subscription
async function requireTeeBookingSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  const [org] = await db.select({ subscriptionTier: organizationsTable.subscriptionTier })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (org?.subscriptionTier === "free") {
    res.status(403).json({
      error: "Tee time booking requires a Starter or higher subscription.",
      code: "SUBSCRIPTION_REQUIRED",
      upgrade: {
        requiredTier: "starter",
        feature: "tee_time_booking",
        ctaText: "Upgrade to Starter",
        ctaUrl: "/super-admin?tab=billing",
      },
    }); return;
  }
  next();
}

// Apply subscription gate consistently across all tee-booking endpoints
router.use("/organizations/:orgId/tee-bookings", requireTeeBookingSubscription);

// ─── PRICING RULES ──────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-bookings/pricing", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const [rules] = await db.select().from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId));
  // Include the club's base currency so player-facing clients can render
  // multi-currency price displays without calling the admin-only /currency-tax/profile endpoint.
  const [profile] = await db
    .select({ baseCurrency: clubCurrencyProfilesTable.baseCurrency })
    .from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, orgId));
  const baseCurrency = (profile?.baseCurrency ?? "INR").toUpperCase();
  if (rules) {
    res.json({ ...rules, baseCurrency });
  } else {
    res.json({ baseCurrency });
  }
});

/** GET /organizations/:orgId/tee-rules/booking-windows-player — all windows (unauthenticated read) */
router.get("/organizations/:orgId/tee-rules/booking-windows-player", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const windows = await db
    .select()
    .from(teeBookingWindowsTable)
    .where(eq(teeBookingWindowsTable.organizationId, orgId));
  res.json(windows);
});

/**
 * GET /organizations/:orgId/tee-bookings/booking-window/me
 * Returns the booking window tier and daysAhead that applies to the authenticated user.
 * Resolves the user's club membership tier to map to tee_membership_tier enum.
 */
router.get("/organizations/:orgId/tee-bookings/booking-window/me", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = getAuthUserId(req);

  // Determine the user's effective tee membership tier
  let teeTier: "full_member" | "social_member" | "public" = "public";
  if (userId) {
    const [clubMember] = await db
      .select({ tierId: clubMembersTable.tierId })
      .from(clubMembersTable)
      .where(and(eq(clubMembersTable.userId, userId), eq(clubMembersTable.organizationId, orgId)));

    if (clubMember) {
      if (clubMember.tierId) {
        const [tier] = await db
          .select({ name: membershipTiersTable.name })
          .from(membershipTiersTable)
          .where(eq(membershipTiersTable.id, clubMember.tierId));
        const tierName = tier?.name?.toLowerCase() ?? "";
        teeTier = tierName.includes("social") ? "social_member" : "full_member";
      } else {
        teeTier = "full_member";
      }
    }
  }

  const [window] = await db
    .select()
    .from(teeBookingWindowsTable)
    .where(and(
      eq(teeBookingWindowsTable.organizationId, orgId),
      eq(teeBookingWindowsTable.membershipTier, teeTier),
    ));

  res.json({ tier: teeTier, daysAhead: window?.daysAhead ?? null });
});

/**
 * GET /organizations/:orgId/tee-bookings/slot-constraints?date=YYYY-MM-DD&courseId=N
 * Returns the effective player count rules for a given date/course so the mobile UI
 * can display inline constraints on each slot.
 */
router.get("/organizations/:orgId/tee-bookings/slot-constraints", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const { date, courseId } = req.query as { date?: string; courseId?: string };
  if (!date) { { res.status(400).json({ error: "date is required" }); return; } }

  const targetDate = new Date(date + "T00:00:00");
  const dow = targetDate.getDay();

  // When a specific courseId is requested, return org-wide + course-specific rules.
  // When no courseId is given, return ALL rules for the org (client filters per slot).
  const courseFilter = courseId
    ? sql`(${teePlayerCountRulesTable.courseId} IS NULL OR ${teePlayerCountRulesTable.courseId} = ${parseInt(courseId)})`
    : sql`1=1`;

  const rules = await db
    .select()
    .from(teePlayerCountRulesTable)
    .where(and(
      eq(teePlayerCountRulesTable.organizationId, orgId),
      eq(teePlayerCountRulesTable.isActive, true),
      courseFilter,
    ));

  // Filter to rules that apply on this day-of-week
  const activeRules = rules.filter(r => {
    if (!r.daysOfWeek) return true;
    const days = Array.isArray(r.daysOfWeek) ? r.daysOfWeek as number[] : [];
    return days.length === 0 || days.includes(dow);
  });

  // Include courseId so clients can filter constraints per slot
  res.json(activeRules.map(r => ({
    id: r.id,
    name: r.name,
    courseId: r.courseId ?? null,
    minPlayers: r.minPlayers,
    maxPlayers: r.maxPlayers,
    startTime: r.startTime,
    endTime: r.endTime,
    membershipTier: r.membershipTier,
    daysOfWeek: r.daysOfWeek,
  })));
});

router.put("/organizations/:orgId/tee-bookings/pricing", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    memberRate, guestRate, twilightStartTime, twilightMemberRate, twilightGuestRate,
    maxGuestsPerBooking, paymentModel, cancellationCutoffHours, cancellationPolicyType,
    cancellationFeeFlat, membersOnlyStartTime, membersOnlyEndTime,
    slotIntervalMinutes, firstTeeTime, lastTeeTime,
  } = req.body;

  const fields = {
    memberRate: String(memberRate ?? 0),
    guestRate: String(guestRate ?? 0),
    twilightStartTime: twilightStartTime ?? null,
    twilightMemberRate: twilightMemberRate != null ? String(twilightMemberRate) : null,
    twilightGuestRate: twilightGuestRate != null ? String(twilightGuestRate) : null,
    maxGuestsPerBooking: maxGuestsPerBooking ?? 3,
    paymentModel: paymentModel ?? "pay_at_checkin",
    cancellationCutoffHours: cancellationCutoffHours ?? 24,
    cancellationPolicyType: cancellationPolicyType ?? "forfeit",
    cancellationFeeFlat: cancellationFeeFlat != null ? String(cancellationFeeFlat) : null,
    membersOnlyStartTime: membersOnlyStartTime ?? null,
    membersOnlyEndTime: membersOnlyEndTime ?? null,
    slotIntervalMinutes: slotIntervalMinutes ?? 10,
    firstTeeTime: firstTeeTime ?? "06:00",
    lastTeeTime: lastTeeTime ?? "18:00",
  };

  const [rules] = await db.insert(teePricingRulesTable).values({
    organizationId: orgId,
    ...fields,
  }).onConflictDoUpdate({
    target: teePricingRulesTable.organizationId,
    set: { ...fields, updatedAt: new Date() },
  }).returning();

  res.json(rules);
});

// ─── SLOTS ───────────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-bookings/slots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const date = req.query.date ? new Date(String(req.query.date)) : new Date();
  const courseId = req.query.courseId ? parseInt(String(req.query.courseId)) : undefined;

  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const conditions = [
    eq(courseTeeSlotTable.organizationId, orgId),
    gte(courseTeeSlotTable.slotDate, dayStart),
    lte(courseTeeSlotTable.slotDate, dayEnd),
  ];
  if (courseId) conditions.push(eq(courseTeeSlotTable.courseId, courseId));

  const slots = await db
    .select({
      slot: courseTeeSlotTable,
      courseName: coursesTable.name,
    })
    .from(courseTeeSlotTable)
    .leftJoin(coursesTable, eq(courseTeeSlotTable.courseId, coursesTable.id))
    .where(and(...conditions))
    .orderBy(courseTeeSlotTable.slotTime);

  // Attach booking counts — use SUM(party_size) so a group of 4 takes 4 spots.
  // Include both confirmed AND pending bookings so displayed availability matches
  // the transactional capacity check (which also counts pending holds).
  const slotsWithCapacity = await Promise.all(slots.map(async ({ slot, courseName }) => {
    const [row] = await db
      .select({ totalSeats: sql<number>`COALESCE(SUM(party_size), 0)::int` })
      .from(teeBookingsTable)
      .where(and(eq(teeBookingsTable.slotId, slot.id), sql`${teeBookingsTable.status} NOT IN ('cancelled', 'forfeited')`));
    const bookedCount = row?.totalSeats ?? 0;

    // Surface effective price + deal badge (Task #367). Member rate is the headline.
    let effectivePrice: number | null = null;
    let basePrice: number | null = null;
    let dealBadge: string | null = null;
    let tierName: string | null = null;
    let pricingBreakdown: unknown[] = [];
    try {
      const r = await resolveEffectivePrice({
        orgId, courseId: slot.courseId, slotDate: slot.slotDate, slotTime: slot.slotTime,
        capacity: slot.capacity, bookedCount, memberType: "member",
      });
      effectivePrice = r.finalPrice;
      basePrice = r.basePrice;
      dealBadge = r.dealBadge;
      tierName = r.tierName;
      pricingBreakdown = r.breakdown ?? [];
    } catch (err) {
      logger.warn({ err, slotId: slot.id }, "[TeeBooking] price resolution failed");
    }

    return {
      ...slot, courseName, bookedCount, available: slot.capacity - bookedCount,
      effectivePrice, basePrice, dealBadge, tierName, pricingBreakdown,
    };
  }));

  res.json(slotsWithCapacity);
});

router.post("/organizations/:orgId/tee-bookings/slots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { courseId, slotDate, slotTime, capacity, isMembersOnly } = req.body;
  if (!courseId || !slotDate || !slotTime) { { res.status(400).json({ error: "courseId, slotDate, slotTime required" }); return; } }

  const [slot] = await db.insert(courseTeeSlotTable).values({
    courseId,
    organizationId: orgId,
    slotDate: new Date(slotDate),
    slotTime,
    capacity: capacity ?? 4,
    isMembersOnly: isMembersOnly ?? false,
  }).returning();

  res.status(201).json(slot);
});

router.patch("/organizations/:orgId/tee-bookings/slots/:slotId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const slotId = parseInt(String((req.params as Record<string, string>).slotId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status, capacity, isMembersOnly } = req.body;
  const [slot] = await db.update(courseTeeSlotTable).set({
    ...(status && { status }),
    ...(capacity != null && { capacity }),
    ...(isMembersOnly != null && { isMembersOnly }),
  }).where(and(eq(courseTeeSlotTable.id, slotId), eq(courseTeeSlotTable.organizationId, orgId))).returning();

  if (!slot) { { res.status(404).json({ error: "Slot not found" }); return; } }
  res.json(slot);
});

// ─── POST /organizations/:orgId/tee-bookings/slots/bulk-generate ─────────────
// Admin: Generate multiple tee-time slots at a regular interval for a given date.
// Respects members-only time-window config if fromTemplate=true (default).
// body: { courseId, date, startTime, endTime, intervalMinutes, capacity, isMembersOnly? }
router.post("/organizations/:orgId/tee-bookings/slots/bulk-generate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { courseId, date, startTime, endTime, intervalMinutes = 10, capacity = 4, isMembersOnly } = req.body;
  if (!courseId || !date || !startTime || !endTime) {
    res.status(400).json({ error: "courseId, date, startTime, endTime required" }); return;
  }

  // Fetch org pricing to auto-apply members-only window when isMembersOnly is not explicitly set
  const [pricing] = await db
    .select({ membersOnlyStartTime: teePricingRulesTable.membersOnlyStartTime, membersOnlyEndTime: teePricingRulesTable.membersOnlyEndTime })
    .from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId)).limit(1);

  const toMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + (m ?? 0);
  };

  const startMin = toMinutes(startTime);
  const endMin = toMinutes(endTime);
  const intervalMin = Math.max(1, parseInt(String(intervalMinutes), 10));

  const windowStartMin = pricing?.membersOnlyStartTime ? toMinutes(pricing.membersOnlyStartTime) : null;
  const windowEndMin = pricing?.membersOnlyEndTime ? toMinutes(pricing.membersOnlyEndTime) : null;

  const slotsToInsert = [];
  for (let min = startMin; min < endMin; min += intervalMin) {
    const h = Math.floor(min / 60).toString().padStart(2, "0");
    const m = (min % 60).toString().padStart(2, "0");
    const slotTime = `${h}:${m}`;

    // Determine isMembersOnly: explicit override takes precedence; else use time-window config
    const autoMembersOnly = windowStartMin !== null && windowEndMin !== null
      ? min >= windowStartMin && min < windowEndMin
      : false;
    const membersOnlyFlag = isMembersOnly != null ? Boolean(isMembersOnly) : autoMembersOnly;

    slotsToInsert.push({
      courseId,
      organizationId: orgId,
      slotDate: new Date(date),
      slotTime,
      capacity,
      isMembersOnly: membersOnlyFlag,
    });
  }

  if (slotsToInsert.length === 0) { { res.status(400).json({ error: "No slots to generate (check time range)" }); return; } }

  // Insert in bulk; skip duplicates (same org/course/date/time)
  const created = await db.insert(courseTeeSlotTable).values(slotsToInsert)
    .onConflictDoNothing()
    .returning();

  res.status(201).json({ created: created.length, total: slotsToInsert.length });
});

// ─── BOOKINGS ────────────────────────────────────────────────────────────────

router.post("/organizations/:orgId/tee-bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  // Verify caller is a member of this org via org_memberships (super_admin bypasses)
  const callerUser = req.user as { role?: string } | undefined;
  if (callerUser?.role !== "super_admin") {
    const [callerMember] = await db.select({ id: orgMembershipsTable.id })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)));
    if (!callerMember) {
      res.status(403).json({ error: "You are not a member of this organization" }); return;
    }
  }

  const { slotId, partySize: requestedPartySize, players, cartRequested, forUserId } = req.body;
  if (!slotId) { { res.status(400).json({ error: "slotId is required" }); return; } }

  // Admin can book on behalf of a member by supplying forUserId
  let effectiveLeadUserId = userId;
  if (forUserId && forUserId !== userId) {
    // Verify the caller has admin access (check without sending response)
    const callerForAdmin = req.user as { role?: string; organizationId?: number } | undefined;
    const callerRole = callerForAdmin?.role ?? "";
    const callerOrgId = callerForAdmin?.organizationId ?? null;
    const callerIsAdmin = callerRole === "super_admin"
      || ((callerRole === "org_admin" || callerRole === "tournament_director") && callerOrgId === orgId);
    let callerHasAdminMembership = false;
    if (!callerIsAdmin) {
      const [adminMembership] = await db.select({ role: orgMembershipsTable.role })
        .from(orgMembershipsTable)
        .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)));
      callerHasAdminMembership = adminMembership != null && ["org_admin", "tournament_director"].includes(adminMembership.role);
    }
    if (!callerIsAdmin && !callerHasAdminMembership) {
      res.status(403).json({ error: "Only admins can book on behalf of another member" }); return;
    }
    const [targetMember] = await db.select({ id: orgMembershipsTable.id })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, forUserId), eq(orgMembershipsTable.organizationId, orgId)));
    if (!targetMember) {
      res.status(400).json({ error: "Target member is not part of this organization" }); return;
    }
    effectiveLeadUserId = forUserId;
  }

  // Derive canonical partySize from actual players to keep composition consistent
  const extraPlayers = Array.isArray(players) ? players.length : 0;
  const minPartySize = 1 + extraPlayers; // lead + added players
  const partySize = requestedPartySize != null
    ? Math.max(requestedPartySize, minPartySize) // never fewer than actual players
    : minPartySize;
  if (partySize < 1 || partySize > 4) {
    res.status(400).json({ error: "Party size must be between 1 and 4" }); return;
  }

  // Tenant-scoped slot fetch to prevent cross-org slot references
  const [slot] = await db.select().from(courseTeeSlotTable)
    .where(and(eq(courseTeeSlotTable.id, slotId), eq(courseTeeSlotTable.organizationId, orgId)));
  if (!slot) { { res.status(404).json({ error: "Slot not found" }); return; } }
  if (slot.status === "blocked") { { res.status(400).json({ error: "This slot is not available" }); return; } }

  // Members-only enforcement: reject guest players on restricted slots
  if (slot.isMembersOnly) {
    const hasGuest = Array.isArray(players) && players.some((p: { type?: string }) => p.type === "guest");
    if (hasGuest) {
      res.status(400).json({ error: "This is a members-only time slot; guest players are not permitted." }); return;
    }
  }

  const [pricing] = await db.select().from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId));

  // ── Pricing engine (Task #367): resolve effective per-seat rates with dynamic
  //    pricing overlays (tier + demand modifiers + caps/floors). Falls back to
  //    legacy twilight rates from teePricingRulesTable when dynamic pricing is off.
  const [bookedRow] = await db.select({ booked: sql<number>`COALESCE(SUM(party_size),0)::int` })
    .from(teeBookingsTable)
    .where(and(eq(teeBookingsTable.slotId, slotId), sql`${teeBookingsTable.status} IN ('confirmed','pending')`));
  const resolved = await resolveBookingRates({
    orgId, courseId: slot.courseId, slotDate: slot.slotDate, slotTime: slot.slotTime,
    capacity: slot.capacity, bookedCount: bookedRow?.booked ?? 0,
  });
  const rates = { memberRate: resolved.memberRate, guestRate: resolved.guestRate };

  // Guest policy: enforce club-configurable guest limit (default 3 if not set)
  const guestCount = Array.isArray(players) ? players.filter((p: { type?: string }) => p.type === "guest").length : 0;
  const maxGuests = pricing?.maxGuestsPerBooking ?? 3;
  if (guestCount > maxGuests) {
    res.status(400).json({ error: `Maximum of ${maxGuests} guest player(s) allowed per booking per club policy.` }); return;
  }

  // Validate that all member userIds in the players array belong to this org.
  // This prevents cross-tenant invitation side-effects from crafted requests.
  if (Array.isArray(players)) {
    const memberUserIds: number[] = players
      .filter((p: { type?: string; userId?: number }) => p.type !== "guest" && p.userId != null)
      .map((p: { userId?: number }) => p.userId as number);

    if (memberUserIds.length > 0) {
      const memberships = await db
        .select({ userId: orgMembershipsTable.userId })
        .from(orgMembershipsTable)
        .where(and(
          eq(orgMembershipsTable.organizationId, orgId),
          sql`${orgMembershipsTable.userId} = ANY(ARRAY[${sql.join(memberUserIds.map(id => sql`${id}`), sql`, `)}]::int[])`,
        ));
      const validMemberSet = new Set(memberships.map(m => m.userId));
      const invalidId = memberUserIds.find(id => !validMemberSet.has(id));
      if (invalidId != null) {
        res.status(400).json({ error: "One or more invited players are not members of this club." }); return;
      }
    }
  }

  // ── Rules engine validation: player count rules + booking windows ──────────
  // The lead is always the authenticated user (portal or admin). Their tier
  // is resolved server-side from club membership — never inferred from the players array.
  const validationError = await validateTeeBooking({
    orgId,
    courseId: slot.courseId,
    slotDate: slot.slotDate,
    slotTime: slot.slotTime,
    partySize,
    leadUserId: effectiveLeadUserId,
    isGuest: false,
  });
  if (validationError) {
    res.status(validationError.httpStatus).json({ error: validationError.message, code: validationError.code });
    return;
  }

  // Transactional capacity enforcement — lock the slot row to prevent concurrent overbooking
  let booking: typeof teeBookingsTable.$inferSelect;
  try {
    booking = await db.transaction(async (tx) => {
      // Row-lock the slot so concurrent requests cannot read the same availability window
      const [lockedSlot] = await tx.select({ id: courseTeeSlotTable.id, capacity: courseTeeSlotTable.capacity })
        .from(courseTeeSlotTable)
        .where(and(eq(courseTeeSlotTable.id, slotId), eq(courseTeeSlotTable.organizationId, orgId)))
        .for("update");

      if (!lockedSlot) throw Object.assign(new Error("Slot not found"), { status: 404 });

      // Count both confirmed and pending-payment bookings against capacity
      const [bookedRow] = await tx.select({ booked: sql<number>`COALESCE(SUM(party_size), 0)::int` })
        .from(teeBookingsTable)
        .where(and(
          eq(teeBookingsTable.slotId, slotId),
          sql`${teeBookingsTable.status} IN ('confirmed', 'pending')`,
        ));
      const bookedSeats = bookedRow?.booked ?? 0;

      if (bookedSeats + partySize > lockedSlot.capacity) {
        throw Object.assign(new Error(`Not enough capacity. ${lockedSlot.capacity - bookedSeats} spot(s) remaining.`), { status: 409 });
      }

      // Always derive payment model from server-side club pricing rules —
      // client-supplied paymentModel is ignored to prevent payment-policy bypass.
      const effectivePaymentModel = pricing?.paymentModel ?? "pay_at_checkin";
      // Online/prepaid bookings start as pending until payment is verified
      const initialStatus = (effectivePaymentModel === "online" || effectivePaymentModel === "prepaid")
        ? "pending" as const
        : "confirmed" as const;

      const [created] = await tx.insert(teeBookingsTable).values({
        slotId,
        organizationId: orgId,
        leadUserId: effectiveLeadUserId,
        partySize,
        status: initialStatus,
        paymentModel: effectivePaymentModel,
        cartRequested: cartRequested === true,
      }).returning();
      return created;
    });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string };
    const status = e.status ?? 500;
    if (status === 404) { { res.status(404).json({ error: "Slot not found" }); return; } }
    if (status === 409) { { res.status(409).json({ error: e.message ?? "Slot is full" }); return; } }
    logger.error({ err }, "[TeeBooking] Booking creation failed in transaction");
    res.status(500).json({ error: "Failed to create booking" }); return;
  }

  // Add lead player
  await db.insert(teeBookingPlayersTable).values({
    bookingId: booking.id,
    playerType: "member",
    userId: booking.leadUserId,
    fee: rates.memberRate,
    confirmationStatus: "confirmed",
    confirmedAt: new Date(),
  });

  // Add additional players
  const explicitPlayerCount = Array.isArray(players) ? players.length : 0;
  if (Array.isArray(players)) {
    for (const p of players) {
      await db.insert(teeBookingPlayersTable).values({
        bookingId: booking.id,
        playerType: p.type ?? "member",
        userId: p.userId ?? null,
        guestName: p.guestName ?? null,
        guestEmail: p.guestEmail ?? null,
        fee: p.type === "guest" ? rates.guestRate : rates.memberRate,
        confirmationStatus: p.userId ? "pending" : "confirmed",
      });

      // Notify member players
      if (p.userId) {
        const [leadUser] = await db.select({ displayName: appUsersTable.displayName }).from(appUsersTable).where(eq(appUsersTable.id, userId));
        // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
        // telemetry consumed downstream, classifier intentionally not used.
        sendPushToUsers(
          [p.userId],
          "Tee Time Invitation",
          `${leadUser?.displayName ?? "A member"} has added you to a tee time booking on ${slot.slotDate.toLocaleDateString()} at ${slot.slotTime}.`,
          { type: "tee_booking_invite", bookingId: booking.id },
        ).catch(() => {});
      }
    }
  }

  // Add placeholder fee rows for any unfilled seats so payment total = partySize × rate.
  // (1 lead + explicitPlayerCount players already inserted; remaining are TBD/placeholder seats)
  const unfilledSeats = partySize - 1 - explicitPlayerCount;
  if (unfilledSeats > 0 && parseFloat(rates.memberRate) > 0) {
    const placeholders = Array.from({ length: unfilledSeats }, () => ({
      bookingId: booking.id,
      playerType: "member" as const,
      userId: null as number | null,
      fee: rates.memberRate,
      confirmationStatus: "pending" as const,
    }));
    await db.insert(teeBookingPlayersTable).values(placeholders);
  }

  // Compute and persist totalAmount now so revenue metrics are accurate for all payment paths.
  {
    const [feeSum] = await db
      .select({ total: sql<string>`COALESCE(SUM(fee::numeric), 0)::text` })
      .from(teeBookingPlayersTable)
      .where(eq(teeBookingPlayersTable.bookingId, booking.id));
    const totalRs = parseFloat(feeSum?.total ?? "0");
    if (totalRs > 0) {
      await db.update(teeBookingsTable).set({ totalAmount: String(totalRs), updatedAt: new Date() })
        .where(eq(teeBookingsTable.id, booking.id));
      booking.totalAmount = String(totalRs);
    }
  }

  // ── Auto-assign a cart if player requested one (transactional with row lock) ──
  let cartAssigned = false;
  let cartUnavailable = false;
  if (cartRequested === true) {
    try {
      const [leadUser] = await db
        .select({ displayName: appUsersTable.displayName, username: appUsersTable.username })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, userId));

      await db.transaction(async (tx) => {
        // Lock the first available cart row so concurrent transactions cannot grab it simultaneously.
        const [lockedCart] = await tx
          .select()
          .from(cartsTable)
          .where(and(eq(cartsTable.organizationId, orgId), eq(cartsTable.status, "available")))
          .orderBy(cartsTable.identifier)
          .limit(1)
          .for("update");

        if (!lockedCart) {
          cartUnavailable = true;
          return; // No cart available — exit transaction cleanly
        }

        // The partial unique index `cart_assignments_active_unique` enforces at DB level
        // that only one active assignment exists per cart (WHERE returned_at IS NULL).
        await tx.insert(cartAssignmentsTable).values({
          cartId: lockedCart.id,
          organizationId: orgId,
          bookingId: booking.id,
          assignedByUserId: userId,
          playerName: leadUser?.displayName ?? leadUser?.username ?? null,
        });

        await tx.update(cartsTable)
          .set({ status: "in_use", updatedAt: new Date() })
          .where(eq(cartsTable.id, lockedCart.id));

        cartAssigned = true;
        logger.info({ bookingId: booking.id, cartId: lockedCart.id }, "[TeeBooking] Cart auto-assigned on booking creation");
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === "23505") {
        // Partial unique index violation — another concurrent transaction grabbed this cart.
        cartUnavailable = true;
        logger.warn({ bookingId: booking.id, orgId }, "[TeeBooking] Cart assignment conflict (23505), no cart assigned");
      } else {
        // Non-blocking — booking is already confirmed, log but don't fail the request.
        logger.error({ err, bookingId: booking.id }, "[TeeBooking] Auto cart assignment failed");
      }
    }

    if (cartUnavailable) {
      logger.warn({ bookingId: booking.id, orgId }, "[TeeBooking] Cart requested but no available carts");
    }
  }

  // Send emails non-blockingly.
  // • Confirmed bookings (pay_at_checkin): full booking confirmation email.
  // • Pending bookings (online/prepaid): hold/invitation email noting payment is required.
  //   A full confirmation email is sent after verify-payment succeeds.
  const isPending = booking.status === "pending";
  (async () => {
    try {
      const [leadUser] = await db
        .select({ email: appUsersTable.email, displayName: appUsersTable.displayName })
        .from(appUsersTable).where(eq(appUsersTable.id, userId));
      const [org] = await db
        .select({ name: organizationsTable.name })
        .from(organizationsTable).where(eq(organizationsTable.id, orgId));

      if (leadUser?.email) {
        await sendMarketplaceBookingEmail({
          to: leadUser.email,
          name: leadUser.displayName ?? "Member",
          bookingId: booking.id,
          orgName: org?.name ?? "",
          slotDate: slot.slotDate,
          players: booking.partySize,
          amountPaise: Math.round(parseFloat(String(booking.totalAmount ?? 0)) * 100),
          pending: isPending,
        }).catch(() => {});
      }

      // Invited player emails (member + guest)
      if (Array.isArray(players)) {
        for (const p of players) {
          if (p.type === "guest" && p.guestEmail) {
            await sendMarketplaceBookingEmail({
              to: p.guestEmail,
              name: p.guestName ?? "Guest",
              bookingId: booking.id,
              orgName: org?.name ?? "",
              slotDate: slot.slotDate,
              players: booking.partySize,
              amountPaise: Math.round(parseFloat(String(booking.totalAmount ?? 0)) * 100),
              pending: isPending,
            }).catch(() => {});
          } else if (p.type !== "guest" && p.userId) {
            const [memberUser] = await db
              .select({ email: appUsersTable.email, displayName: appUsersTable.displayName })
              .from(appUsersTable).where(eq(appUsersTable.id, p.userId));
            if (memberUser?.email) {
              await sendMarketplaceBookingEmail({
                to: memberUser.email,
                name: memberUser.displayName ?? "Member",
                bookingId: booking.id,
                orgName: org?.name ?? "",
                slotDate: slot.slotDate,
                players: booking.partySize,
                amountPaise: Math.round(parseFloat(String(booking.totalAmount ?? 0)) * 100),
                pending: isPending,
              }).catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err, bookingId: booking.id }, "[TeeBooking] Booking email send failed");
    }
  })();

  // Task #2020 — best-effort: if this booking originated from a click on
  // an email CTA in the last 24h, attribute it back to the
  // notification key so the admin conversion report can show
  // "tee_booking_created" alongside the click count. Fire-and-forget;
  // a failed attribution must never block the 201 response.
  void recordEmailConversionForRequest(req, "tee_booking_created", {
    userId: effectiveLeadUserId,
  });

  // Task #2008 — when this booking went straight to confirmed (e.g. pay-at-checkin
  // clubs), dispatch the branded `booking.confirmed` notification to every member
  // player. Pending bookings get the dispatch later, in the verify-payment path.
  if (!isPending) {
    const confirmedMemberIds = (Array.isArray(players) ? players : [])
      .filter((p: { type?: string; userId?: number | null }) => p.type !== "guest" && p.userId)
      .map((p: { userId: number | null }) => p.userId!);
    const recipients = Array.from(new Set([userId, ...confirmedMemberIds]));
    void notifyBookingConfirmed({
      userIds: recipients,
      bookingId: booking.id,
      slotDate: slot.slotDate,
    });
  }

  // Wave 0 / Task #935 — analytics smoke test (2/5: tee_booking_created)
  void track("tee_booking_created", {
    bookingId: booking.id,
    slotId,
    courseId: slot.courseId,
    partySize,
    guestCount,
    cartRequested: cartRequested === true,
    cartAssigned,
    bookedOnBehalf: forUserId != null && forUserId !== userId,
  }, {
    organizationId: orgId,
    userId,
    surface: "api",
  });

  res.status(201).json({
    ...booking,
    cartRequested: cartRequested === true,
    cartAssigned,
    cartUnavailable: cartRequested === true && !cartAssigned,
  });
});

router.get("/organizations/:orgId/tee-bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bookings = await db
    .select({
      booking: teeBookingsTable,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      courseName: coursesTable.name,
    })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(teeBookingsTable.slotId, courseTeeSlotTable.id))
    .leftJoin(coursesTable, eq(courseTeeSlotTable.courseId, coursesTable.id))
    .where(eq(teeBookingsTable.organizationId, orgId))
    .orderBy(desc(courseTeeSlotTable.slotDate))
    .limit(100);

  res.json(bookings);
});

router.get("/organizations/:orgId/tee-bookings/my", async (req: Request, res: Response) => {
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const bookings = await db
    .select({
      booking: teeBookingsTable,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      courseName: coursesTable.name,
    })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(teeBookingsTable.slotId, courseTeeSlotTable.id))
    .leftJoin(coursesTable, eq(courseTeeSlotTable.courseId, coursesTable.id))
    .where(and(eq(teeBookingsTable.leadUserId, userId), eq(teeBookingsTable.organizationId, orgId)))
    .orderBy(desc(courseTeeSlotTable.slotDate))
    .limit(20);

  res.json(bookings);
});

// ─── GET /organizations/:orgId/tee-bookings/:bookingId/players ────────────────
// Returns the player list for one of the caller's own bookings
router.get("/organizations/:orgId/tee-bookings/:bookingId/players", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const [booking] = await db
    .select({ leadUserId: teeBookingsTable.leadUserId })
    .from(teeBookingsTable)
    .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));

  if (!booking || booking.leadUserId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const players = await db
    .select({
      id: teeBookingPlayersTable.id,
      playerType: teeBookingPlayersTable.playerType,
      userId: teeBookingPlayersTable.userId,
      guestName: teeBookingPlayersTable.guestName,
      guestEmail: teeBookingPlayersTable.guestEmail,
      confirmationStatus: teeBookingPlayersTable.confirmationStatus,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(teeBookingPlayersTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, teeBookingPlayersTable.userId))
    .where(eq(teeBookingPlayersTable.bookingId, bookingId));

  res.json(players);
});

router.patch("/organizations/:orgId/tee-bookings/:bookingId/cancel", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const cancellationReason: string | null = req.body.reason ?? null;

  // Fetch booking + slot details in one query
  const [bookingRow] = await db
    .select({
      id: teeBookingsTable.id,
      leadUserId: teeBookingsTable.leadUserId,
      slotId: teeBookingsTable.slotId,
      status: teeBookingsTable.status,
      totalAmount: teeBookingsTable.totalAmount,
      organizationId: teeBookingsTable.organizationId,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      orgName: organizationsTable.name,
    })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
    .innerJoin(organizationsTable, eq(organizationsTable.id, teeBookingsTable.organizationId))
    .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));
  if (!bookingRow) { { res.status(404).json({ error: "Booking not found" }); return; } }

  // Determine if caller is admin (admins bypass the cut-off)
  const callerIsAdmin = bookingRow.leadUserId !== userId;
  if (callerIsAdmin) {
    const isAdmin = await requireOrgAdmin(req, res, orgId);
    if (!isAdmin) return;
  }

  // Enforce cancellation cut-off for non-admin (lead-user) cancellations
  let lateCancel = false;
  let cancellationPolicyType = "forfeit";
  let cancellationFeeFlat: string | null = null;
  if (!callerIsAdmin) {
    const [pricingRule] = await db
      .select({
        cancellationCutoffHours: teePricingRulesTable.cancellationCutoffHours,
        cancellationPolicyType: teePricingRulesTable.cancellationPolicyType,
        cancellationFeeFlat: teePricingRulesTable.cancellationFeeFlat,
      })
      .from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId)).limit(1);
    const cutoffHours = pricingRule?.cancellationCutoffHours ?? 24;
    cancellationPolicyType = pricingRule?.cancellationPolicyType ?? "forfeit";
    cancellationFeeFlat = pricingRule?.cancellationFeeFlat ?? null;

    const slotDateTime = new Date(bookingRow.slotDate);
    const slotTimeStr = (bookingRow.slotTime ?? "").trim();
    const timeMatch = slotTimeStr.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const meridiem = (timeMatch[3] ?? "").toUpperCase();
      if (meridiem === "PM" && hours < 12) hours += 12;
      if (meridiem === "AM" && hours === 12) hours = 0;
      slotDateTime.setHours(hours, minutes, 0, 0);
    }

    if (Date.now() > slotDateTime.getTime() - cutoffHours * 60 * 60 * 1000) {
      if (cancellationPolicyType === "free") {
        // Free cancellation policy — always allow, no penalty
      } else {
        // Forfeit or fee policy — allow cancellation with consequence (not hard-block)
        lateCancel = true;
      }
    }
  }

  // Fetch all active players (for notifications) before cancelling
  const activePlayers = await db
    .select({
      userId: teeBookingPlayersTable.userId,
      guestEmail: teeBookingPlayersTable.guestEmail,
      guestName: teeBookingPlayersTable.guestName,
      playerType: teeBookingPlayersTable.playerType,
      userEmail: appUsersTable.email,
      userName: appUsersTable.displayName,
    })
    .from(teeBookingPlayersTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, teeBookingPlayersTable.userId))
    .where(and(
      eq(teeBookingPlayersTable.bookingId, bookingId),
      sql`${teeBookingPlayersTable.confirmationStatus} NOT IN ('declined', 'cancelled')`,
    ));

  // Determine final status based on cancellation policy
  const finalStatus = lateCancel && cancellationPolicyType === "forfeit"
    ? "forfeited"
    : "cancelled";
  const lateCancelNote = lateCancel
    ? ` [Late cancellation — policy: ${cancellationPolicyType}${cancellationPolicyType === "fee" && cancellationFeeFlat ? `, fee: ₹${cancellationFeeFlat}` : ""}]`
    : "";

  await db.update(teeBookingsTable).set({
    status: finalStatus,
    cancellationReason: (cancellationReason ?? "") + lateCancelNote || null,
    cancelledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(teeBookingsTable.id, bookingId));

  // Release slot capacity — only reopen the slot if it was previously open (not blocked by admin).
  // Blocked slots should remain blocked regardless of booking cancellations.
  await db.update(courseTeeSlotTable)
    .set({ status: "open" })
    .where(and(
      eq(courseTeeSlotTable.id, bookingRow.slotId),
      sql`${courseTeeSlotTable.status} != 'blocked'`,
    ));

  // Notify all active players about cancellation
  const memberUserIds = activePlayers.filter(p => p.userId !== null && p.userId !== userId).map(p => p.userId!);
  if (memberUserIds.length > 0) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendPushToUsers(
      memberUserIds,
      "Tee Time Cancelled",
      `Your tee time at ${bookingRow.orgName} on ${new Date(bookingRow.slotDate).toLocaleDateString()} at ${bookingRow.slotTime} has been cancelled.`,
      { type: "tee_booking_cancelled", bookingId },
    ).catch(() => {});
  }
  for (const p of activePlayers) {
    const email = p.playerType === "guest" ? p.guestEmail : p.userEmail;
    const name = p.playerType === "guest" ? (p.guestName ?? "Guest") : (p.userName ?? "Member");
    if (email) {
      sendTeeCancellationEmail({
        to: email,
        name,
        bookingId,
        orgName: bookingRow.orgName,
        slotDate: new Date(bookingRow.slotDate),
        slotTime: bookingRow.slotTime ?? "",
        reason: cancellationReason ?? null,
      }).catch(() => {});
    }
  }

  // Task #2008 — central branded dispatch for the cancellation. Fans out
  // push/email/digest per recipient preference; the bespoke
  // `sendTeeCancellationEmail` calls above stay in place because they cover
  // guest emails (which have no app-user row) and bypass digest gating.
  const cancelRecipients = Array.from(new Set(
    activePlayers.filter(p => p.userId !== null).map(p => p.userId!),
  ));
  void notifyBookingCancelled({
    userIds: cancelRecipients,
    bookingId,
    orgName: bookingRow.orgName,
    slotDate: new Date(bookingRow.slotDate),
    slotTime: bookingRow.slotTime ?? undefined,
    cancellationReason: cancellationReason ?? undefined,
  });

  res.json({
    success: true,
    status: finalStatus,
    ...(lateCancel && { lateCancel: true, cancellationPolicy: cancellationPolicyType, cancellationFee: cancellationFeeFlat }),
  });
});

// ─── GET /api/public/tee-slots — public slot availability ─────────────────────
router.get("/public/tee-slots", async (req: Request, res: Response) => {
  const orgId = parseInt(req.query.orgId as string);
  const date = req.query.date as string; // YYYY-MM-DD
  if (!orgId || isNaN(orgId)) { { res.status(400).json({ error: "orgId required" }); return; } }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { { res.status(400).json({ error: "date required (YYYY-MM-DD)" }); return; } }

  // Gate: Free-tier clubs cannot expose booking inventory
  const [org] = await db.select({ subscriptionTier: organizationsTable.subscriptionTier })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (org?.subscriptionTier === "free") {
    res.status(403).json({
      error: "Tee time booking requires a Starter or higher subscription.",
      code: "SUBSCRIPTION_REQUIRED",
      upgrade: { requiredTier: "starter", feature: "tee_time_booking", ctaText: "Upgrade to Starter", ctaUrl: "/super-admin?tab=billing" },
    }); return;
  }

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd = new Date(`${date}T23:59:59.999Z`);

  const slots = await db
    .select({
      id: courseTeeSlotTable.id,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
      capacity: courseTeeSlotTable.capacity,
      status: courseTeeSlotTable.status,
      isMembersOnly: courseTeeSlotTable.isMembersOnly,
      courseId: courseTeeSlotTable.courseId,
      courseName: coursesTable.name,
      bookedCount: sql<number>`(
        SELECT COALESCE(SUM(party_size), 0) FROM tee_bookings
        WHERE tee_bookings.slot_id = ${courseTeeSlotTable.id}
          AND tee_bookings.status NOT IN ('cancelled', 'forfeited')
      )::int`,
    })
    .from(courseTeeSlotTable)
    .leftJoin(coursesTable, eq(courseTeeSlotTable.courseId, coursesTable.id))
    .where(
      and(
        eq(courseTeeSlotTable.organizationId, orgId),
        eq(courseTeeSlotTable.status, "open"),
        gte(courseTeeSlotTable.slotDate, dayStart),
        lte(courseTeeSlotTable.slotDate, dayEnd),
      )
    )
    .orderBy(courseTeeSlotTable.slotTime)
    .limit(60);

  // Include pricing info
  const [pricing] = await db.select().from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId)).limit(1);

  res.json({ slots, pricing: pricing ?? null });
});

// ─── POST /organizations/:orgId/tee-bookings/:bookingId/payment-order ─────────
router.post("/organizations/:orgId/tee-bookings/:bookingId/payment-order", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const [booking] = await db
    .select({ booking: teeBookingsTable, slot: courseTeeSlotTable })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(teeBookingsTable.slotId, courseTeeSlotTable.id))
    .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)))
    .then(rows => rows);

  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (booking.booking.leadUserId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }

  if (booking.booking.status !== "pending") {
    res.status(409).json({ error: "Payment order can only be created for pending bookings" }); return;
  }
  if (booking.booking.paymentModel !== "online" && booking.booking.paymentModel !== "prepaid") {
    res.status(400).json({ error: "This booking uses pay-at-checkin — no online payment required" }); return;
  }

  // Compute total from actual player fee rows (captures member rate vs guest rate + twilight/promo)
  const [feeRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(fee::numeric), 0)::text` })
    .from(teeBookingPlayersTable)
    .where(and(
      eq(teeBookingPlayersTable.bookingId, bookingId),
      sql`${teeBookingPlayersTable.confirmationStatus} NOT IN ('declined', 'cancelled')`,
    ));
  const totalAmount = Math.round(parseFloat(feeRow?.total ?? "0") * 100); // paise

  if (totalAmount <= 0) {
    // Zero-fee online/prepaid booking — auto-confirm without charging
    await db.update(teeBookingsTable).set({ status: "confirmed", updatedAt: new Date() })
      .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));
    res.json({ amount: 0, confirmed: true }); return;
  }

  try {
    const { getRazorpayClient, getRazorpayKeyId } = await import("../lib/razorpay");
    const rz = getRazorpayClient();
    const order = await rz.orders.create({
      amount: totalAmount,
      currency: "INR",
      receipt: `tee-${bookingId}`,
      notes: { bookingId: String(bookingId), orgId: String(orgId) },
    });

    // Persist the order ID so verify-payment can validate order-to-booking binding
    await db.update(teeBookingsTable).set({ razorpayOrderId: order.id, updatedAt: new Date() })
      .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));

    res.json({ orderId: order.id, amount: totalAmount, currency: "INR", keyId: getRazorpayKeyId() });
  } catch (err) {
    logger.error({ err }, "[TeeBooking] Razorpay order creation failed");
    res.status(500).json({ error: "Payment gateway error" });
  }
});

// ─── POST /organizations/:orgId/tee-bookings/:bookingId/verify-payment ─────────
router.post("/organizations/:orgId/tee-bookings/:bookingId/verify-payment", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    res.status(400).json({ error: "Missing payment fields" }); return;
  }

  try {
    const { verifyPaymentSignature } = await import("../lib/razorpay");
    const valid = verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature);
    if (!valid) { { res.status(400).json({ error: "Payment signature invalid" }); return; } }

    // Fetch booking with ownership, status and order binding fields
    const [paymentBooking] = await db
      .select({
        partySize: teeBookingsTable.partySize,
        leadUserId: teeBookingsTable.leadUserId,
        storedOrderId: teeBookingsTable.razorpayOrderId,
        status: teeBookingsTable.status,
        slotId: teeBookingsTable.slotId,
      })
      .from(teeBookingsTable)
      .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));

    if (!paymentBooking) { { res.status(404).json({ error: "Booking not found" }); return; } }
    // Enforce booking ownership — only the lead booker may verify payment
    if (paymentBooking.leadUserId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }
    // Enforce pending-only transition — do not revive cancelled or already-confirmed bookings
    if (paymentBooking.status !== "pending") {
      res.status(409).json({ error: "Booking is no longer awaiting payment" }); return;
    }
    // Verify the order ID belongs to this booking (prevents replaying a valid signature from a different booking)
    if (paymentBooking.storedOrderId !== razorpayOrderId) {
      res.status(400).json({ error: "Order ID does not match this booking" }); return;
    }

    // Re-validate slot capacity to prevent double-booking after a concurrent hold expires.
    // Count confirmed+pending bookings for this slot EXCLUDING the current booking
    // and compare to the slot's capacity.
    const [slotRow] = await db.select().from(courseTeeSlotTable).where(eq(courseTeeSlotTable.id, paymentBooking.slotId));
    if (slotRow) {
      const [occupancyRow] = await db
        .select({ occupied: sql<string>`COALESCE(SUM(${teeBookingsTable.partySize}), 0)::text` })
        .from(teeBookingsTable)
        .where(and(
          eq(teeBookingsTable.slotId, paymentBooking.slotId),
          sql`${teeBookingsTable.status} IN ('pending', 'confirmed')`,
          sql`${teeBookingsTable.id} != ${bookingId}`,
        ));
      const occupied = parseInt(occupancyRow?.occupied ?? "0", 10);
      if (occupied + paymentBooking.partySize > slotRow.capacity) {
        res.status(409).json({ error: "Slot is now fully booked — payment cannot be applied" }); return;
      }
    }

    // Use authoritative fee sum from player rows (matches what payment-order charged)
    const [verifyFeeRow] = await db
      .select({ total: sql<string>`COALESCE(SUM(fee::numeric), 0)::text` })
      .from(teeBookingPlayersTable)
      .where(and(
        eq(teeBookingPlayersTable.bookingId, bookingId),
        sql`${teeBookingPlayersTable.confirmationStatus} NOT IN ('declined', 'cancelled')`,
      ));
    const verifiedTotalRs = parseFloat(verifyFeeRow?.total ?? "0");

    await db.update(teeBookingsTable).set({
      status: "confirmed",   // transitions pending → confirmed after successful payment
      paymentModel: "online",
      razorpayPaymentId,
      totalAmount: String(verifiedTotalRs),
      updatedAt: new Date(),
    }).where(eq(teeBookingsTable.id, bookingId));

    // Send final booking confirmation emails after payment verified
    (async () => {
      try {
        const [confirmedLead] = await db
          .select({ email: appUsersTable.email, displayName: appUsersTable.displayName })
          .from(appUsersTable).where(eq(appUsersTable.id, userId));
        const [confirmedOrg] = await db
          .select({ name: organizationsTable.name })
          .from(organizationsTable).where(eq(organizationsTable.id, orgId));
        const confirmedSlot = slotRow; // already fetched above for capacity check

        if (confirmedLead?.email && confirmedSlot) {
          await sendMarketplaceBookingEmail({
            to: confirmedLead.email,
            name: confirmedLead.displayName ?? "Member",
            bookingId,
            orgName: confirmedOrg?.name ?? "",
            slotDate: confirmedSlot.slotDate,
            players: paymentBooking.partySize,
            amountPaise: Math.round(verifiedTotalRs * 100),

            pending: false,
          }).catch(() => {});
        }

        // Also notify member co-players
        const confirmedPlayers = await db
          .select({ userId: teeBookingPlayersTable.userId, guestEmail: teeBookingPlayersTable.guestEmail, guestName: teeBookingPlayersTable.guestName, playerType: teeBookingPlayersTable.playerType })
          .from(teeBookingPlayersTable)
          .where(and(
            eq(teeBookingPlayersTable.bookingId, bookingId),
            sql`${teeBookingPlayersTable.confirmationStatus} NOT IN ('declined', 'cancelled')`,
          ));
        for (const cp of confirmedPlayers) {
          if (cp.playerType === "guest" && cp.guestEmail && confirmedSlot) {
            await sendMarketplaceBookingEmail({
              to: cp.guestEmail,
              name: cp.guestName ?? "Guest",
              bookingId,
              orgName: confirmedOrg?.name ?? "",
              slotDate: confirmedSlot.slotDate,
              players: paymentBooking.partySize,
              amountPaise: Math.round(verifiedTotalRs * 100),

              pending: false,
            }).catch(() => {});
          } else if (cp.userId && cp.userId !== userId && confirmedSlot) {
            const [cpUser] = await db
              .select({ email: appUsersTable.email, displayName: appUsersTable.displayName })
              .from(appUsersTable).where(eq(appUsersTable.id, cp.userId));
            if (cpUser?.email) {
              await sendMarketplaceBookingEmail({
                to: cpUser.email,
                name: cpUser.displayName ?? "Member",
                bookingId,
                orgName: confirmedOrg?.name ?? "",
                slotDate: confirmedSlot.slotDate,
                players: paymentBooking.partySize,
                amountPaise: Math.round(verifiedTotalRs * 100),
                pending: false,
              }).catch(() => {});
            }
          }
        }
      } catch (err) {
        logger.warn({ err, bookingId }, "[TeeBooking] Post-payment confirmation email failed");
      }
    })();

    // Task #2008 — branded `booking.confirmed` dispatch after the pending →
    // confirmed payment transition. The /tee-bookings POST handler covers the
    // straight-to-confirmed (pay-at-checkin) path; this branch handles the
    // online/prepaid path where confirmation only happens after Razorpay
    // signature verification.
    void (async () => {
      try {
        const verifyConfirmedPlayers = await db
          .select({ userId: teeBookingPlayersTable.userId })
          .from(teeBookingPlayersTable)
          .where(and(
            eq(teeBookingPlayersTable.bookingId, bookingId),
            sql`${teeBookingPlayersTable.confirmationStatus} NOT IN ('declined', 'cancelled')`,
          ));
        const memberIds = verifyConfirmedPlayers.filter(p => p.userId !== null).map(p => p.userId!);
        const recipients = Array.from(new Set([userId, ...memberIds]));
        await notifyBookingConfirmed({
          userIds: recipients,
          bookingId,
          slotDate: slotRow?.slotDate,
        });
      } catch (err) {
        logger.warn({ err, bookingId }, "[TeeBooking] branded booking.confirmed dispatch failed");
      }
    })();

    // Award loyalty points for confirmed tee booking
    if (verifiedTotalRs > 0) {
      awardPoints({
        organizationId: orgId,
        userId,
        amountSpent: verifiedTotalRs,
        category: "tee_booking",
        referenceId: `tee_booking:${bookingId}`,
        description: `Tee time booking #${bookingId} confirmed`,
      }).catch(() => {});
    }

    res.json({ success: true, paymentId: razorpayPaymentId });
  } catch (err) {
    logger.error({ err }, "[TeeBooking] Payment verification failed");
    res.status(500).json({ error: "Payment verification error" });
  }
});

// ─── POST /organizations/:orgId/tee-bookings/:bookingId/confirm-player ─────────
// Member confirms or declines their invitation to a booking
router.post("/organizations/:orgId/tee-bookings/:bookingId/confirm-player", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { action } = req.body; // "confirm" | "decline"
  if (!["confirm", "decline"].includes(action)) { { res.status(400).json({ error: "action must be confirm or decline" }); return; } }

  // Validate booking belongs to this org (prevent cross-tenant mutation); join slot for cut-off check
  const [bookingRow] = await db
    .select({
      id: teeBookingsTable.id,
      organizationId: teeBookingsTable.organizationId,
      leadUserId: teeBookingsTable.leadUserId,
      status: teeBookingsTable.status,
      slotDate: courseTeeSlotTable.slotDate,
      slotTime: courseTeeSlotTable.slotTime,
    })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
    .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));
  if (!bookingRow) { { res.status(404).json({ error: "Booking not found" }); return; } }
  const booking = bookingRow;

  // Enforce cancellation cut-off for decline action
  if (action === "decline") {
    const [pricingRule] = await db.select({ cancellationCutoffHours: teePricingRulesTable.cancellationCutoffHours })
      .from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId)).limit(1);
    const cutoffHours = pricingRule?.cancellationCutoffHours ?? 24;

    // Build full tee datetime by combining slotDate (date part) + slotTime text (e.g. "09:30" or "9:30 AM")
    const slotDateTime = new Date(booking.slotDate);
    const slotTimeStr = (booking.slotTime ?? "").trim();
    const timeMatch = slotTimeStr.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
    if (timeMatch) {
      let hours = parseInt(timeMatch[1], 10);
      const minutes = parseInt(timeMatch[2], 10);
      const meridiem = (timeMatch[3] ?? "").toUpperCase();
      if (meridiem === "PM" && hours < 12) hours += 12;
      if (meridiem === "AM" && hours === 12) hours = 0;
      slotDateTime.setHours(hours, minutes, 0, 0);
    }

    const cutoffMs = cutoffHours * 60 * 60 * 1000;
    if (Date.now() > slotDateTime.getTime() - cutoffMs) {
      res.status(422).json({
        error: `Cancellation cut-off has passed. Players must decline at least ${cutoffHours} hour(s) before the tee time.`,
        code: "CANCELLATION_CUTOFF_PASSED",
        cutoffHours,
      }); return;
    }
  }

  const [player] = await db
    .select()
    .from(teeBookingPlayersTable)
    .where(and(eq(teeBookingPlayersTable.bookingId, bookingId), eq(teeBookingPlayersTable.userId, userId)));

  if (!player) { { res.status(404).json({ error: "You are not a player in this booking" }); return; } }

  if (action === "confirm") {
    await db.update(teeBookingPlayersTable).set({
      confirmationStatus: "confirmed",
      confirmedAt: new Date(),
    }).where(eq(teeBookingPlayersTable.id, player.id));
  } else {
    // Idempotency: only decrement capacity if this player is transitioning from pending
    const wasAlreadyDeclined = player.confirmationStatus === "declined";

    await db.update(teeBookingPlayersTable).set({
      confirmationStatus: "declined",
      declinedAt: new Date(),
    }).where(eq(teeBookingPlayersTable.id, player.id));

    // Hold seat for substitution — partySize unchanged; only cancel when all decline
    if (!wasAlreadyDeclined) {
      const [activeCountRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(teeBookingPlayersTable)
        .where(and(
          eq(teeBookingPlayersTable.bookingId, bookingId),
          sql`confirmation_status NOT IN ('declined', 'cancelled')`,
          sql`${teeBookingPlayersTable.userId} IS NOT NULL`,   // exclude placeholder seats
        ));
      const activeCount = activeCountRow?.count ?? 0;
      if (activeCount === 0) {
        // No active players — cancel the booking and release slot capacity
        await db.update(teeBookingsTable).set({
          status: "cancelled",
          cancellationReason: "All players declined",
          cancelledAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(teeBookingsTable.id, bookingId));
      }
      // Otherwise: partySize is intentionally unchanged — slot seat is held for substitution.
      // Lead booker is notified below so they can add a replacement player.
    }

    // Notify the lead booker their slot opened up
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendPushToUsers(
      [booking.leadUserId],
      "Player Declined Tee Time",
      "A player declined your tee time invitation. You can add a substitute.",
      { type: "tee_booking_declined", bookingId },
    ).catch(() => {});
  }

  res.json({ success: true, action });
});

// ─── GET /organizations/:orgId/tee-bookings/members/search ───────────────────
// Search org members by name for co-player lookup (caller must be org member or admin)
router.get("/organizations/:orgId/tee-bookings/members/search", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  // Allow super_admin to search any org; all others must be a member via org_memberships
  const adminUser = req.user as { role?: string } | undefined;
  if (adminUser?.role !== "super_admin") {
    const [caller] = await db.select({ id: orgMembershipsTable.id })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)));
    if (!caller) {
      res.status(403).json({ error: "You are not a member of this organization" }); return;
    }
  }

  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) { { res.json([]); return; } }

  // Search all users who are members of this org (via org_memberships),
  // joining clubMembersTable for memberNumber where available.
  const members = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      email: appUsersTable.email,
      memberNumber: clubMembersTable.memberNumber,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .leftJoin(
      clubMembersTable,
      and(eq(clubMembersTable.userId, appUsersTable.id), eq(clubMembersTable.organizationId, orgId)),
    )
    .where(
      and(
        eq(orgMembershipsTable.organizationId, orgId),
        or(
          ilike(appUsersTable.displayName, `%${q}%`),
          ilike(appUsersTable.username, `%${q}%`),
          ilike(appUsersTable.email, `%${q}%`),
          ilike(clubMembersTable.memberNumber, `%${q}%`),
        ),
      )
    )
    .limit(10);

  res.json(members.filter(m => m.id !== userId));
});

// ─── POST /organizations/:orgId/tee-bookings/:bookingId/replace-player ────────
// Lead can substitute a declined or placeholder seat with a new member or guest.
// body: { declinedPlayerId?: number, newUserId?: number, newGuestName?: string, newGuestEmail?: string }
router.post("/organizations/:orgId/tee-bookings/:bookingId/replace-player", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const userId = getAuthUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { declinedPlayerId, newUserId, newGuestName, newGuestEmail } = req.body ?? {};

  // Fetch booking and verify caller is lead
  const [booking] = await db
    .select({
      id: teeBookingsTable.id,
      leadUserId: teeBookingsTable.leadUserId,
      organizationId: teeBookingsTable.organizationId,
      status: teeBookingsTable.status,
    })
    .from(teeBookingsTable)
    .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));

  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (booking.leadUserId !== userId) { { res.status(403).json({ error: "Only the lead booker can substitute players" }); return; } }
  if (booking.status === "cancelled") { { res.status(409).json({ error: "Cannot modify a cancelled booking" }); return; } }

  const [pricing] = await db
    .select({ memberRate: teePricingRulesTable.memberRate, guestRate: teePricingRulesTable.guestRate, maxGuestsPerBooking: teePricingRulesTable.maxGuestsPerBooking })
    .from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId)).limit(1);

  const isGuest = !newUserId;

  // ── Security check 1: Members-only slot rejects guest replacements ────────────
  const [slotRow] = await db
    .select({ isMembersOnly: courseTeeSlotTable.isMembersOnly })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
    .where(eq(teeBookingsTable.id, bookingId));
  if (isGuest && slotRow?.isMembersOnly) {
    res.status(403).json({ error: "This slot is members-only — guests cannot be added" }); return;
  }

  // ── Security check 2: Guest limit ────────────────────────────────────────────
  if (isGuest) {
    const maxGuests = pricing?.maxGuestsPerBooking ?? 1;
    const [guestCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(teeBookingPlayersTable)
      .where(and(
        eq(teeBookingPlayersTable.bookingId, bookingId),
        eq(teeBookingPlayersTable.playerType, "guest"),
        sql`${teeBookingPlayersTable.confirmationStatus} NOT IN ('declined', 'cancelled')`,
      ));
    if ((guestCountRow?.count ?? 0) >= maxGuests) {
      res.status(409).json({ error: `Guest limit reached (max ${maxGuests} per booking)` }); return;
    }
  }

  // ── Security check 3: Cross-tenant member injection ──────────────────────────
  if (newUserId) {
    const [membership] = await db
      .select({ id: orgMembershipsTable.id })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, newUserId), eq(orgMembershipsTable.organizationId, orgId)));
    if (!membership) {
      res.status(403).json({ error: "The specified user is not a member of this club" }); return;
    }
  }

  if (declinedPlayerId) {
    // Mark the specified player row as cancelled (it was previously declined)
    const [targetPlayer] = await db
      .select({ id: teeBookingPlayersTable.id, confirmationStatus: teeBookingPlayersTable.confirmationStatus })
      .from(teeBookingPlayersTable)
      .where(and(
        eq(teeBookingPlayersTable.id, declinedPlayerId),
        eq(teeBookingPlayersTable.bookingId, bookingId),
      ));
    if (!targetPlayer) { { res.status(404).json({ error: "Player row not found" }); return; } }
    await db.update(teeBookingPlayersTable).set({ confirmationStatus: "cancelled" })
      .where(eq(teeBookingPlayersTable.id, declinedPlayerId));
  } else {
    // Find a placeholder slot (null userId, pending) to fill
    const [placeholder] = await db
      .select({ id: teeBookingPlayersTable.id })
      .from(teeBookingPlayersTable)
      .where(and(
        eq(teeBookingPlayersTable.bookingId, bookingId),
        sql`${teeBookingPlayersTable.userId} IS NULL`,
        eq(teeBookingPlayersTable.confirmationStatus, "pending"),
      ))
      .limit(1);
    if (placeholder) {
      await db.update(teeBookingPlayersTable).set({ confirmationStatus: "cancelled" })
        .where(eq(teeBookingPlayersTable.id, placeholder.id));
    }
  }

  // Insert new player
  await db.insert(teeBookingPlayersTable).values({
    bookingId,
    playerType: isGuest ? "guest" : "member",
    userId: newUserId ?? null,
    guestName: newGuestName ?? null,
    guestEmail: newGuestEmail ?? null,
    fee: String(isGuest ? (pricing?.guestRate ?? 0) : (pricing?.memberRate ?? 0)),
    confirmationStatus: newUserId ? "pending" : "confirmed",
  });

  // Notify new member player
  if (newUserId) {
    const [leadUser] = await db.select({ displayName: appUsersTable.displayName }).from(appUsersTable).where(eq(appUsersTable.id, userId));
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendPushToUsers(
      [newUserId],
      "Tee Time Invitation",
      `${leadUser?.displayName ?? "A member"} has invited you to join their tee time booking.`,
      { type: "tee_booking_invite", bookingId },
    ).catch(() => {});
  }

  res.json({ ok: true });
});

export default router;
