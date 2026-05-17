/**
 * Golf Cart Fleet Management API
 *
 * GET    /organizations/:orgId/carts                        List all carts
 * POST   /organizations/:orgId/carts                        Register a cart
 * PATCH  /organizations/:orgId/carts/:cartId               Update cart details / status
 * DELETE /organizations/:orgId/carts/:cartId               Retire/delete a cart
 *
 * GET    /organizations/:orgId/carts/fleet-board            Live fleet board (with active assignments)
 * GET    /organizations/:orgId/carts/utilisation            Usage report
 *
 * GET    /organizations/:orgId/carts/:cartId/assignments    Assignment history
 * POST   /organizations/:orgId/carts/:cartId/assign         Assign cart (transactional, prevents double-booking)
 * PATCH  /organizations/:orgId/carts/:cartId/return         Return cart
 *
 * GET    /organizations/:orgId/carts/:cartId/maintenance    Maintenance log
 * POST   /organizations/:orgId/carts/:cartId/maintenance    Log maintenance
 *
 * POST   /organizations/:orgId/carts/check-overdue          Trigger overdue alerts (overdue returns + service due)
 * POST   /organizations/:orgId/tee-bookings/:bookingId/assign-cart  Auto/manual assign to a booking
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  cartsTable,
  cartAssignmentsTable,
  cartMaintenanceLogsTable,
  teeBookingsTable,
  courseTeeSlotTable,
  appUsersTable,
} from "@workspace/db";
import { eq, and, isNull, lt, lte, gte, desc, sql } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { sendPushToUsers } from "../lib/push";
import { logger } from "../lib/logger";

const router: IRouter = Router({ mergeParams: true });

function getAuthUserId(req: Request): number | null {
  const userId = (req as unknown as { portalUser?: { userId?: number }; user?: { id?: number } }).portalUser?.userId
    ?? (req as unknown as { user?: { id?: number } }).user?.id;
  return userId ? Number(userId) : null;
}

/**
 * Atomically assign a cart in a DB transaction.
 * Raises an error if the cart is not available or already has an active assignment
 * (enforced by the partial unique index: cart_assignments_active_unique).
 */
async function assignCartTransactional(
  cartId: number,
  orgId: number,
  opts: {
    bookingId?: number | null;
    assignedByUserId?: number | null;
    playerName?: string | null;
    expectedReturnAt?: Date | null;
    notes?: string | null;
  }
) {
  return db.transaction(async (tx) => {
    // Lock the cart row and verify it's still available
    const [cart] = await tx
      .select()
      .from(cartsTable)
      .where(and(eq(cartsTable.id, cartId), eq(cartsTable.organizationId, orgId)))
      .for("update"); // row-level lock

    if (!cart) throw Object.assign(new Error("Cart not found"), { status: 404 });
    if (cart.status !== "available") throw Object.assign(new Error("Cart is not available"), { status: 400 });

    // Insert the assignment — the DB partial unique index prevents concurrent duplicates
    const [assignment] = await tx.insert(cartAssignmentsTable).values({
      cartId,
      organizationId: orgId,
      bookingId: opts.bookingId ?? null,
      assignedByUserId: opts.assignedByUserId ?? null,
      playerName: opts.playerName ?? null,
      expectedReturnAt: opts.expectedReturnAt ?? null,
      notes: opts.notes ?? null,
    }).returning();

    // Mark cart as in-use
    await tx.update(cartsTable).set({ status: "in_use", updatedAt: new Date() }).where(eq(cartsTable.id, cartId));

    return { cart, assignment };
  });
}

// ─── LIST CARTS ─────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/carts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const carts = await db
    .select()
    .from(cartsTable)
    .where(eq(cartsTable.organizationId, orgId))
    .orderBy(cartsTable.identifier);

  res.json(carts);
});

// ─── FLEET BOARD (live status with active assignment) ────────────────────────

router.get("/organizations/:orgId/carts/fleet-board", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const carts = await db
    .select()
    .from(cartsTable)
    .where(eq(cartsTable.organizationId, orgId))
    .orderBy(cartsTable.identifier);

  const now = new Date();
  const board = await Promise.all(carts.map(async (cart) => {
    const [activeAssignment] = await db
      .select({
        id: cartAssignmentsTable.id,
        playerName: cartAssignmentsTable.playerName,
        assignedAt: cartAssignmentsTable.assignedAt,
        expectedReturnAt: cartAssignmentsTable.expectedReturnAt,
        bookingId: cartAssignmentsTable.bookingId,
        notes: cartAssignmentsTable.notes,
      })
      .from(cartAssignmentsTable)
      .where(and(
        eq(cartAssignmentsTable.cartId, cart.id),
        isNull(cartAssignmentsTable.returnedAt),
      ))
      .orderBy(desc(cartAssignmentsTable.assignedAt))
      .limit(1);

    const isOverdue = activeAssignment?.expectedReturnAt
      ? new Date(activeAssignment.expectedReturnAt) < now
      : false;

    const isServiceDue = cart.nextServiceDue ? new Date(cart.nextServiceDue) <= now : false;

    return { ...cart, activeAssignment: activeAssignment ?? null, isOverdue, isServiceDue };
  }));

  res.json(board);
});

