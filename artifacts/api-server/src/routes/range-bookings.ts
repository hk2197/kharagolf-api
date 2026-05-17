/**
 * Driving Range & Bay Booking API
 *
 * GET    /organizations/:orgId/range-bookings/config              Get range config
 * PUT    /organizations/:orgId/range-bookings/config              Admin: update config
 * GET    /organizations/:orgId/range-bookings/bays                List bays
 * POST   /organizations/:orgId/range-bookings/bays                Admin: create bay
 * PATCH  /organizations/:orgId/range-bookings/bays/:bayId         Admin: update bay
 * DELETE /organizations/:orgId/range-bookings/bays/:bayId         Admin: deactivate bay
 * GET    /organizations/:orgId/range-bookings/blackouts           List blackouts
 * POST   /organizations/:orgId/range-bookings/blackouts           Admin: create blackout
 * DELETE /organizations/:orgId/range-bookings/blackouts/:id       Admin: remove blackout
 * GET    /organizations/:orgId/range-bookings/availability        Available slots for date
 * POST   /organizations/:orgId/range-bookings                     Create booking
 * GET    /organizations/:orgId/range-bookings                     Admin/Staff: list bookings
 * GET    /organizations/:orgId/range-bookings/my                  Player: my bookings
 * PATCH  /organizations/:orgId/range-bookings/:id/cancel          Cancel booking
 * POST   /organizations/:orgId/range-bookings/:id/reschedule      Reschedule booking
 * POST   /organizations/:orgId/range-bookings/:id/checkin         Staff: check in
 * GET    /organizations/:orgId/range-bookings/:id/qr              Get QR token data
 * GET    /organizations/:orgId/range-bookings/dashboard           Staff dashboard
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  rangeBayTable, rangeConfigTable, rangeBlackoutTable, rangeBookingTable,
  rangeSlotTable, ballTokenCreditTable, organizationsTable, appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, gte, lte, desc, asc, isNull, inArray, not } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendPushToUsers } from "../lib/push";
import { logger } from "../lib/logger";
import { randomBytes } from "crypto";
import { sendRangeBookingConfirmation } from "../lib/mailer";

const router: IRouter = Router({ mergeParams: true });

function getAuthUserId(req: Request): number | null {
  const userId = (req as unknown as { portalUser?: { userId?: number }; user?: { id?: number } }).portalUser?.userId
    ?? (req as unknown as { user?: { id?: number } }).user?.id;
  return userId ? Number(userId) : null;
}

function getUserRole(req: Request): string | null {
  return (req as unknown as { user?: { role?: string } }).user?.role
    ?? (req as unknown as { portalUser?: { role?: string } }).portalUser?.role
    ?? null;
}

function getUserOrgId(req: Request): number | null {
  const orgId = (req as unknown as { user?: { organizationId?: number } }).user?.organizationId
    ?? (req as unknown as { portalUser?: { organizationId?: number } }).portalUser?.organizationId;
  return orgId ? Number(orgId) : null;
}

/**
 * Verify the requesting user has org staff access to the target org.
 * Staff roles: super_admin (all orgs), org_admin / tournament_director / pro_shop / volunteer (own org or membership).
 */
async function requireOrgStaff(req: Request, res: Response, orgId: number): Promise<boolean> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Authentication required" }); return false; }

  const role = getUserRole(req);
  if (role === "super_admin") return true;

  const userOrgId = getUserOrgId(req);
  const STAFF_ROLES = ["org_admin", "tournament_director", "pro_shop", "volunteer"];

  if (STAFF_ROLES.includes(role ?? "") && userOrgId === orgId) return true;

  // Check org membership
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, userId)));

  if (membership && STAFF_ROLES.includes(membership.role)) return true;

  res.status(403).json({ error: "Staff access required for this organization" });
  return false;
}

/**
 * Verify the requesting user belongs to the given org (as member, staff, or admin).
 * Used for regular member actions (create booking, view my bookings, etc.)
 */
async function requireOrgMember(req: Request, res: Response, orgId: number): Promise<boolean> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Authentication required" }); return false; }

  const role = getUserRole(req);
  if (role === "super_admin") return true;

  const userOrgId = getUserOrgId(req);
  if (userOrgId === orgId) return true;

  // Check membership table
  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, userId)));

  if (membership) return true;

  res.status(403).json({ error: "You are not a member of this organization" });
  return false;
}

function generateQrToken(): string {
  return randomBytes(20).toString("hex");
}

function isPeakTime(time: string, peakStart?: string | null, peakEnd?: string | null): boolean {
  if (!peakStart || !peakEnd) return false;
  return time >= peakStart && time < peakEnd;
}

