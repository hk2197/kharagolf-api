/**
 * Golf Trip & Away Day Planner API
 * Scoped to: /organizations/:orgId/trips
 *
 * Trip CRUD
 * GET    /                           List org trips
 * POST   /                           Create trip (admin)
 * GET    /:tripId                    Get trip details
 * PATCH  /:tripId                    Update trip (admin)
 * DELETE /:tripId                    Delete trip (admin)
 *
 * Participants
 * GET    /:tripId/participants        List participants
 * POST   /:tripId/participants        Sign up (portal user)
 * PATCH  /:tripId/participants/:pid   Update participant (admin)
 * DELETE /:tripId/participants/:pid   Remove participant (admin)
 * POST   /:tripId/participants/:pid/deposit/order   Create Razorpay order for deposit
 * POST   /:tripId/participants/:pid/deposit/verify  Verify deposit payment
 * POST   /:tripId/participants/:pid/deposit/mark-paid  Admin: mark deposit paid
 *
 * Itinerary
 * GET    /:tripId/itinerary          Get itinerary items
 * POST   /:tripId/itinerary          Add itinerary item (admin)
 * PATCH  /:tripId/itinerary/:itemId  Update itinerary item (admin)
 * DELETE /:tripId/itinerary/:itemId  Delete itinerary item (admin)
 *
 * Rooms
 * GET    /:tripId/rooms              List rooms
 * POST   /:tripId/rooms              Create room (admin)
 * PATCH  /:tripId/rooms/:roomId      Update room (admin)
 * DELETE /:tripId/rooms/:roomId      Delete room (admin)
 * POST   /:tripId/rooms/:roomId/assign          Assign participant to room
 * DELETE /:tripId/rooms/:roomId/assign/:pid     Remove from room
 *
 * Cars
 * GET    /:tripId/cars               List cars
 * POST   /:tripId/cars               Create car (admin)
 * PATCH  /:tripId/cars/:carId        Update car (admin)
 * DELETE /:tripId/cars/:carId        Delete car (admin)
 * POST   /:tripId/cars/:carId/assign          Assign participant to car
 * DELETE /:tripId/cars/:carId/assign/:pid     Remove from car
 *
 * Tee Slots
 * GET    /:tripId/tee-slots          List tee slots
 * POST   /:tripId/tee-slots          Create tee slot (admin)
 * PATCH  /:tripId/tee-slots/:slotId  Update tee slot (admin)
 * DELETE /:tripId/tee-slots/:slotId  Delete tee slot (admin)
 * POST   /:tripId/tee-slots/:slotId/assign         Assign participant
 * DELETE /:tripId/tee-slots/:slotId/assign/:pid    Remove from slot
 *
 * Expenses
 * GET    /:tripId/expenses           List expenses + settlement summary
 * POST   /:tripId/expenses           Add expense (admin)
 * PATCH  /:tripId/expenses/:expId    Update expense (admin)
 * DELETE /:tripId/expenses/:expId    Delete expense (admin)
 *
 * Leaderboard
 * GET    /:tripId/leaderboard        Trip leaderboard across all rounds
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  golfTripsTable,
  tripItineraryItemsTable,
  tripParticipantsTable,
  tripRoomsTable,
  tripCarsTable,
  tripRoomAssignmentsTable,
  tripCarAssignmentsTable,
  tripTeeSlotsTable,
  tripTeeSlotAssignmentsTable,
  tripExpensesTable,
  appUsersTable,
  organizationsTable,
  tournamentsTable,
  playersTable,
  scoresTable,
  holeDetailsTable,
  coursesTable,
} from "@workspace/db";
import { eq, and, desc, asc, inArray, sql, sum } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { getRazorpayClient, getRazorpayKeyId } from "../lib/razorpay";
import { logger } from "../lib/logger";
import crypto from "crypto";

const router: IRouter = Router({ mergeParams: true });

/* ─── Auth helpers ──────────────────────────────────────────────── */

interface SessionUser { id: number; role?: string; organizationId?: number | null; displayName?: string; email?: string }

function getUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
}

function isPortalAuth(req: Request): boolean {
  return !!(req as unknown as Record<string, unknown>).portalUser || req.isAuthenticated();
}

function getPortalUserId(req: Request): number | null {
  const pu = (req as unknown as Record<string, unknown>).portalUser as { id?: number } | undefined;
  if (pu?.id) return pu.id;
  const u = req.user as { id?: number } | undefined;
  return u?.id ?? null;
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function fmt<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out as T;
}