// ─── UTILISATION REPORT ─────────────────────────────────────────────────────

router.get("/organizations/:orgId/carts/utilisation", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const fromDate = req.query.from ? new Date(String(req.query.from)) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = req.query.to ? new Date(String(req.query.to)) : new Date();

  const carts = await db
    .select()
    .from(cartsTable)
    .where(eq(cartsTable.organizationId, orgId))
    .orderBy(cartsTable.identifier);

  const report = await Promise.all(carts.map(async (cart) => {
    const assignments = await db
      .select()
      .from(cartAssignmentsTable)
      .where(and(
        eq(cartAssignmentsTable.cartId, cart.id),
        gte(cartAssignmentsTable.assignedAt, fromDate),
        lte(cartAssignmentsTable.assignedAt, toDate),
      ));

    const totalUses = assignments.length;
    const totalHours = assignments.reduce((sum, a) => {
      if (!a.returnedAt) return sum;
      const ms = new Date(a.returnedAt).getTime() - new Date(a.assignedAt).getTime();
      return sum + ms / (1000 * 60 * 60);
    }, 0);

    const dailyMap: Record<string, number> = {};
    for (const a of assignments) {
      const day = new Date(a.assignedAt).toISOString().split('T')[0];
      dailyMap[day] = (dailyMap[day] ?? 0) + 1;
    }
    const byDay = Object.entries(dailyMap)
      .map(([date, uses]) => ({ date, uses }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { cartId: cart.id, identifier: cart.identifier, type: cart.type, status: cart.status, totalUses, totalHours: Math.round(totalHours * 10) / 10, byDay };
  }));

  report.sort((a, b) => b.totalUses - a.totalUses);
  res.json({ from: fromDate, to: toDate, carts: report });
});

// ─── REGISTER CART ──────────────────────────────────────────────────────────

router.post("/organizations/:orgId/carts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { identifier, type, status, notes, nextServiceDue } = req.body;
  if (!identifier) { { res.status(400).json({ error: "identifier is required" }); return; } }

  try {
    const [cart] = await db.insert(cartsTable).values({
      organizationId: orgId,
      identifier: String(identifier).trim(),
      type: type ?? "double",
      status: status ?? "available",
      notes: notes ?? null,
      nextServiceDue: nextServiceDue ? new Date(nextServiceDue) : null,
    }).returning();
    res.status(201).json(cart);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A cart with this identifier already exists" });
    } else {
      logger.error({ err }, "[Carts] Failed to create cart");
      res.status(500).json({ error: "Failed to create cart" });
    }
  }
});

// ─── UPDATE CART ─────────────────────────────────────────────────────────────

router.patch("/organizations/:orgId/carts/:cartId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cartId = parseInt(String((req.params as Record<string, string>).cartId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { identifier, type, status, notes, nextServiceDue } = req.body;
  const [cart] = await db
    .update(cartsTable)
    .set({
      ...(identifier !== undefined && { identifier: String(identifier).trim() }),
      ...(type !== undefined && { type }),
      ...(status !== undefined && { status }),
      ...(notes !== undefined && { notes }),
      ...(nextServiceDue !== undefined && { nextServiceDue: nextServiceDue ? new Date(nextServiceDue) : null }),
      updatedAt: new Date(),
    })
    .where(and(eq(cartsTable.id, cartId), eq(cartsTable.organizationId, orgId)))
    .returning();

  if (!cart) { { res.status(404).json({ error: "Cart not found" }); return; } }
  res.json(cart);
});

// ─── DELETE CART ──────────────────────────────────────────────────────────

router.delete("/organizations/:orgId/carts/:cartId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cartId = parseInt(String((req.params as Record<string, string>).cartId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(cartsTable).where(and(eq(cartsTable.id, cartId), eq(cartsTable.organizationId, orgId)));
  res.json({ success: true });
});

// ─── ASSIGNMENT HISTORY ──────────────────────────────────────────────────────