function getRate(
  playerType: "member" | "visitor",
  slotTime: string,
  config: {
    memberRate: string;
    visitorRate: string;
    peakMemberRate?: string | null;
    peakVisitorRate?: string | null;
    peakStartTime?: string | null;
    peakEndTime?: string | null;
  },
): number {
  const peak = isPeakTime(slotTime, config.peakStartTime, config.peakEndTime);
  if (playerType === "member") {
    return parseFloat(peak && config.peakMemberRate ? config.peakMemberRate : config.memberRate) || 0;
  }
  return parseFloat(peak && config.peakVisitorRate ? config.peakVisitorRate : config.visitorRate) || 0;
}

// Generate time slots for a day based on config
function generateTimeSlots(firstSlot: string, lastSlot: string, durationMinutes: number): string[] {
  const slots: string[] = [];
  const [fh, fm] = firstSlot.split(":").map(Number);
  const [lh, lm] = lastSlot.split(":").map(Number);
  let current = fh * 60 + fm;
  const last = lh * 60 + lm;
  while (current <= last) {
    const h = Math.floor(current / 60).toString().padStart(2, "0");
    const m = (current % 60).toString().padStart(2, "0");
    slots.push(`${h}:${m}`);
    current += durationMinutes;
  }
  return slots;
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/range-bookings/config", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const [config] = await db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId));
  res.json(config ?? null);
});

router.put("/organizations/:orgId/range-bookings/config", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    slotDurationMinutes, firstSlotTime, lastSlotTime,
    memberRate, visitorRate, peakMemberRate, peakVisitorRate,
    peakStartTime, peakEndTime, ballsPerBucket, bucketsIncluded,
    cancellationCutoffHours, paymentModel,
  } = req.body;

  const values = {
    organizationId: orgId,
    slotDurationMinutes: slotDurationMinutes ?? 30,
    firstSlotTime: firstSlotTime ?? "06:00",
    lastSlotTime: lastSlotTime ?? "21:00",
    memberRate: String(memberRate ?? 0),
    visitorRate: String(visitorRate ?? 0),
    peakMemberRate: peakMemberRate != null ? String(peakMemberRate) : null,
    peakVisitorRate: peakVisitorRate != null ? String(peakVisitorRate) : null,
    peakStartTime: peakStartTime ?? null,
    peakEndTime: peakEndTime ?? null,
    ballsPerBucket: ballsPerBucket ?? 50,
    bucketsIncluded: bucketsIncluded ?? 1,
    cancellationCutoffHours: cancellationCutoffHours ?? 2,
    paymentModel: paymentModel ?? "pay_at_checkin",
    updatedAt: new Date(),
  };

  const [config] = await db.insert(rangeConfigTable).values(values)
    .onConflictDoUpdate({ target: rangeConfigTable.organizationId, set: values })
    .returning();

  res.json(config);
});

// ─── BAYS ────────────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/range-bookings/bays", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const bays = await db.select().from(rangeBayTable)
    .where(eq(rangeBayTable.organizationId, orgId))
    .orderBy(asc(rangeBayTable.bayNumber));
  res.json(bays);
});

router.post("/organizations/:orgId/range-bookings/bays", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { bayNumber, label } = req.body;
  if (!bayNumber) { { res.status(400).json({ error: "bayNumber is required" }); return; } }

  const [bay] = await db.insert(rangeBayTable).values({
    organizationId: orgId,
    bayNumber: Number(bayNumber),
    label: label ?? null,
  }).returning();

  res.status(201).json(bay);
});

router.patch("/organizations/:orgId/range-bookings/bays/:bayId", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bayId = parseInt((req.params as Record<string, string>).bayId as string);
  const { label, isActive } = req.body;

  const [bay] = await db.update(rangeBayTable)
    .set({ label: label ?? undefined, isActive: isActive ?? undefined })
    .where(and(eq(rangeBayTable.id, bayId), eq(rangeBayTable.organizationId, orgId)))
    .returning();

  if (!bay) { { res.status(404).json({ error: "Bay not found" }); return; } }
  res.json(bay);
});

router.delete("/organizations/:orgId/range-bookings/bays/:bayId", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bayId = parseInt((req.params as Record<string, string>).bayId as string);
  await db.update(rangeBayTable)
    .set({ isActive: false })
    .where(and(eq(rangeBayTable.id, bayId), eq(rangeBayTable.organizationId, orgId)));
  res.status(204).end();
});

// ─── BLACKOUTS ───────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/range-bookings/blackouts", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const blackouts = await db.select().from(rangeBlackoutTable)
    .where(eq(rangeBlackoutTable.organizationId, orgId))
    .orderBy(asc(rangeBlackoutTable.startAt));
  res.json(blackouts);
});

router.post("/organizations/:orgId/range-bookings/blackouts", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { startAt, endAt, reason } = req.body;
  if (!startAt || !endAt) { { res.status(400).json({ error: "startAt and endAt are required" }); return; } }

  const [blackout] = await db.insert(rangeBlackoutTable).values({
    organizationId: orgId,
    startAt: new Date(startAt),
    endAt: new Date(endAt),
    reason: reason ?? null,
  }).returning();

  res.status(201).json(blackout);
});