async function verifyTripBelongsToOrg(tripId: number, orgId: number): Promise<boolean> {
  const [trip] = await db.select({ id: golfTripsTable.id })
    .from(golfTripsTable)
    .where(and(eq(golfTripsTable.id, tripId), eq(golfTripsTable.organizationId, orgId)));
  return !!trip;
}

/* ══════════════════════════════════════════════════════════════════
   TRIPS
══════════════════════════════════════════════════════════════════ */

// GET /organizations/:orgId/trips
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  try {
    const trips = await db.select()
      .from(golfTripsTable)
      .where(eq(golfTripsTable.organizationId, orgId))
      .orderBy(desc(golfTripsTable.startDate));

    res.json(trips.map(fmt));
  } catch (err) {
    logger.error({ err }, "trips: list error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /organizations/:orgId/trips
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, destination, externalCourseName, description, startDate, endDate,
    status, maxParticipants, depositAmount, currency, estimatedTotalCost, notes } = req.body;

  if (!name || !destination || !externalCourseName || !startDate || !endDate) {
    res.status(400).json({ error: "name, destination, externalCourseName, startDate, endDate are required" });
    return;
  }

  try {
    const user = getUser(req);
    const [trip] = await db.insert(golfTripsTable).values({
      organizationId: orgId,
      name,
      destination,
      externalCourseName,
      description: description ?? null,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      status: status ?? "draft",
      maxParticipants: maxParticipants ?? null,
      depositAmount: depositAmount?.toString() ?? null,
      currency: currency ?? "INR",
      estimatedTotalCost: estimatedTotalCost?.toString() ?? null,
      notes: notes ?? null,
      createdBy: user?.id ?? null,
    }).returning();

    res.status(201).json(fmt(trip));
  } catch (err) {
    logger.error({ err }, "trips: create error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /organizations/:orgId/trips/:tripId
router.get("/:tripId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  try {
    const [trip] = await db.select()
      .from(golfTripsTable)
      .where(and(eq(golfTripsTable.id, tripId), eq(golfTripsTable.organizationId, orgId)));

    if (!trip) { { res.status(404).json({ error: "Trip not found" }); return; } }
    res.json(fmt(trip));
  } catch (err) {
    logger.error({ err }, "trips: get error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /organizations/:orgId/trips/:tripId
router.patch("/:tripId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, destination, externalCourseName, description, startDate, endDate,
    status, maxParticipants, depositAmount, currency, estimatedTotalCost, notes } = req.body;

  try {
    const updates: Partial<typeof golfTripsTable.$inferInsert> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (destination !== undefined) updates.destination = destination;
    if (externalCourseName !== undefined) updates.externalCourseName = externalCourseName;
    if (description !== undefined) updates.description = description;
    if (startDate !== undefined) updates.startDate = new Date(startDate);
    if (endDate !== undefined) updates.endDate = new Date(endDate);
    if (status !== undefined) updates.status = status;
    if (maxParticipants !== undefined) updates.maxParticipants = maxParticipants;
    if (depositAmount !== undefined) updates.depositAmount = depositAmount?.toString() ?? null;
    if (currency !== undefined) updates.currency = currency;
    if (estimatedTotalCost !== undefined) updates.estimatedTotalCost = estimatedTotalCost?.toString() ?? null;
    if (notes !== undefined) updates.notes = notes;

    const [trip] = await db.update(golfTripsTable)
      .set(updates)
      .where(and(eq(golfTripsTable.id, tripId), eq(golfTripsTable.organizationId, orgId)))
      .returning();

    if (!trip) { { res.status(404).json({ error: "Trip not found" }); return; } }
    res.json(fmt(trip));
  } catch (err) {
    logger.error({ err }, "trips: update error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /organizations/:orgId/trips/:tripId
router.delete("/:tripId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(golfTripsTable)
      .where(and(eq(golfTripsTable.id, tripId), eq(golfTripsTable.organizationId, orgId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: delete error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   PARTICIPANTS
══════════════════════════════════════════════════════════════════ */

// GET /:tripId/participants
router.get("/:tripId/participants", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  try {
    const participants = await db.select()
      .from(tripParticipantsTable)
      .where(eq(tripParticipantsTable.tripId, tripId))
      .orderBy(asc(tripParticipantsTable.signedUpAt));

    res.json(participants.map(fmt));
  } catch (err) {
    logger.error({ err }, "trips: list participants error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/participants  (portal user sign-up OR admin adding someone)
router.post("/:tripId/participants", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  const { firstName, lastName, email, phone, handicapIndex, notes, userId } = req.body;
  if (!firstName || !lastName) { { res.status(400).json({ error: "firstName and lastName are required" }); return; } }

  try {
    const [participant] = await db.insert(tripParticipantsTable).values({
      tripId,
      userId: userId ?? null,
      firstName,
      lastName,
      email: email ?? null,
      phone: phone ?? null,
      handicapIndex: handicapIndex?.toString() ?? null,
      status: "confirmed",
      depositStatus: "unpaid",
      notes: notes ?? null,
    }).returning();

    res.status(201).json(fmt(participant));
  } catch (err) {
    logger.error({ err }, "trips: add participant error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:tripId/participants/:pid
router.patch("/:tripId/participants/:pid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { firstName, lastName, email, phone, handicapIndex, status, notes } = req.body;
  try {
    const updates: Partial<typeof tripParticipantsTable.$inferInsert> = {};
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (handicapIndex !== undefined) updates.handicapIndex = handicapIndex?.toString() ?? null;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;

    const [p] = await db.update(tripParticipantsTable)
      .set(updates)
      .where(and(eq(tripParticipantsTable.id, pid), eq(tripParticipantsTable.tripId, tripId)))
      .returning();

    if (!p) { { res.status(404).json({ error: "Participant not found" }); return; } }
    res.json(fmt(p));
  } catch (err) {
    logger.error({ err }, "trips: update participant error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/participants/:pid
router.delete("/:tripId/participants/:pid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripParticipantsTable)
      .where(and(eq(tripParticipantsTable.id, pid), eq(tripParticipantsTable.tripId, tripId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: delete participant error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/participants/:pid/deposit/order
router.post("/:tripId/participants/:pid/deposit/order", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  try {
    const [trip] = await db.select()
      .from(golfTripsTable)
      .where(and(eq(golfTripsTable.id, tripId), eq(golfTripsTable.organizationId, orgId)));
    if (!trip) { { res.status(404).json({ error: "Trip not found" }); return; } }

    const [participant] = await db.select()
      .from(tripParticipantsTable)
      .where(and(eq(tripParticipantsTable.id, pid), eq(tripParticipantsTable.tripId, tripId)));
    if (!participant) { { res.status(404).json({ error: "Participant not found" }); return; } }

    if (!trip.depositAmount) { { res.status(400).json({ error: "No deposit amount configured for this trip" }); return; } }

    const rz = getRazorpayClient();
    const amountPaise = Math.round(parseFloat(trip.depositAmount) * 100);
    const currency = trip.currency ?? "INR";

    const order = await rz.orders.create({
      amount: amountPaise,
      currency,
      receipt: `trip_${tripId}_p_${pid}`,
      notes: {
        tripId: String(tripId),
        participantId: String(pid),
        type: "trip_deposit",
      },
    });

    await db.update(tripParticipantsTable)
      .set({ razorpayOrderId: order.id })
      .where(eq(tripParticipantsTable.id, pid));

    res.json({ orderId: order.id, amount: amountPaise, currency, keyId: getRazorpayKeyId() });
  } catch (err) {
    logger.error({ err }, "trips: create deposit order error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/participants/:pid/deposit/verify
router.post("/:tripId/participants/:pid/deposit/verify", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    res.status(400).json({ error: "razorpay_order_id, razorpay_payment_id, razorpay_signature are required" });
    return;
  }

  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
    const digest = crypto.createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (digest !== razorpay_signature) {
      res.status(400).json({ error: "Invalid payment signature" });
      return;
    }

    const [participant] = await db.update(tripParticipantsTable)
      .set({ depositStatus: "paid", razorpayPaymentId: razorpay_payment_id })
      .where(and(eq(tripParticipantsTable.id, pid), eq(tripParticipantsTable.tripId, tripId)))
      .returning();

    if (!participant) { { res.status(404).json({ error: "Participant not found" }); return; } }
    res.json({ success: true, participant: fmt(participant) });
  } catch (err) {
    logger.error({ err }, "trips: verify deposit error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/participants/:pid/deposit/mark-paid
router.post("/:tripId/participants/:pid/deposit/mark-paid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    const [participant] = await db.update(tripParticipantsTable)
      .set({ depositStatus: "paid" })
      .where(and(eq(tripParticipantsTable.id, pid), eq(tripParticipantsTable.tripId, tripId)))
      .returning();

    if (!participant) { { res.status(404).json({ error: "Participant not found" }); return; } }
    res.json(fmt(participant));
  } catch (err) {
    logger.error({ err }, "trips: mark-paid error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ITINERARY
══════════════════════════════════════════════════════════════════ */

// GET /:tripId/itinerary
router.get("/:tripId/itinerary", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  try {
    const items = await db.select()
      .from(tripItineraryItemsTable)
      .where(eq(tripItineraryItemsTable.tripId, tripId))
      .orderBy(asc(tripItineraryItemsTable.dayNumber), asc(tripItineraryItemsTable.sortOrder));

    res.json(items.map(fmt));
  } catch (err) {
    logger.error({ err }, "trips: list itinerary error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/itinerary
router.post("/:tripId/itinerary", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  const { dayNumber, type, title, location, description, startTime, endTime, sortOrder } = req.body;
  if (!dayNumber || !title) { { res.status(400).json({ error: "dayNumber and title are required" }); return; } }

  try {
    const [item] = await db.insert(tripItineraryItemsTable).values({
      tripId,
      dayNumber,
      type: type ?? "activity",
      title,
      location: location ?? null,
      description: description ?? null,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      sortOrder: sortOrder ?? 0,
    }).returning();

    res.status(201).json(fmt(item));
  } catch (err) {
    logger.error({ err }, "trips: add itinerary item error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:tripId/itinerary/:itemId
router.patch("/:tripId/itinerary/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const itemId = parseInt(String((req.params as Record<string, string>).itemId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(itemId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { dayNumber, type, title, location, description, startTime, endTime, sortOrder } = req.body;
  try {
    const updates: Partial<typeof tripItineraryItemsTable.$inferInsert> = {};
    if (dayNumber !== undefined) updates.dayNumber = dayNumber;
    if (type !== undefined) updates.type = type;
    if (title !== undefined) updates.title = title;
    if (location !== undefined) updates.location = location;
    if (description !== undefined) updates.description = description;
    if (startTime !== undefined) updates.startTime = startTime;
    if (endTime !== undefined) updates.endTime = endTime;
    if (sortOrder !== undefined) updates.sortOrder = sortOrder;

    const [item] = await db.update(tripItineraryItemsTable)
      .set(updates)
      .where(and(eq(tripItineraryItemsTable.id, itemId), eq(tripItineraryItemsTable.tripId, tripId)))
      .returning();

    if (!item) { { res.status(404).json({ error: "Itinerary item not found" }); return; } }
    res.json(fmt(item));
  } catch (err) {
    logger.error({ err }, "trips: update itinerary item error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/itinerary/:itemId
router.delete("/:tripId/itinerary/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const itemId = parseInt(String((req.params as Record<string, string>).itemId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(itemId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripItineraryItemsTable)
      .where(and(eq(tripItineraryItemsTable.id, itemId), eq(tripItineraryItemsTable.tripId, tripId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: delete itinerary item error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ROOMS
══════════════════════════════════════════════════════════════════ */

// GET /:tripId/rooms
router.get("/:tripId/rooms", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  try {
    const rooms = await db.select()
      .from(tripRoomsTable)
      .where(eq(tripRoomsTable.tripId, tripId))
      .orderBy(asc(tripRoomsTable.roomName));

    const assignments = await db.select()
      .from(tripRoomAssignmentsTable)
      .where(inArray(tripRoomAssignmentsTable.roomId, rooms.map(r => r.id)));

    const assignmentsByRoom: Record<number, number[]> = {};
    for (const a of assignments) {
      if (!assignmentsByRoom[a.roomId]) assignmentsByRoom[a.roomId] = [];
      assignmentsByRoom[a.roomId].push(a.participantId);
    }

    res.json(rooms.map(r => ({
      ...fmt(r),
      participantIds: assignmentsByRoom[r.id] ?? [],
    })));
  } catch (err) {
    logger.error({ err }, "trips: list rooms error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/rooms
router.post("/:tripId/rooms", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  const { roomName, roomType, costPerNight, nights, notes } = req.body;
  if (!roomName) { { res.status(400).json({ error: "roomName is required" }); return; } }

  try {
    const [room] = await db.insert(tripRoomsTable).values({
      tripId,
      roomName,
      roomType: roomType ?? null,
      costPerNight: costPerNight?.toString() ?? null,
      nights: nights ?? null,
      notes: notes ?? null,
    }).returning();

    res.status(201).json({ ...fmt(room), participantIds: [] });
  } catch (err) {
    logger.error({ err }, "trips: create room error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:tripId/rooms/:roomId
router.patch("/:tripId/rooms/:roomId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const roomId = parseInt(String((req.params as Record<string, string>).roomId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(roomId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { roomName, roomType, costPerNight, nights, notes } = req.body;
  try {
    const updates: Partial<typeof tripRoomsTable.$inferInsert> = {};
    if (roomName !== undefined) updates.roomName = roomName;
    if (roomType !== undefined) updates.roomType = roomType;
    if (costPerNight !== undefined) updates.costPerNight = costPerNight?.toString() ?? null;
    if (nights !== undefined) updates.nights = nights;
    if (notes !== undefined) updates.notes = notes;

    const [room] = await db.update(tripRoomsTable)
      .set(updates)
      .where(and(eq(tripRoomsTable.id, roomId), eq(tripRoomsTable.tripId, tripId)))
      .returning();

    if (!room) { { res.status(404).json({ error: "Room not found" }); return; } }
    res.json(fmt(room));
  } catch (err) {
    logger.error({ err }, "trips: update room error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/rooms/:roomId
router.delete("/:tripId/rooms/:roomId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const roomId = parseInt(String((req.params as Record<string, string>).roomId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(roomId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripRoomsTable)
      .where(and(eq(tripRoomsTable.id, roomId), eq(tripRoomsTable.tripId, tripId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: delete room error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/rooms/:roomId/assign
router.post("/:tripId/rooms/:roomId/assign", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const roomId = parseInt(String((req.params as Record<string, string>).roomId), 10);
  const participantId = parseInt(req.body.participantId, 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(roomId) || isNaN(participantId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.insert(tripRoomAssignmentsTable)
      .values({ roomId, participantId })
      .onConflictDoNothing();
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: assign room error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/rooms/:roomId/assign/:pid
router.delete("/:tripId/rooms/:roomId/assign/:pid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const roomId = parseInt(String((req.params as Record<string, string>).roomId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(roomId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripRoomAssignmentsTable)
      .where(and(eq(tripRoomAssignmentsTable.roomId, roomId), eq(tripRoomAssignmentsTable.participantId, pid)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: remove room assignment error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   CARS
══════════════════════════════════════════════════════════════════ */

// GET /:tripId/cars
router.get("/:tripId/cars", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  try {
    const cars = await db.select()
      .from(tripCarsTable)
      .where(eq(tripCarsTable.tripId, tripId))
      .orderBy(asc(tripCarsTable.carLabel));

    const assignments = await db.select()
      .from(tripCarAssignmentsTable)
      .where(inArray(tripCarAssignmentsTable.carId, cars.map(c => c.id)));

    const assignmentsByCar: Record<number, number[]> = {};
    for (const a of assignments) {
      if (!assignmentsByCar[a.carId]) assignmentsByCar[a.carId] = [];
      assignmentsByCar[a.carId].push(a.participantId);
    }

    res.json(cars.map(c => ({
      ...fmt(c),
      participantIds: assignmentsByCar[c.id] ?? [],
    })));
  } catch (err) {
    logger.error({ err }, "trips: list cars error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/cars
router.post("/:tripId/cars", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  const { carLabel, driverParticipantId, totalCost, notes } = req.body;
  if (!carLabel) { { res.status(400).json({ error: "carLabel is required" }); return; } }

  try {
    const [car] = await db.insert(tripCarsTable).values({
      tripId,
      carLabel,
      driverParticipantId: driverParticipantId ?? null,
      totalCost: totalCost?.toString() ?? null,
      notes: notes ?? null,
    }).returning();

    res.status(201).json({ ...fmt(car), participantIds: [] });
  } catch (err) {
    logger.error({ err }, "trips: create car error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:tripId/cars/:carId
router.patch("/:tripId/cars/:carId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const carId = parseInt(String((req.params as Record<string, string>).carId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(carId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { carLabel, driverParticipantId, totalCost, notes } = req.body;
  try {
    const updates: Partial<typeof tripCarsTable.$inferInsert> = {};
    if (carLabel !== undefined) updates.carLabel = carLabel;
    if (driverParticipantId !== undefined) updates.driverParticipantId = driverParticipantId;
    if (totalCost !== undefined) updates.totalCost = totalCost?.toString() ?? null;
    if (notes !== undefined) updates.notes = notes;

    const [car] = await db.update(tripCarsTable)
      .set(updates)
      .where(and(eq(tripCarsTable.id, carId), eq(tripCarsTable.tripId, tripId)))
      .returning();

    if (!car) { { res.status(404).json({ error: "Car not found" }); return; } }
    res.json(fmt(car));
  } catch (err) {
    logger.error({ err }, "trips: update car error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/cars/:carId
router.delete("/:tripId/cars/:carId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const carId = parseInt(String((req.params as Record<string, string>).carId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(carId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripCarsTable)
      .where(and(eq(tripCarsTable.id, carId), eq(tripCarsTable.tripId, tripId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: delete car error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/cars/:carId/assign
router.post("/:tripId/cars/:carId/assign", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const carId = parseInt(String((req.params as Record<string, string>).carId), 10);
  const participantId = parseInt(req.body.participantId, 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(carId) || isNaN(participantId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.insert(tripCarAssignmentsTable)
      .values({ carId, participantId })
      .onConflictDoNothing();
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: assign car error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/cars/:carId/assign/:pid
router.delete("/:tripId/cars/:carId/assign/:pid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const carId = parseInt(String((req.params as Record<string, string>).carId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(carId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripCarAssignmentsTable)
      .where(and(eq(tripCarAssignmentsTable.carId, carId), eq(tripCarAssignmentsTable.participantId, pid)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: remove car assignment error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   TEE SLOTS
══════════════════════════════════════════════════════════════════ */

// GET /:tripId/tee-slots
router.get("/:tripId/tee-slots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  try {
    const slots = await db.select()
      .from(tripTeeSlotsTable)
      .where(eq(tripTeeSlotsTable.tripId, tripId))
      .orderBy(asc(tripTeeSlotsTable.roundDay), asc(tripTeeSlotsTable.teeTime));

    const assignments = await db.select()
      .from(tripTeeSlotAssignmentsTable)
      .where(inArray(tripTeeSlotAssignmentsTable.slotId, slots.map(s => s.id)));

    const assignmentsBySlot: Record<number, number[]> = {};
    for (const a of assignments) {
      if (!assignmentsBySlot[a.slotId]) assignmentsBySlot[a.slotId] = [];
      assignmentsBySlot[a.slotId].push(a.participantId);
    }

    res.json(slots.map(s => ({
      ...fmt(s),
      participantIds: assignmentsBySlot[s.id] ?? [],
    })));
  } catch (err) {
    logger.error({ err }, "trips: list tee slots error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/tee-slots
router.post("/:tripId/tee-slots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  const { roundDay, teeTime, holeStart, notes } = req.body;
  if (!roundDay || !teeTime) { { res.status(400).json({ error: "roundDay and teeTime are required" }); return; } }

  try {
    const [slot] = await db.insert(tripTeeSlotsTable).values({
      tripId,
      roundDay,
      teeTime,
      holeStart: holeStart ?? 1,
      notes: notes ?? null,
    }).returning();

    res.status(201).json({ ...fmt(slot), participantIds: [] });
  } catch (err) {
    logger.error({ err }, "trips: create tee slot error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:tripId/tee-slots/:slotId
router.patch("/:tripId/tee-slots/:slotId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const slotId = parseInt(String((req.params as Record<string, string>).slotId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(slotId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { roundDay, teeTime, holeStart, notes } = req.body;
  try {
    const updates: Partial<typeof tripTeeSlotsTable.$inferInsert> = {};
    if (roundDay !== undefined) updates.roundDay = roundDay;
    if (teeTime !== undefined) updates.teeTime = teeTime;
    if (holeStart !== undefined) updates.holeStart = holeStart;
    if (notes !== undefined) updates.notes = notes;

    const [slot] = await db.update(tripTeeSlotsTable)
      .set(updates)
      .where(and(eq(tripTeeSlotsTable.id, slotId), eq(tripTeeSlotsTable.tripId, tripId)))
      .returning();

    if (!slot) { { res.status(404).json({ error: "Tee slot not found" }); return; } }
    res.json(fmt(slot));
  } catch (err) {
    logger.error({ err }, "trips: update tee slot error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/tee-slots/:slotId
router.delete("/:tripId/tee-slots/:slotId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const slotId = parseInt(String((req.params as Record<string, string>).slotId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(slotId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripTeeSlotsTable)
      .where(and(eq(tripTeeSlotsTable.id, slotId), eq(tripTeeSlotsTable.tripId, tripId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: delete tee slot error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/tee-slots/:slotId/assign
router.post("/:tripId/tee-slots/:slotId/assign", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const slotId = parseInt(String((req.params as Record<string, string>).slotId), 10);
  const participantId = parseInt(req.body.participantId, 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(slotId) || isNaN(participantId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.insert(tripTeeSlotAssignmentsTable)
      .values({ slotId, participantId })
      .onConflictDoNothing();
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: assign tee slot error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/tee-slots/:slotId/assign/:pid
router.delete("/:tripId/tee-slots/:slotId/assign/:pid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const slotId = parseInt(String((req.params as Record<string, string>).slotId), 10);
  const pid = parseInt(String((req.params as Record<string, string>).pid), 10);
  if (isNaN(orgId) || isNaN(slotId) || isNaN(pid)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripTeeSlotAssignmentsTable)
      .where(and(eq(tripTeeSlotAssignmentsTable.slotId, slotId), eq(tripTeeSlotAssignmentsTable.participantId, pid)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: remove tee slot assignment error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   EXPENSES
══════════════════════════════════════════════════════════════════ */

// GET /:tripId/expenses
router.get("/:tripId/expenses", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  try {
    const expenses = await db.select()
      .from(tripExpensesTable)
      .where(eq(tripExpensesTable.tripId, tripId))
      .orderBy(desc(tripExpensesTable.createdAt));

    const participants = await db.select({ id: tripParticipantsTable.id, firstName: tripParticipantsTable.firstName, lastName: tripParticipantsTable.lastName })
      .from(tripParticipantsTable)
      .where(eq(tripParticipantsTable.tripId, tripId));

    const participantMap: Record<number, string> = {};
    for (const p of participants) {
      participantMap[p.id] = `${p.firstName} ${p.lastName}`;
    }

    const totalByParticipant: Record<number, number> = {};
    const paidByParticipant: Record<number, number> = {};
    const totalParticipants = participants.length;

    for (const e of expenses) {
      const amount = parseFloat(e.amount);
      const splitBetween: number[] = Array.isArray(e.splitBetween) && e.splitBetween.length > 0
        ? e.splitBetween as number[]
        : participants.map(p => p.id);
      const share = splitBetween.length > 0 ? amount / splitBetween.length : 0;

      for (const pid of splitBetween) {
        totalByParticipant[pid] = (totalByParticipant[pid] ?? 0) + share;
      }
      if (e.paidBy) {
        paidByParticipant[e.paidBy] = (paidByParticipant[e.paidBy] ?? 0) + amount;
      }
    }

    const settlement = participants.map(p => ({
      participantId: p.id,
      name: participantMap[p.id],
      totalOwed: totalByParticipant[p.id] ?? 0,
      totalPaid: paidByParticipant[p.id] ?? 0,
      balance: (paidByParticipant[p.id] ?? 0) - (totalByParticipant[p.id] ?? 0),
    }));

    res.json({
      expenses: expenses.map(e => ({ ...fmt(e), paidByName: e.paidBy ? participantMap[e.paidBy] ?? null : null })),
      settlement,
    });
  } catch (err) {
    logger.error({ err }, "trips: list expenses error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:tripId/expenses
router.post("/:tripId/expenses", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!await verifyTripBelongsToOrg(tripId, orgId)) { { res.status(404).json({ error: "Trip not found" }); return; } }

  const { category, description, amount, paidBy, splitBetween, receiptUrl } = req.body;
  if (!category || !description || !amount) { { res.status(400).json({ error: "category, description, and amount are required" }); return; } }

  try {
    const [expense] = await db.insert(tripExpensesTable).values({
      tripId,
      category,
      description,
      amount: amount.toString(),
      paidBy: paidBy ?? null,
      splitBetween: splitBetween ?? [],
      receiptUrl: receiptUrl ?? null,
    }).returning();

    res.status(201).json(fmt(expense));
  } catch (err) {
    logger.error({ err }, "trips: create expense error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:tripId/expenses/:expId
router.patch("/:tripId/expenses/:expId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const expId = parseInt(String((req.params as Record<string, string>).expId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(expId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { category, description, amount, paidBy, splitBetween, receiptUrl } = req.body;
  try {
    const updates: Partial<typeof tripExpensesTable.$inferInsert> = {};
    if (category !== undefined) updates.category = category;
    if (description !== undefined) updates.description = description;
    if (amount !== undefined) updates.amount = amount.toString();
    if (paidBy !== undefined) updates.paidBy = paidBy;
    if (splitBetween !== undefined) updates.splitBetween = splitBetween;
    if (receiptUrl !== undefined) updates.receiptUrl = receiptUrl;

    const [expense] = await db.update(tripExpensesTable)
      .set(updates)
      .where(and(eq(tripExpensesTable.id, expId), eq(tripExpensesTable.tripId, tripId)))
      .returning();

    if (!expense) { { res.status(404).json({ error: "Expense not found" }); return; } }
    res.json(fmt(expense));
  } catch (err) {
    logger.error({ err }, "trips: update expense error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:tripId/expenses/:expId
router.delete("/:tripId/expenses/:expId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  const expId = parseInt(String((req.params as Record<string, string>).expId), 10);
  if (isNaN(orgId) || isNaN(tripId) || isNaN(expId)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    await db.delete(tripExpensesTable)
      .where(and(eq(tripExpensesTable.id, expId), eq(tripExpensesTable.tripId, tripId)));
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "trips: delete expense error");
    res.status(500).json({ error: "Internal server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════
   LEADERBOARD
   Aggregates scores from tournament rounds linked to participants
   who also have a userId. Looks up players across the org's
   tournaments whose dates overlap the trip dates.
══════════════════════════════════════════════════════════════════ */

// GET /:tripId/leaderboard
router.get("/:tripId/leaderboard", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId), 10);
  const tripId = parseInt(String((req.params as Record<string, string>).tripId), 10);
  if (isNaN(orgId) || isNaN(tripId)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  try {
    const [trip] = await db.select()
      .from(golfTripsTable)
      .where(and(eq(golfTripsTable.id, tripId), eq(golfTripsTable.organizationId, orgId)));
    if (!trip) { { res.status(404).json({ error: "Trip not found" }); return; } }

    const participants = await db.select()
      .from(tripParticipantsTable)
      .where(eq(tripParticipantsTable.tripId, tripId));

    const userIds = participants
      .filter(p => p.userId !== null)
      .map(p => p.userId as number);

    if (userIds.length === 0) {
      res.json({ leaderboard: [] });
      return;
    }

    const playerRows = await db.select({
      playerId: playersTable.id,
      userId: playersTable.userId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      tournamentId: playersTable.tournamentId,
    })
      .from(playersTable)
      .innerJoin(tournamentsTable, eq(tournamentsTable.id, playersTable.tournamentId))
      .where(and(
        inArray(playersTable.userId, userIds),
        eq(tournamentsTable.organizationId, orgId),
      ));

    if (playerRows.length === 0) {
      res.json({ leaderboard: [] });
      return;
    }

    const playerIds = playerRows.map(p => p.playerId);

    const scoreRows = await db.select({
      playerId: scoresTable.playerId,
      strokes: scoresTable.strokes,
      round: scoresTable.round,
    })
      .from(scoresTable)
      .where(inArray(scoresTable.playerId, playerIds));

    const statsByPlayer: Record<number, { totalStrokes: number; holesPlayed: number; rounds: Set<string> }> = {};
    for (const s of scoreRows) {
      if (!statsByPlayer[s.playerId]) {
        statsByPlayer[s.playerId] = { totalStrokes: 0, holesPlayed: 0, rounds: new Set() };
      }
      statsByPlayer[s.playerId].totalStrokes += s.strokes;
      statsByPlayer[s.playerId].holesPlayed += 1;
      statsByPlayer[s.playerId].rounds.add(`${s.round}`);
    }

    const playerMap: Record<number, typeof playerRows[0]> = {};
    for (const p of playerRows) {
      playerMap[p.playerId] = p;
    }

    const userToParticipant: Record<number, typeof participants[0]> = {};
    for (const p of participants) {
      if (p.userId) userToParticipant[p.userId] = p;
    }

    const leaderboard = participants
      .filter(p => p.userId !== null)
      .map(p => {
        const userId = p.userId as number;
        const playerRow = playerRows.find(r => r.userId === userId);
        const stats = playerRow ? (statsByPlayer[playerRow.playerId] ?? null) : null;
        return {
          participantId: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          handicapIndex: p.handicapIndex,
          totalStrokes: stats?.totalStrokes ?? null,
          holesPlayed: stats?.holesPlayed ?? 0,
          roundsPlayed: stats?.rounds.size ?? 0,
        };
      })
      .sort((a, b) => {
        if (a.totalStrokes === null && b.totalStrokes === null) return 0;
        if (a.totalStrokes === null) return 1;
        if (b.totalStrokes === null) return -1;
        return a.totalStrokes - b.totalStrokes;
      })
      .map((e, idx) => ({ ...e, position: e.totalStrokes !== null ? idx + 1 : null }));

    res.json({ leaderboard, tripName: trip.name, externalCourseName: trip.externalCourseName });
  } catch (err) {
    logger.error({ err }, "trips: leaderboard error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