router.get("/organizations/:orgId/carts/:cartId/assignments", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cartId = parseInt(String((req.params as Record<string, string>).cartId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const assignments = await db
    .select()
    .from(cartAssignmentsTable)
    .where(and(eq(cartAssignmentsTable.cartId, cartId), eq(cartAssignmentsTable.organizationId, orgId)))
    .orderBy(desc(cartAssignmentsTable.assignedAt))
    .limit(50);

  res.json(assignments);
});

// ─── ASSIGN CART (transactional, prevents double-booking) ────────────────────

router.post("/organizations/:orgId/carts/:cartId/assign", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cartId = parseInt(String((req.params as Record<string, string>).cartId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const userId = getAuthUserId(req);
  const { playerName, bookingId, expectedReturnAt, notes } = req.body;

  try {
    const result = await assignCartTransactional(cartId, orgId, {
      bookingId: bookingId ?? null,
      assignedByUserId: userId,
      playerName: playerName ?? null,
      expectedReturnAt: expectedReturnAt ? new Date(expectedReturnAt) : null,
      notes: notes ?? null,
    });
    res.status(201).json(result.assignment);
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; code?: string };
    if (e.code === "23505") {
      res.status(409).json({ error: "Cart already has an active assignment" }); return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "Assignment failed" });
  }
});

// ─── RETURN CART ─────────────────────────────────────────────────────────────