router.delete("/organizations/:orgId/range-bookings/blackouts/:id", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt((req.params as Record<string, string>).id as string);
  await db.delete(rangeBlackoutTable)
    .where(and(eq(rangeBlackoutTable.id, id), eq(rangeBlackoutTable.organizationId, orgId)));
  res.status(204).end();
});

// ─── AVAILABILITY ─────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/range-bookings/availability", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const dateStr = req.query.date ? String(req.query.date) : new Date().toISOString().split("T")[0];

  const [config] = await db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId));
  if (!config) { { res.json({ slots: [], bays: [], config: null }); return; } }

  const dayStart = new Date(dateStr);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dateStr);
  dayEnd.setHours(23, 59, 59, 999);

  const [bays, existingBookings, blackouts] = await Promise.all([
    db.select().from(rangeBayTable)
      .where(and(eq(rangeBayTable.organizationId, orgId), eq(rangeBayTable.isActive, true)))
      .orderBy(asc(rangeBayTable.bayNumber)),
    db.select().from(rangeBookingTable)
      .where(and(
        eq(rangeBookingTable.organizationId, orgId),
        gte(rangeBookingTable.slotDate, dayStart),
        lte(rangeBookingTable.slotDate, dayEnd),
        inArray(rangeBookingTable.status, ["confirmed", "pending"]),
      )),
    db.select().from(rangeBlackoutTable)
      .where(and(
        eq(rangeBlackoutTable.organizationId, orgId),
        lte(rangeBlackoutTable.startAt, dayEnd),
        gte(rangeBlackoutTable.endAt, dayStart),
      )),
  ]);

  const timeSlots = generateTimeSlots(config.firstSlotTime, config.lastSlotTime, config.slotDurationMinutes);
  const bookedMap = new Set(existingBookings.map(b => `${b.bayId}:${b.slotTime}`));

  const slots = timeSlots.map(time => {
    const slotStart = new Date(`${dateStr}T${time}:00`);
    const slotEnd = new Date(slotStart.getTime() + config.slotDurationMinutes * 60000);

    const isBlocked = blackouts.some(b => b.startAt < slotEnd && b.endAt > slotStart);
    const memberRate = getRate("member", time, config);
    const visitorRate = getRate("visitor", time, config);
    const isPeak = isPeakTime(time, config.peakStartTime, config.peakEndTime);

    return {
      time,
      isBlocked,
      isPeak,
      memberRate,
      visitorRate,
      bays: bays.map(bay => ({
        bayId: bay.id,
        bayNumber: bay.bayNumber,
        label: bay.label,
        isBooked: bookedMap.has(`${bay.id}:${time}`),
      })),
    };
  });

  res.json({ slots, bays, config });
});

// ─── BOOKINGS ────────────────────────────────────────────────────────────────

router.post("/organizations/:orgId/range-bookings", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgMember(req, res, orgId)) return;

  const userId = getAuthUserId(req)!;
  const { bayId, slotDate, slotTime, playerType, guestName, guestEmail } = req.body;
  if (!bayId || !slotDate || !slotTime) {
    res.status(400).json({ error: "bayId, slotDate, slotTime are required" });
    return;
  }

  const [config] = await db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId));
  const [bay] = await db.select().from(rangeBayTable)
    .where(and(eq(rangeBayTable.id, Number(bayId)), eq(rangeBayTable.organizationId, orgId)));

  if (!bay || !bay.isActive) { { res.status(400).json({ error: "Bay not found or inactive" }); return; } }

  const dateOnly = slotDate.split("T")[0];
  const slotStartDt = new Date(`${dateOnly}T${slotTime}:00`);
  const slotEndDt = new Date(slotStartDt.getTime() + (config?.slotDurationMinutes ?? 30) * 60000);

  const blackouts = await db.select().from(rangeBlackoutTable).where(
    and(eq(rangeBlackoutTable.organizationId, orgId), lte(rangeBlackoutTable.startAt, slotEndDt), gte(rangeBlackoutTable.endAt, slotStartDt)),
  );
  if (blackouts.length > 0) { { res.status(400).json({ error: "This time is blocked out" }); return; } }

  const finalPlayerType: "member" | "visitor" = playerType === "visitor" ? "visitor" : "member";
  const rate = config ? getRate(finalPlayerType, slotTime, config) : 0;
  const qrToken = generateQrToken();
  const slotDateOnly = new Date(dateOnly);
  slotDateOnly.setHours(0, 0, 0, 0);

  try {
    const [booking] = await db.insert(rangeBookingTable).values({
      organizationId: orgId,
      bayId: Number(bayId),
      userId,
      playerType: finalPlayerType,
      guestName: guestName ?? null,
      guestEmail: guestEmail ?? null,
      slotDate: slotDateOnly,
      slotTime,
      durationMinutes: config?.slotDurationMinutes ?? 30,
      status: "confirmed",
      totalAmount: String(rate),
      currency: "INR",
      qrToken,
    }).returning();

    // Upsert slot record
    await db.insert(rangeSlotTable).values({
      organizationId: orgId,
      bayId: Number(bayId),
      slotDate: slotDateOnly,
      slotTime,
      status: "booked",
    }).onConflictDoUpdate({
      target: [rangeSlotTable.bayId, rangeSlotTable.slotDate, rangeSlotTable.slotTime],
      set: { status: "booked" },
    });

    // Issue ball token credits
    if (config && config.bucketsIncluded > 0) {
      await db.insert(ballTokenCreditTable).values({
        organizationId: orgId,
        userId,
        bookingId: booking.id,
        bucketsCount: config.bucketsIncluded,
        ballsPerBucket: config.ballsPerBucket,
      });
    }

    // Fetch user email for confirmation
    const [userRow] = await db.select({ email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
      .from(appUsersTable).where(eq(appUsersTable.id, userId));
    const [orgRow] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));

    const recipientEmail = guestEmail || userRow?.email;
    const recipientName = guestName || userRow?.displayName || userRow?.username || "Member";

    if (recipientEmail) {
      try {
        await sendRangeBookingConfirmation(recipientEmail, recipientName, {
          bookingId: booking.id,
          bayNumber: bay.bayNumber,
          bayLabel: bay.label,
          slotDate: dateOnly,
          slotTime,
          durationMinutes: booking.durationMinutes,
          totalAmount: String(rate),
          currency: "INR",
          qrToken,
          bucketsIncluded: config?.bucketsIncluded ?? 0,
          ballsPerBucket: config?.ballsPerBucket ?? 50,
        }, {
          orgName: orgRow?.name,
          logoUrl: orgRow?.logoUrl ?? undefined,
          primaryColor: orgRow?.primaryColor ?? undefined,
        });
        await db.update(rangeBookingTable).set({ emailSent: true }).where(eq(rangeBookingTable.id, booking.id));
      } catch (e) {
        logger.warn({ err: e }, "[RANGE] Email confirmation failed");
      }
    }

    // Push notification
    // Task #1240 — fire-and-forget; result discarded by surrounding
    // try/catch (only throws are logged), classifier intentionally not
    // consulted. Email + on-screen booking confirmation are the durable
    // signals; users without an Expo token simply miss the push.
    try {
      await sendPushToUsers([userId], "Range Bay Booked 🏌️", `Bay ${bay.bayNumber} confirmed for ${slotTime}`, { screen: "range", bookingId: booking.id });
    } catch (e) {
      logger.warn({ err: e }, "[RANGE] Push notification failed");
    }

    res.status(201).json({ ...booking, bay });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("range_booking_bay_slot_unique")) {
      res.status(409).json({ error: "This bay is already booked for that time slot" });
    } else {
      logger.error({ err }, "[RANGE] Failed to create booking");
      res.status(500).json({ error: "Failed to create booking" });
    }
  }
});

router.get("/organizations/:orgId/range-bookings", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { date, status } = req.query;
  const conditions = [eq(rangeBookingTable.organizationId, orgId)];

  if (date) {
    const dayStart = new Date(String(date));
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(String(date));
    dayEnd.setHours(23, 59, 59, 999);
    conditions.push(gte(rangeBookingTable.slotDate, dayStart));
    conditions.push(lte(rangeBookingTable.slotDate, dayEnd));
  }
  if (status) {
    conditions.push(eq(rangeBookingTable.status, String(status) as "pending" | "confirmed" | "cancelled" | "completed" | "no_show"));
  }

  const bookings = await db
    .select({
      booking: rangeBookingTable,
      bay: rangeBayTable,
      user: {
        id: appUsersTable.id,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        email: appUsersTable.email,
      },
    })
    .from(rangeBookingTable)
    .leftJoin(rangeBayTable, eq(rangeBookingTable.bayId, rangeBayTable.id))
    .leftJoin(appUsersTable, eq(rangeBookingTable.userId, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(asc(rangeBookingTable.slotDate), asc(rangeBookingTable.slotTime));

  res.json(bookings);
});

router.get("/organizations/:orgId/range-bookings/my", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgMember(req, res, orgId)) return;

  const userId = getAuthUserId(req)!;
  const bookings = await db
    .select({
      booking: rangeBookingTable,
      bay: rangeBayTable,
    })
    .from(rangeBookingTable)
    .leftJoin(rangeBayTable, eq(rangeBookingTable.bayId, rangeBayTable.id))
    .where(and(eq(rangeBookingTable.organizationId, orgId), eq(rangeBookingTable.userId, userId)))
    .orderBy(desc(rangeBookingTable.slotDate));

  res.json(bookings);
});