router.patch("/organizations/:orgId/carts/:cartId/return", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cartId = parseInt(String((req.params as Record<string, string>).cartId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [activeAssignment] = await db
    .select()
    .from(cartAssignmentsTable)
    .where(and(
      eq(cartAssignmentsTable.cartId, cartId),
      eq(cartAssignmentsTable.organizationId, orgId),
      isNull(cartAssignmentsTable.returnedAt),
    ))
    .orderBy(desc(cartAssignmentsTable.assignedAt))
    .limit(1);

  if (!activeAssignment) { { res.status(404).json({ error: "No active assignment for this cart" }); return; } }

  const now = new Date();
  await db.update(cartAssignmentsTable).set({ returnedAt: now }).where(eq(cartAssignmentsTable.id, activeAssignment.id));

  const { status } = req.body;
  await db.update(cartsTable).set({ status: status ?? "available", updatedAt: now }).where(eq(cartsTable.id, cartId));

  res.json({ success: true, returnedAt: now });
});

// ─── MAINTENANCE LOG ─────────────────────────────────────────────────────────

router.get("/organizations/:orgId/carts/:cartId/maintenance", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cartId = parseInt(String((req.params as Record<string, string>).cartId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const logs = await db
    .select()
    .from(cartMaintenanceLogsTable)
    .where(and(eq(cartMaintenanceLogsTable.cartId, cartId), eq(cartMaintenanceLogsTable.organizationId, orgId)))
    .orderBy(desc(cartMaintenanceLogsTable.serviceDate))
    .limit(50);

  res.json(logs);
});

router.post("/organizations/:orgId/carts/:cartId/maintenance", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const cartId = parseInt(String((req.params as Record<string, string>).cartId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const userId = getAuthUserId(req);
  const { serviceDate, nextServiceDue, notes } = req.body;
  if (!serviceDate || !notes) { { res.status(400).json({ error: "serviceDate and notes are required" }); return; } }

  const [cart] = await db.select().from(cartsTable).where(and(eq(cartsTable.id, cartId), eq(cartsTable.organizationId, orgId)));
  if (!cart) { { res.status(404).json({ error: "Cart not found" }); return; } }

  const [log] = await db.insert(cartMaintenanceLogsTable).values({
    cartId,
    organizationId: orgId,
    serviceDate: new Date(serviceDate),
    nextServiceDue: nextServiceDue ? new Date(nextServiceDue) : null,
    notes,
    loggedByUserId: userId,
  }).returning();

  await db.update(cartsTable).set({
    nextServiceDue: nextServiceDue ? new Date(nextServiceDue) : cart.nextServiceDue,
    status: cart.status === "maintenance" ? "available" : cart.status,
    updatedAt: new Date(),
  }).where(eq(cartsTable.id, cartId));

  res.status(201).json(log);
});

// ─── CHECK OVERDUE + MAINTENANCE ALERTS ──────────────────────────────────────

router.post("/organizations/:orgId/carts/check-overdue", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const now = new Date();

  // ── 1. Overdue returns ────────────────────────────────────────────────────
  const overdueAssignments = await db
    .select({ assignment: cartAssignmentsTable, cartIdentifier: cartsTable.identifier })
    .from(cartAssignmentsTable)
    .innerJoin(cartsTable, eq(cartAssignmentsTable.cartId, cartsTable.id))
    .where(and(
      eq(cartAssignmentsTable.organizationId, orgId),
      isNull(cartAssignmentsTable.returnedAt),
      isNull(cartAssignmentsTable.overdueAlertSentAt),
      lt(cartAssignmentsTable.expectedReturnAt, now),
    ));

  const admins = await db
    .select({ userId: appUsersTable.id })
    .from(appUsersTable)
    .where(sql`${appUsersTable.organizationId} = ${orgId} AND ${appUsersTable.role} IN ('org_admin', 'tournament_director')`)
    .limit(20);

  const adminIds = admins.map(a => a.userId);

  let overdueAlerts = 0;
  for (const { assignment, cartIdentifier } of overdueAssignments) {
    await db.update(cartAssignmentsTable).set({ overdueAlertSentAt: now }).where(eq(cartAssignmentsTable.id, assignment.id));
    if (adminIds.length > 0) {
      // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
      // telemetry consumed downstream, classifier intentionally not used.
      sendPushToUsers(
        adminIds,
        "Cart Overdue",
        `Cart ${cartIdentifier} assigned to ${assignment.playerName ?? "unknown"} is overdue for return.`,
        { type: "cart_overdue", cartId: assignment.cartId },
      ).catch(() => {});
    }
    overdueAlerts++;
    logger.info({ cartId: assignment.cartId, orgId }, "[Carts] Overdue return alert sent");
  }

  // ── 2. Service-due alerts ─────────────────────────────────────────────────
  const serviceDueCarts = await db
    .select()
    .from(cartsTable)
    .where(and(
      eq(cartsTable.organizationId, orgId),
      lt(cartsTable.nextServiceDue, now),
      sql`${cartsTable.status} != 'retired'`,
    ));

  if (serviceDueCarts.length > 0 && adminIds.length > 0) {
    const cartList = serviceDueCarts.map(c => c.identifier).join(", ");
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendPushToUsers(
      adminIds,
      "Cart Service Due",
      `${serviceDueCarts.length} cart(s) are overdue for maintenance: ${cartList}.`,
      { type: "cart_service_due" },
    ).catch(() => {});
    logger.info({ orgId, count: serviceDueCarts.length }, "[Carts] Service-due alert sent");
  }

  res.json({
    overdueAlerts,
    serviceDueCarts: serviceDueCarts.map(c => ({ id: c.id, identifier: c.identifier, nextServiceDue: c.nextServiceDue })),
  });
});

// ─── AUTO-ASSIGN CART TO BOOKING (admin or used by booking flow) ─────────────

router.post("/organizations/:orgId/tee-bookings/:bookingId/assign-cart", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const userId = getAuthUserId(req);
  const { cartId: specifiedCartId, playerName, expectedReturnAt } = req.body;

  const [bookingRow] = await db
    .select({ booking: teeBookingsTable, slot: courseTeeSlotTable })
    .from(teeBookingsTable)
    .innerJoin(courseTeeSlotTable, eq(teeBookingsTable.slotId, courseTeeSlotTable.id))
    .where(and(eq(teeBookingsTable.id, bookingId), eq(teeBookingsTable.organizationId, orgId)));

  if (!bookingRow) { { res.status(404).json({ error: "Booking not found" }); return; } }

  let targetCartId = specifiedCartId;
  if (!targetCartId) {
    const [firstAvailable] = await db
      .select({ id: cartsTable.id })
      .from(cartsTable)
      .where(and(eq(cartsTable.organizationId, orgId), eq(cartsTable.status, "available")))
      .orderBy(cartsTable.identifier)
      .limit(1);
    if (!firstAvailable) { { res.status(400).json({ error: "No available carts" }); return; } }
    targetCartId = firstAvailable.id;
  }

  try {
    const result = await assignCartTransactional(targetCartId, orgId, {
      bookingId,
      assignedByUserId: userId,
      playerName: playerName ?? null,
      expectedReturnAt: expectedReturnAt ? new Date(expectedReturnAt) : null,
    });
    res.status(201).json({ cart: result.cart, assignment: result.assignment });
  } catch (err: unknown) {
    const e = err as { status?: number; message?: string; code?: string };
    if (e.code === "23505") {
      res.status(409).json({ error: "Cart already has an active assignment" }); return;
    }
    res.status(e.status ?? 500).json({ error: e.message ?? "Assignment failed" });
  }
});

export default router;