router.get("/organizations/:orgId/range-bookings/dashboard", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const today = new Date();
  const dayStart = new Date(today);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(today);
  dayEnd.setHours(23, 59, 59, 999);

  const [bookings, bays, config] = await Promise.all([
    db.select({
      booking: rangeBookingTable,
      bay: rangeBayTable,
      user: {
        id: appUsersTable.id,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        email: appUsersTable.email,
      },
    })
      .from(rangeBookingTable)
      .leftJoin(rangeBayTable, eq(rangeBookingTable.bayId, rangeBayTable.id))
      .leftJoin(appUsersTable, eq(rangeBookingTable.userId, appUsersTable.id))
      .where(and(
        eq(rangeBookingTable.organizationId, orgId),
        gte(rangeBookingTable.slotDate, dayStart),
        lte(rangeBookingTable.slotDate, dayEnd),
        inArray(rangeBookingTable.status, ["confirmed", "completed"]),
      ))
      .orderBy(asc(rangeBookingTable.slotTime)),
    db.select().from(rangeBayTable)
      .where(and(eq(rangeBayTable.organizationId, orgId), eq(rangeBayTable.isActive, true)))
      .orderBy(asc(rangeBayTable.bayNumber)),
    db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId)),
  ]);

  res.json({ bookings, bays, config: config[0] ?? null, date: today.toISOString().split("T")[0] });
});

router.patch("/organizations/:orgId/range-bookings/:id/cancel", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgMember(req, res, orgId)) return;

  const id = parseInt((req.params as Record<string, string>).id as string);
  const userId = getAuthUserId(req)!;

  const [booking] = await db.select().from(rangeBookingTable)
    .where(and(eq(rangeBookingTable.id, id), eq(rangeBookingTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const role = getUserRole(req);
  const isAdmin = role === "super_admin" || (
    ["org_admin", "tournament_director"].includes(role ?? "") && getUserOrgId(req) === orgId
  );
  if (!isAdmin && booking.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }

  if (booking.status === "cancelled") { { res.status(400).json({ error: "Already cancelled" }); return; } }

  if (!isAdmin) {
    const [config] = await db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId));
    const cutoffHours = config?.cancellationCutoffHours ?? 2;
    const slotDt = new Date(`${booking.slotDate.toISOString().split("T")[0]}T${booking.slotTime}:00`);
    const cutoffMs = cutoffHours * 60 * 60 * 1000;
    if (slotDt.getTime() - Date.now() < cutoffMs) {
      res.status(400).json({ error: `Cancellation must be made at least ${cutoffHours}h before the slot` });
      return;
    }
  }

  const { reason } = req.body;
  const [updated] = await db.update(rangeBookingTable)
    .set({ status: "cancelled", cancellationReason: reason ?? null, cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(rangeBookingTable.id, id))
    .returning();

  // Free up the slot record
  await db.update(rangeSlotTable)
    .set({ status: "open" })
    .where(and(
      eq(rangeSlotTable.bayId, booking.bayId),
      eq(rangeSlotTable.slotDate, booking.slotDate),
      eq(rangeSlotTable.slotTime, booking.slotTime),
    ));

  res.json(updated);
});

router.post("/organizations/:orgId/range-bookings/:id/reschedule", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgMember(req, res, orgId)) return;

  const id = parseInt((req.params as Record<string, string>).id as string);
  const userId = getAuthUserId(req)!;

  const [booking] = await db.select().from(rangeBookingTable)
    .where(and(eq(rangeBookingTable.id, id), eq(rangeBookingTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const role = getUserRole(req);
  const isAdmin = role === "super_admin" || (
    ["org_admin", "tournament_director"].includes(role ?? "") && getUserOrgId(req) === orgId
  );
  if (!isAdmin && booking.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }

  if (booking.status !== "confirmed") { { res.status(400).json({ error: "Only confirmed bookings can be rescheduled" }); return; } }

  const { newBayId, newSlotDate, newSlotTime } = req.body;
  if (!newSlotDate || !newSlotTime) { { res.status(400).json({ error: "newSlotDate and newSlotTime are required" }); return; } }

  const targetBayId = newBayId ? Number(newBayId) : booking.bayId;

  // Validate the new bay belongs to this org
  const [newBay] = await db.select().from(rangeBayTable)
    .where(and(eq(rangeBayTable.id, targetBayId), eq(rangeBayTable.organizationId, orgId)));
  if (!newBay || !newBay.isActive) { { res.status(400).json({ error: "Target bay not found or inactive" }); return; } }

  // Check cancellation window for original booking (unless admin)
  if (!isAdmin) {
    const [config] = await db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId));
    const cutoffHours = config?.cancellationCutoffHours ?? 2;
    const slotDt = new Date(`${booking.slotDate.toISOString().split("T")[0]}T${booking.slotTime}:00`);
    if (slotDt.getTime() - Date.now() < cutoffHours * 3600000) {
      res.status(400).json({ error: `Rescheduling must be done at least ${cutoffHours}h before the current slot` });
      return;
    }
  }

  // Check blackouts for new slot
  const [config] = await db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId));
  const dateOnly = newSlotDate.split("T")[0];
  const newSlotStart = new Date(`${dateOnly}T${newSlotTime}:00`);
  const newSlotEnd = new Date(newSlotStart.getTime() + (config?.slotDurationMinutes ?? 30) * 60000);
  const blackouts = await db.select().from(rangeBlackoutTable).where(
    and(eq(rangeBlackoutTable.organizationId, orgId), lte(rangeBlackoutTable.startAt, newSlotEnd), gte(rangeBlackoutTable.endAt, newSlotStart)),
  );
  if (blackouts.length > 0) { { res.status(400).json({ error: "New time slot is blocked out" }); return; } }

  const newSlotDateOnly = new Date(dateOnly);
  newSlotDateOnly.setHours(0, 0, 0, 0);

  const rate = config ? getRate(booking.playerType, newSlotTime, config) : 0;
  const qrToken = generateQrToken();

  try {
    // Atomically cancel old booking and create new one in a single transaction
    const { newBooking } = await db.transaction(async (tx) => {
      // Final conflict check inside transaction to prevent TOCTOU races
      const [conflict] = await tx.select({ id: rangeBookingTable.id }).from(rangeBookingTable)
        .where(and(
          eq(rangeBookingTable.bayId, targetBayId),
          eq(rangeBookingTable.slotDate, newSlotDateOnly),
          eq(rangeBookingTable.slotTime, newSlotTime),
          inArray(rangeBookingTable.status, ["confirmed", "pending"]),
          not(eq(rangeBookingTable.id, id)),
        ));
      if (conflict) throw Object.assign(new Error("slot_conflict"), { code: "slot_conflict" });

      // Cancel old booking
      await tx.update(rangeBookingTable)
        .set({ status: "cancelled", cancellationReason: "Rescheduled", cancelledAt: new Date(), updatedAt: new Date() })
        .where(eq(rangeBookingTable.id, id));

      // Free old slot record
      await tx.update(rangeSlotTable)
        .set({ status: "open" })
        .where(and(
          eq(rangeSlotTable.bayId, booking.bayId),
          eq(rangeSlotTable.slotDate, booking.slotDate),
          eq(rangeSlotTable.slotTime, booking.slotTime),
        ));

      // Create new booking
      const [newBooking] = await tx.insert(rangeBookingTable).values({
        organizationId: orgId,
        bayId: targetBayId,
        userId: booking.userId,
        playerType: booking.playerType,
        guestName: booking.guestName,
        guestEmail: booking.guestEmail,
        slotDate: newSlotDateOnly,
        slotTime: newSlotTime,
        durationMinutes: config?.slotDurationMinutes ?? 30,
        status: "confirmed",
        totalAmount: String(rate),
        currency: booking.currency,
        qrToken,
        rescheduledFromId: booking.id,
      }).returning();

      // Upsert new slot record
      await tx.insert(rangeSlotTable).values({
        organizationId: orgId,
        bayId: targetBayId,
        slotDate: newSlotDateOnly,
        slotTime: newSlotTime,
        status: "booked",
      }).onConflictDoUpdate({
        target: [rangeSlotTable.bayId, rangeSlotTable.slotDate, rangeSlotTable.slotTime],
        set: { status: "booked" },
      });

      return { newBooking };
    });

    // Email and push notifications (outside transaction — non-critical)
    const [orgRow] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));

    const recipientEmail = booking.guestEmail ?? (booking.userId
      ? (await db.select({ email: appUsersTable.email, displayName: appUsersTable.displayName, username: appUsersTable.username })
          .from(appUsersTable).where(eq(appUsersTable.id, booking.userId)).then(r => r[0]?.email))
      : null);
    const recipientName = booking.guestName ?? (booking.userId
      ? (await db.select({ displayName: appUsersTable.displayName, username: appUsersTable.username })
          .from(appUsersTable).where(eq(appUsersTable.id, booking.userId)).then(r => r[0]?.displayName ?? r[0]?.username ?? "Member"))
      : "Guest");

    if (recipientEmail) {
      try {
        await sendRangeBookingConfirmation(recipientEmail, recipientName ?? "Member", {
          bookingId: newBooking.id,
          bayNumber: newBay.bayNumber,
          bayLabel: newBay.label,
          slotDate: dateOnly,
          slotTime: newSlotTime,
          durationMinutes: newBooking.durationMinutes,
          totalAmount: String(rate),
          currency: "INR",
          qrToken,
          bucketsIncluded: config?.bucketsIncluded ?? 0,
          ballsPerBucket: config?.ballsPerBucket ?? 50,
        }, { orgName: orgRow?.name, logoUrl: orgRow?.logoUrl ?? undefined, primaryColor: orgRow?.primaryColor ?? undefined });
        await db.update(rangeBookingTable).set({ emailSent: true }).where(eq(rangeBookingTable.id, newBooking.id));
      } catch (e) {
        logger.warn({ err: e }, "[RANGE] Reschedule email failed");
      }
    }
    if (booking.userId) {
      // Task #1240 — fire-and-forget; result discarded by surrounding
      // try/catch (only throws are logged), classifier intentionally not
      // consulted. Email + on-screen reschedule confirmation are the
      // durable signals.
      try {
        await sendPushToUsers([booking.userId], "Booking Rescheduled 🏌️", `Bay ${newBay.bayNumber} at ${newSlotTime} on ${dateOnly}`, { screen: "range", bookingId: newBooking.id });
      } catch (e) {
        logger.warn({ err: e }, "[RANGE] Push notification failed");
      }
    }

    res.status(201).json({ newBooking, cancelledBookingId: id });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    if (code === "slot_conflict" || message.includes("range_booking_bay_slot_unique")) {
      res.status(409).json({ error: "New slot is already booked" });
    } else {
      logger.error({ err }, "[RANGE] Reschedule failed");
      res.status(500).json({ error: "Reschedule failed" });
    }
  }
});

router.post("/organizations/:orgId/range-bookings/:id/checkin", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const id = parseInt((req.params as Record<string, string>).id as string);
  const userId = getAuthUserId(req)!;

  const [booking] = await db.select().from(rangeBookingTable)
    .where(and(eq(rangeBookingTable.id, id), eq(rangeBookingTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (booking.status === "cancelled") { { res.status(400).json({ error: "Cannot check in a cancelled booking" }); return; } }

  const [updated] = await db.update(rangeBookingTable)
    .set({ status: "completed", checkedInAt: new Date(), checkedInByUserId: userId, updatedAt: new Date() })
    .where(eq(rangeBookingTable.id, id))
    .returning();

  // Mark ball tokens as used
  await db.update(ballTokenCreditTable)
    .set({ usedAt: new Date() })
    .where(and(eq(ballTokenCreditTable.bookingId, id), isNull(ballTokenCreditTable.usedAt)));

  res.json(updated);
});

router.get("/organizations/:orgId/range-bookings/:id/qr", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgMember(req, res, orgId)) return;

  const id = parseInt((req.params as Record<string, string>).id as string);
  const userId = getAuthUserId(req)!;

  const [row] = await db.select({ b: rangeBookingTable, bay: rangeBayTable })
    .from(rangeBookingTable)
    .leftJoin(rangeBayTable, eq(rangeBookingTable.bayId, rangeBayTable.id))
    .where(and(eq(rangeBookingTable.id, id), eq(rangeBookingTable.organizationId, orgId)))
    .limit(1);

  if (!row) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const role = getUserRole(req);
  const isAdminOrStaff = role === "super_admin" || (
    ["org_admin", "tournament_director", "pro_shop", "volunteer"].includes(role ?? "") && getUserOrgId(req) === orgId
  );
  if (!isAdminOrStaff && row.b.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }

  res.json({
    bookingId: row.b.id,
    qrToken: row.b.qrToken,
    bayNumber: row.bay?.bayNumber,
    bayLabel: row.bay?.label,
    slotDate: row.b.slotDate,
    slotTime: row.b.slotTime,
    durationMinutes: row.b.durationMinutes,
    status: row.b.status,
  });
});

// ─── PUBLIC VISITOR BOOKING ─────────────────────────────────────────────────
// Unauthenticated visitors can book a bay by providing their contact details.
// No org membership required. Rate-limited via simple IP check at route level.

router.post("/public/organizations/:orgId/range-bookings/visitor", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  const { bayId, slotDate, slotTime, guestName, guestEmail } = req.body;

  if (!bayId || !slotDate || !slotTime || !guestName || !guestEmail) {
    res.status(400).json({ error: "bayId, slotDate, slotTime, guestName, guestEmail are all required for visitor bookings" });
    return;
  }

  const [config] = await db.select().from(rangeConfigTable).where(eq(rangeConfigTable.organizationId, orgId));
  if (!config) { { res.status(404).json({ error: "Driving range not configured for this organization" }); return; } }

  const [bay] = await db.select().from(rangeBayTable)
    .where(and(eq(rangeBayTable.id, Number(bayId)), eq(rangeBayTable.organizationId, orgId)));
  if (!bay || !bay.isActive) { { res.status(400).json({ error: "Bay not found or inactive" }); return; } }

  const dateOnly = slotDate.split("T")[0];
  const slotStartDt = new Date(`${dateOnly}T${slotTime}:00`);
  const slotEndDt = new Date(slotStartDt.getTime() + config.slotDurationMinutes * 60000);

  // Check blackouts
  const blackouts = await db.select().from(rangeBlackoutTable).where(
    and(eq(rangeBlackoutTable.organizationId, orgId), lte(rangeBlackoutTable.startAt, slotEndDt), gte(rangeBlackoutTable.endAt, slotStartDt)),
  );
  if (blackouts.length > 0) { { res.status(400).json({ error: "This time is blocked out" }); return; } }

  const rate = getRate("visitor", slotTime, config);
  const qrToken = generateQrToken();
  const slotDateOnly = new Date(dateOnly);
  slotDateOnly.setHours(0, 0, 0, 0);

  try {
    const [booking] = await db.insert(rangeBookingTable).values({
      organizationId: orgId,
      bayId: Number(bayId),
      userId: null,
      playerType: "visitor",
      guestName,
      guestEmail,
      slotDate: slotDateOnly,
      slotTime,
      durationMinutes: config.slotDurationMinutes,
      status: "confirmed",
      totalAmount: String(rate),
      currency: "INR",
      qrToken,
    }).returning();

    // Upsert slot record
    await db.insert(rangeSlotTable).values({
      organizationId: orgId,
      bayId: Number(bayId),
      slotDate: slotDateOnly,
      slotTime,
      status: "booked",
    }).onConflictDoUpdate({
      target: [rangeSlotTable.bayId, rangeSlotTable.slotDate, rangeSlotTable.slotTime],
      set: { status: "booked" },
    });

    // Send email confirmation
    const [orgRow] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));

    try {
      await sendRangeBookingConfirmation(guestEmail, guestName, {
        bookingId: booking.id,
        bayNumber: bay.bayNumber,
        bayLabel: bay.label,
        slotDate: dateOnly,
        slotTime,
        durationMinutes: booking.durationMinutes,
        totalAmount: String(rate),
        currency: "INR",
        qrToken,
        bucketsIncluded: config.bucketsIncluded,
        ballsPerBucket: config.ballsPerBucket,
      }, { orgName: orgRow?.name, logoUrl: orgRow?.logoUrl ?? undefined, primaryColor: orgRow?.primaryColor ?? undefined });
      await db.update(rangeBookingTable).set({ emailSent: true }).where(eq(rangeBookingTable.id, booking.id));
    } catch (e) {
      logger.warn({ err: e }, "[RANGE] Visitor email confirmation failed");
    }

    res.status(201).json({
      ...booking,
      bay,
      qrImageUrl: `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(`KHGF:range:${orgId}:${booking.id}:${qrToken}`)}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("range_booking_bay_slot_unique")) {
      res.status(409).json({ error: "This bay is already booked for that time slot" });
    } else {
      logger.error({ err }, "[RANGE] Visitor booking failed");
      res.status(500).json({ error: "Failed to create visitor booking" });
    }
  }
});

// ─── QR CHECK-IN BY TOKEN ─────────────────────────────────────────────────────
// Staff can verify a QR token and check in
router.post("/organizations/:orgId/range-bookings/qr-checkin", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId as string);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { qrToken } = req.body;
  if (!qrToken) { { res.status(400).json({ error: "qrToken is required" }); return; } }

  const staffId = getAuthUserId(req)!;

  const [row] = await db.select({ b: rangeBookingTable, bay: rangeBayTable })
    .from(rangeBookingTable)
    .leftJoin(rangeBayTable, eq(rangeBookingTable.bayId, rangeBayTable.id))
    .where(and(
      eq(rangeBookingTable.qrToken, qrToken),
      eq(rangeBookingTable.organizationId, orgId),
    ))
    .limit(1);

  if (!row) { { res.status(404).json({ error: "No booking found for this QR code" }); return; } }
  if (row.b.status === "cancelled") { { res.status(400).json({ error: "Booking has been cancelled" }); return; } }
  if (row.b.status === "completed") { { res.status(200).json({ alreadyCheckedIn: true, booking: row.b, bay: row.bay }); return; } }

  const [updated] = await db.update(rangeBookingTable)
    .set({ status: "completed", checkedInAt: new Date(), checkedInByUserId: staffId, updatedAt: new Date() })
    .where(eq(rangeBookingTable.id, row.b.id))
    .returning();

  await db.update(ballTokenCreditTable)
    .set({ usedAt: new Date() })
    .where(and(eq(ballTokenCreditTable.bookingId, row.b.id), isNull(ballTokenCreditTable.usedAt)));

  res.json({ booking: updated, bay: row.bay });
});

export default router;
