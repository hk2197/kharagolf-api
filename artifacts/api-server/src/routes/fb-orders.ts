import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  fbFulfillmentStationsTable, fbMenuCategoriesTable, fbMenuItemsTable,
  fbOrdersTable, fbOrderItemsTable, orgMembershipsTable, appUsersTable,
  fbModifierGroupsTable, fbModifierOptionsTable, fbMenuItemModifierGroupsTable,
  fbServicePeriodsTable, fbMenuItemServicePeriodsTable, fbTabsTable,
  shopVariantStockTable, shopStockAdjustmentsTable, shopProductVariantsTable, shopProductsTable, shopLocationsTable,
  memberAccountChargesTable, financialLedgerTable, clubMembersTable,
} from "@workspace/db";
import { eq, and, desc, asc, inArray, sql, gte, lte } from "drizzle-orm";
import { awardPoints } from "./loyalty";
import { track } from "../lib/analytics";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser { id: number; role?: string; organizationId?: number }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  const caller = getUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if ((caller.role === "org_admin" || caller.role === "tournament_director") && Number(caller.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"])));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

async function requireOrgMember(req: Request, res: Response, orgId: number): Promise<boolean> {
  const caller = getUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if (Number(caller.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id)));
  if (!m) { res.status(403).json({ error: "Must be a member of this organization" }); return false; }
  return true;
}

// requireOrgStaff: org admin/tournament_director OR pro_shop staff may access fulfillment queue endpoints.
async function requireOrgStaff(req: Request, res: Response, orgId: number): Promise<boolean> {
  const caller = getUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if ((caller.role === "org_admin" || caller.role === "tournament_director") && Number(caller.organizationId) === orgId) return true;
  const staffRoles = ["org_admin", "tournament_director", "pro_shop"];
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, staffRoles as never[])));
  if (!m) { res.status(403).json({ error: "Staff access required" }); return false; }
  return true;
}

// ─── SSE client registry for F&B staff ───────────────────────────────────────
const fbStaffClients = new Map<number, Set<Response>>();

function addFbClient(orgId: number, res: Response) {
  if (!fbStaffClients.has(orgId)) fbStaffClients.set(orgId, new Set());
  fbStaffClients.get(orgId)!.add(res);
}
function removeFbClient(orgId: number, res: Response) {
  fbStaffClients.get(orgId)?.delete(res);
}
function broadcastFbEvent(orgId: number, event: string, data: unknown) {
  const clients = fbStaffClients.get(orgId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify({ type: event, data })}\n\n`;
  for (const c of clients) {
    try { c.write(msg); } catch { clients.delete(c); }
  }
}

// ─── Player SSE client registry ───────────────────────────────────────────────
const fbPlayerClients = new Map<number, Set<Response>>(); // orderId → clients

function addFbPlayerClient(orderId: number, res: Response) {
  if (!fbPlayerClients.has(orderId)) fbPlayerClients.set(orderId, new Set());
  fbPlayerClients.get(orderId)!.add(res);
}
function removeFbPlayerClient(orderId: number, res: Response) {
  fbPlayerClients.get(orderId)?.delete(res);
}
function broadcastFbOrderStatus(orderId: number, data: unknown) {
  const clients = fbPlayerClients.get(orderId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify({ type: "order_status", data })}\n\n`;
  for (const c of clients) {
    try { c.write(msg); } catch { clients.delete(c); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FULFILLMENT STATIONS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/stations
router.get("/stations", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const rows = await db.select().from(fbFulfillmentStationsTable)
    .where(eq(fbFulfillmentStationsTable.organizationId, orgId))
    .orderBy(asc(fbFulfillmentStationsTable.name));
  res.json(rows);
});

// POST /organizations/:orgId/fb/stations
router.post("/stations", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, description, holesServed } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  const [row] = await db.insert(fbFulfillmentStationsTable).values({
    organizationId: orgId, name, description: description ?? null,
    holesServed: holesServed ?? [],
  }).returning();
  res.status(201).json(row);
});

// PUT /organizations/:orgId/fb/stations/:stationId
router.put("/stations/:stationId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const stationId = parseInt(String((req.params as Record<string, string>).stationId));
  const { name, description, holesServed, isActive } = req.body;
  const [row] = await db.update(fbFulfillmentStationsTable)
    .set({ name, description, holesServed, isActive,
      updatedAt: new Date() })
    .where(and(eq(fbFulfillmentStationsTable.id, stationId), eq(fbFulfillmentStationsTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Station not found" }); return; } }
  res.json(row);
});

// DELETE /organizations/:orgId/fb/stations/:stationId
router.delete("/stations/:stationId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const stationId = parseInt(String((req.params as Record<string, string>).stationId));
  await db.delete(fbFulfillmentStationsTable)
    .where(and(eq(fbFulfillmentStationsTable.id, stationId), eq(fbFulfillmentStationsTable.organizationId, orgId)));
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// MENU CATEGORIES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/categories
router.get("/categories", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const rows = await db.select().from(fbMenuCategoriesTable)
    .where(eq(fbMenuCategoriesTable.organizationId, orgId))
    .orderBy(asc(fbMenuCategoriesTable.sortOrder), asc(fbMenuCategoriesTable.name));
  res.json(rows);
});

// POST /organizations/:orgId/fb/categories
router.post("/categories", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, sortOrder } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  const [row] = await db.insert(fbMenuCategoriesTable).values({
    organizationId: orgId, name, sortOrder: sortOrder ?? 0,
  }).returning();
  res.status(201).json(row);
});

// PUT /organizations/:orgId/fb/categories/:categoryId
router.put("/categories/:categoryId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const categoryId = parseInt(String((req.params as Record<string, string>).categoryId));
  const { name, sortOrder, isActive } = req.body;
  const [row] = await db.update(fbMenuCategoriesTable)
    .set({ name, sortOrder, isActive })
    .where(and(eq(fbMenuCategoriesTable.id, categoryId), eq(fbMenuCategoriesTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Category not found" }); return; } }
  res.json(row);
});

// DELETE /organizations/:orgId/fb/categories/:categoryId
router.delete("/categories/:categoryId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const categoryId = parseInt(String((req.params as Record<string, string>).categoryId));
  await db.delete(fbMenuCategoriesTable)
    .where(and(eq(fbMenuCategoriesTable.id, categoryId), eq(fbMenuCategoriesTable.organizationId, orgId)));
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// MENU ITEMS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/menu
// Query: currentOnly=1 → filter items by current service period (if any item has periods assigned)
router.get("/menu", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;

  const items = await db.select().from(fbMenuItemsTable)
    .where(eq(fbMenuItemsTable.organizationId, orgId))
    .orderBy(asc(fbMenuItemsTable.sortOrder), asc(fbMenuItemsTable.name));

  const categories = await db.select().from(fbMenuCategoriesTable)
    .where(and(eq(fbMenuCategoriesTable.organizationId, orgId), eq(fbMenuCategoriesTable.isActive, true)))
    .orderBy(asc(fbMenuCategoriesTable.sortOrder));

  // Modifier groups per item
  const itemIds = items.map(i => i.id);
  const itemModGroups = itemIds.length > 0
    ? await db.select().from(fbMenuItemModifierGroupsTable).where(inArray(fbMenuItemModifierGroupsTable.menuItemId, itemIds))
    : [];
  const itemServicePeriods = itemIds.length > 0
    ? await db.select().from(fbMenuItemServicePeriodsTable).where(inArray(fbMenuItemServicePeriodsTable.menuItemId, itemIds))
    : [];

  // Filter by current service period if requested
  let filteredItems = items;
  if (req.query.currentOnly === "1") {
    const periods = await db.select().from(fbServicePeriodsTable)
      .where(and(eq(fbServicePeriodsTable.organizationId, orgId), eq(fbServicePeriodsTable.isActive, true)));
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dow = now.getDay();
    const activePeriodIds = new Set(periods.filter(p => {
      const days = (p.daysOfWeek as number[]) ?? [0,1,2,3,4,5,6];
      return days.includes(dow) && p.startTime <= hhmm && hhmm <= p.endTime;
    }).map(p => p.id));
    const periodsByItemMap = new Map<number, number[]>();
    for (const isp of itemServicePeriods) {
      if (!periodsByItemMap.has(isp.menuItemId)) periodsByItemMap.set(isp.menuItemId, []);
      periodsByItemMap.get(isp.menuItemId)!.push(isp.servicePeriodId);
    }
    filteredItems = items.filter(it => {
      const assigned = periodsByItemMap.get(it.id);
      if (!assigned || assigned.length === 0) return true; // no restriction
      return assigned.some(pid => activePeriodIds.has(pid));
    });
  }

  const modGroupsByItem: Record<number, number[]> = {};
  for (const m of itemModGroups) {
    if (!modGroupsByItem[m.menuItemId]) modGroupsByItem[m.menuItemId] = [];
    modGroupsByItem[m.menuItemId].push(m.groupId);
  }
  const periodsByItem: Record<number, number[]> = {};
  for (const isp of itemServicePeriods) {
    if (!periodsByItem[isp.menuItemId]) periodsByItem[isp.menuItemId] = [];
    periodsByItem[isp.menuItemId].push(isp.servicePeriodId);
  }

  res.json({
    items: filteredItems.map(i => ({ ...i, modifierGroupIds: modGroupsByItem[i.id] ?? [], servicePeriodIds: periodsByItem[i.id] ?? [] })),
    categories,
  });
});

// GET /organizations/:orgId/fb/menu/:itemId/modifiers — full modifier group + option detail
router.get("/menu/:itemId/modifiers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const itemId = parseInt(String((req.params as Record<string, string>).itemId));
  const links = await db.select().from(fbMenuItemModifierGroupsTable)
    .where(eq(fbMenuItemModifierGroupsTable.menuItemId, itemId))
    .orderBy(asc(fbMenuItemModifierGroupsTable.sortOrder));
  if (links.length === 0) { { res.json([]); return; } }
  const groupIds = links.map(l => l.groupId);
  const groups = await db.select().from(fbModifierGroupsTable)
    .where(and(inArray(fbModifierGroupsTable.id, groupIds), eq(fbModifierGroupsTable.organizationId, orgId)));
  const opts = await db.select().from(fbModifierOptionsTable)
    .where(inArray(fbModifierOptionsTable.groupId, groupIds))
    .orderBy(asc(fbModifierOptionsTable.sortOrder), asc(fbModifierOptionsTable.name));
  const optsByGroup: Record<number, typeof opts> = {};
  for (const o of opts) {
    if (!optsByGroup[o.groupId]) optsByGroup[o.groupId] = [];
    optsByGroup[o.groupId].push(o);
  }
  res.json(groups.map(g => ({ ...g, options: optsByGroup[g.id] ?? [] })));
});

// Helper to upsert menu item ↔ modifier groups + service periods.
// All linked group/period IDs are validated to belong to the same org.
async function syncMenuItemRelations(
  itemId: number, orgId: number,
  modifierGroupIds?: number[], servicePeriodIds?: number[],
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (Array.isArray(modifierGroupIds)) {
    if (modifierGroupIds.length > 0) {
      const owned = await db.select({ id: fbModifierGroupsTable.id }).from(fbModifierGroupsTable)
        .where(and(inArray(fbModifierGroupsTable.id, modifierGroupIds), eq(fbModifierGroupsTable.organizationId, orgId)));
      if (owned.length !== new Set(modifierGroupIds).size) {
        return { ok: false, status: 403, error: "One or more modifierGroupIds do not belong to this organization" };
      }
    }
    await db.delete(fbMenuItemModifierGroupsTable).where(eq(fbMenuItemModifierGroupsTable.menuItemId, itemId));
    if (modifierGroupIds.length > 0) {
      await db.insert(fbMenuItemModifierGroupsTable).values(
        modifierGroupIds.map((groupId, i) => ({ menuItemId: itemId, groupId, sortOrder: i }))
      );
    }
  }
  if (Array.isArray(servicePeriodIds)) {
    if (servicePeriodIds.length > 0) {
      const owned = await db.select({ id: fbServicePeriodsTable.id }).from(fbServicePeriodsTable)
        .where(and(inArray(fbServicePeriodsTable.id, servicePeriodIds), eq(fbServicePeriodsTable.organizationId, orgId)));
      if (owned.length !== new Set(servicePeriodIds).size) {
        return { ok: false, status: 403, error: "One or more servicePeriodIds do not belong to this organization" };
      }
    }
    await db.delete(fbMenuItemServicePeriodsTable).where(eq(fbMenuItemServicePeriodsTable.menuItemId, itemId));
    if (servicePeriodIds.length > 0) {
      await db.insert(fbMenuItemServicePeriodsTable).values(
        servicePeriodIds.map(servicePeriodId => ({ menuItemId: itemId, servicePeriodId }))
      );
    }
  }
  return { ok: true };
}

// Validate that an inventory variant belongs to the same org (via product → org).
async function assertVariantInOrg(variantId: number | null | undefined, orgId: number): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (variantId == null) return { ok: true };
  const [v] = await db.select({ orgId: shopProductsTable.organizationId })
    .from(shopProductVariantsTable)
    .innerJoin(shopProductsTable, eq(shopProductsTable.id, shopProductVariantsTable.productId))
    .where(eq(shopProductVariantsTable.id, variantId));
  if (!v) return { ok: false, status: 400, error: "inventoryVariantId not found" };
  if (v.orgId !== orgId) return { ok: false, status: 403, error: "inventoryVariantId belongs to a different organization" };
  return { ok: true };
}

// POST /organizations/:orgId/fb/menu
router.post("/menu", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, description, price, currency, imageUrl, isAvailable, sortOrder, categoryId, stationId,
    inventoryVariantId, inventoryDeductQty, modifierGroupIds, servicePeriodIds } = req.body;
  if (!name || price == null) { { res.status(400).json({ error: "name and price are required" }); return; } }
  const variantCheck = await assertVariantInOrg(inventoryVariantId, orgId);
  if (!variantCheck.ok) { { res.status(variantCheck.status).json({ error: variantCheck.error }); return; } }
  const [row] = await db.insert(fbMenuItemsTable).values({
    organizationId: orgId, name, description: description ?? null, price: String(price),
    currency: currency ?? "INR", imageUrl: imageUrl ?? null, isAvailable: isAvailable !== false,
    sortOrder: sortOrder ?? 0, categoryId: categoryId ?? null, stationId: stationId ?? null,
    inventoryVariantId: inventoryVariantId ?? null,
    inventoryDeductQty: inventoryDeductQty ?? 1,
  }).returning();
  const syncRes = await syncMenuItemRelations(row.id, orgId, modifierGroupIds, servicePeriodIds);
  if (!syncRes.ok) { { res.status(syncRes.status).json({ error: syncRes.error }); return; } }
  res.status(201).json(row);
});

// PUT /organizations/:orgId/fb/menu/:itemId
router.put("/menu/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const itemId = parseInt(String((req.params as Record<string, string>).itemId));
  const { name, description, price, currency, imageUrl, isAvailable, sortOrder, categoryId, stationId,
    inventoryVariantId, inventoryDeductQty, modifierGroupIds, servicePeriodIds } = req.body;
  if (inventoryVariantId !== undefined && inventoryVariantId !== null) {
    const variantCheck = await assertVariantInOrg(inventoryVariantId, orgId);
    if (!variantCheck.ok) { { res.status(variantCheck.status).json({ error: variantCheck.error }); return; } }
  }
  const [row] = await db.update(fbMenuItemsTable)
    .set({ name, description, price: price != null ? String(price) : undefined, currency, imageUrl,
      isAvailable, sortOrder, categoryId, stationId,
      inventoryVariantId: inventoryVariantId === undefined ? undefined : (inventoryVariantId ?? null),
      inventoryDeductQty: inventoryDeductQty ?? undefined,
      updatedAt: new Date() })
    .where(and(eq(fbMenuItemsTable.id, itemId), eq(fbMenuItemsTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Menu item not found" }); return; } }
  const syncRes = await syncMenuItemRelations(itemId, orgId, modifierGroupIds, servicePeriodIds);
  if (!syncRes.ok) { { res.status(syncRes.status).json({ error: syncRes.error }); return; } }
  res.json(row);
});

// PATCH /organizations/:orgId/fb/menu/:itemId/availability
router.patch("/menu/:itemId/availability", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const itemId = parseInt(String((req.params as Record<string, string>).itemId));
  const { isAvailable } = req.body;
  if (typeof isAvailable !== "boolean") { { res.status(400).json({ error: "isAvailable must be boolean" }); return; } }
  const [row] = await db.update(fbMenuItemsTable)
    .set({ isAvailable, updatedAt: new Date() })
    .where(and(eq(fbMenuItemsTable.id, itemId), eq(fbMenuItemsTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Menu item not found" }); return; } }
  res.json(row);
});

// DELETE /organizations/:orgId/fb/menu/:itemId
router.delete("/menu/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const itemId = parseInt(String((req.params as Record<string, string>).itemId));
  await db.delete(fbMenuItemsTable)
    .where(and(eq(fbMenuItemsTable.id, itemId), eq(fbMenuItemsTable.organizationId, orgId)));
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/orders
// Query params: status, stationId, date (YYYY-MM-DD)
router.get("/orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const conditions = [eq(fbOrdersTable.organizationId, orgId)];
  if (req.query.status) {
    conditions.push(eq(fbOrdersTable.status, req.query.status as "received" | "preparing" | "ready" | "delivered" | "cancelled"));
  }
  if (req.query.stationId) {
    conditions.push(eq(fbOrdersTable.stationId, parseInt(req.query.stationId as string)));
  }
  if (req.query.date) {
    const d = new Date(req.query.date as string);
    const next = new Date(d); next.setDate(next.getDate() + 1);
    conditions.push(gte(fbOrdersTable.createdAt, d));
    conditions.push(lte(fbOrdersTable.createdAt, next));
  }

  const orders = await db.select({
    id: fbOrdersTable.id,
    organizationId: fbOrdersTable.organizationId,
    userId: fbOrdersTable.userId,
    stationId: fbOrdersTable.stationId,
    holeNumber: fbOrdersTable.holeNumber,
    status: fbOrdersTable.status,
    paymentMethod: fbOrdersTable.paymentMethod,
    totalAmount: fbOrdersTable.totalAmount,
    currency: fbOrdersTable.currency,
    notes: fbOrdersTable.notes,
    readyAt: fbOrdersTable.readyAt,
    deliveredAt: fbOrdersTable.deliveredAt,
    createdAt: fbOrdersTable.createdAt,
    updatedAt: fbOrdersTable.updatedAt,
    tabId: fbOrdersTable.tabId,
    orderType: fbOrdersTable.orderType,
    tableLabel: fbOrdersTable.tableLabel,
    serverUserId: fbOrdersTable.serverUserId,
    bumpedAt: fbOrdersTable.bumpedAt,
    recalledAt: fbOrdersTable.recalledAt,
    userName: appUsersTable.displayName,
    userEmail: appUsersTable.email,
  }).from(fbOrdersTable)
    .leftJoin(appUsersTable, eq(fbOrdersTable.userId, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(desc(fbOrdersTable.createdAt));

  const orderIds = orders.map(o => o.id);
  const items = orderIds.length > 0
    ? await db.select().from(fbOrderItemsTable).where(inArray(fbOrderItemsTable.orderId, orderIds))
    : [];

  const itemsByOrder = items.reduce<Record<number, typeof items>>((acc, item) => {
    if (!acc[item.orderId]) acc[item.orderId] = [];
    acc[item.orderId].push(item);
    return acc;
  }, {});

  res.json(orders.map(o => ({ ...o, items: itemsByOrder[o.id] ?? [] })));
});

// GET /organizations/:orgId/fb/orders/mine — player's own orders
router.get("/orders/mine", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const caller = getUser(req)!;

  const orders = await db.select().from(fbOrdersTable)
    .where(and(eq(fbOrdersTable.organizationId, orgId), eq(fbOrdersTable.userId, caller.id)))
    .orderBy(desc(fbOrdersTable.createdAt))
    .limit(20);

  const orderIds = orders.map(o => o.id);
  const items = orderIds.length > 0
    ? await db.select().from(fbOrderItemsTable).where(inArray(fbOrderItemsTable.orderId, orderIds))
    : [];
  const itemsByOrder = items.reduce<Record<number, typeof items>>((acc, item) => {
    if (!acc[item.orderId]) acc[item.orderId] = [];
    acc[item.orderId].push(item);
    return acc;
  }, {});

  res.json(orders.map(o => ({ ...o, items: itemsByOrder[o.id] ?? [] })));
});

// GET /organizations/:orgId/fb/orders/:orderId/mine — player's single order detail
// Member-facing endpoint that surfaces a single F&B order with its line items
// only when the caller placed it (userId match). Returns 404 if the order
// belongs to someone else, so we don't leak the existence of other members'
// orders. Used by the web /fb-orders/:orderId detail page (Task #1728).
router.get("/orders/:orderId/mine", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const caller = getUser(req)!;

  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  if (!Number.isFinite(orderId)) { { res.status(400).json({ error: "Invalid orderId" }); return; } }

  const [order] = await db.select().from(fbOrdersTable)
    .where(and(
      eq(fbOrdersTable.id, orderId),
      eq(fbOrdersTable.organizationId, orgId),
      eq(fbOrdersTable.userId, caller.id),
    ));

  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }

  const items = await db.select().from(fbOrderItemsTable)
    .where(eq(fbOrderItemsTable.orderId, order.id));

  res.json({ ...order, items });
});

interface OrderLineInput {
  menuItemId: number;
  quantity?: number;
  notes?: string;
  modifiers?: Array<{ groupId?: number; optionId?: number; name?: string; priceDelta?: number | string }>;
}

// Internal: deduct inventory for items linked to a shop variant.
// Picks the location with the highest available quantity for the org.
async function deductInventoryForOrder(
  orgId: number,
  orderId: number,
  resolvedLines: Array<{ menuItem: typeof fbMenuItemsTable.$inferSelect; quantity: number }>,
  staffUserId: number | null,
) {
  for (const line of resolvedLines) {
    const variantId = line.menuItem.inventoryVariantId;
    if (!variantId) continue;
    const deductPerUnit = line.menuItem.inventoryDeductQty ?? 1;
    const totalDeduct = deductPerUnit * line.quantity;
    if (totalDeduct <= 0) continue;
    const stockRows = await db.select({
        id: shopVariantStockTable.id,
        quantity: shopVariantStockTable.quantity,
        locationId: shopVariantStockTable.locationId,
      }).from(shopVariantStockTable)
      .innerJoin(shopLocationsTable, eq(shopLocationsTable.id, shopVariantStockTable.locationId))
      .where(and(
        eq(shopVariantStockTable.variantId, variantId),
        eq(shopLocationsTable.organizationId, orgId),
      ))
      .orderBy(desc(shopVariantStockTable.quantity));
    if (stockRows.length === 0) continue;
    const target = stockRows[0];
    await db.update(shopVariantStockTable)
      .set({ quantity: Math.max(0, target.quantity - totalDeduct), updatedAt: new Date() })
      .where(eq(shopVariantStockTable.id, target.id));
    await db.insert(shopStockAdjustmentsTable).values({
      organizationId: orgId,
      variantId,
      locationId: target.locationId,
      qtyDelta: -totalDeduct,
      type: "fb_consumption",
      reason: `F&B order #${orderId}: ${line.quantity}× ${line.menuItem.name}`,
      referenceId: `fb_order:${orderId}`,
      createdByUserId: staffUserId,
    });
  }
}

// POST /organizations/:orgId/fb/orders — place order (counter / table / on_course)
router.post("/orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const caller = getUser(req)!;

  const {
    holeNumber, paymentMethod, notes, items,
    orderType, tabId, tableLabel, serverUserId,
  } = req.body as {
    holeNumber?: number; paymentMethod?: string; notes?: string;
    items: OrderLineInput[];
    orderType?: "counter" | "table" | "on_course";
    tabId?: number; tableLabel?: string; serverUserId?: number;
  };

  const validPaymentMethods = ["account_charge", "card_on_delivery"];
  if (paymentMethod && !validPaymentMethods.includes(paymentMethod)) {
    res.status(400).json({ error: `paymentMethod must be one of: ${validPaymentMethods.join(", ")}` }); return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items must be a non-empty array" }); return;
  }

  // If a tab is supplied, this is a table order regardless of client orderType.
  const resolvedOrderType: "counter" | "table" | "on_course" = tabId
    ? "table"
    : (orderType ?? (holeNumber ? "on_course" : "counter"));
  if (tabId && orderType && orderType !== "table") {
    res.status(400).json({ error: "tabId requires orderType 'table'" }); return;
  }

  // Counter/table orders (anything tab-bound) require staff role.
  if ((resolvedOrderType === "counter" || resolvedOrderType === "table" || tabId) &&
      !await requireOrgStaff(req, res, orgId)) return;

  // Validate items
  const menuItemIds = items.map(i => i.menuItemId);
  const menuItems = await db.select().from(fbMenuItemsTable)
    .where(and(inArray(fbMenuItemsTable.id, menuItemIds), eq(fbMenuItemsTable.organizationId, orgId)));
  const menuMap = new Map(menuItems.map(m => [m.id, m]));

  // Determine station from first item's station mapping
  let stationId: number | null = null;
  for (const item of items) {
    const mi = menuMap.get(item.menuItemId);
    if (mi?.stationId) { stationId = mi.stationId; break; }
  }
  if (holeNumber && !stationId) {
    const stations = await db.select().from(fbFulfillmentStationsTable)
      .where(and(eq(fbFulfillmentStationsTable.organizationId, orgId), eq(fbFulfillmentStationsTable.isActive, true)));
    for (const s of stations) {
      if (Array.isArray(s.holesServed) && (s.holesServed as number[]).includes(Number(holeNumber))) {
        stationId = s.id; break;
      }
    }
    if (!stationId && stations.length > 0) stationId = stations[0].id;
  }

  // Build order lines with modifiers
  let totalAmount = 0;
  const resolvedLines: Array<{
    menuItem: typeof fbMenuItemsTable.$inferSelect; quantity: number;
    modifiers: Array<{ groupId?: number; groupName?: string; optionId?: number; name: string; priceDelta: string }>;
    modifierTotal: number; itemNotes: string | null;
  }> = [];

  // Resolve modifier options strictly from DB, scoped to org via group ownership.
  // Reject any modifier without a valid optionId or whose option's group is not
  // linked to the chosen menu item.
  const allOptionIds = Array.from(new Set(
    items.flatMap(i => (i.modifiers ?? []).map(m => m.optionId)).filter((x): x is number => typeof x === "number")
  ));
  const optionRows = allOptionIds.length > 0
    ? await db.select({
        id: fbModifierOptionsTable.id,
        name: fbModifierOptionsTable.name,
        priceDelta: fbModifierOptionsTable.priceDelta,
        isAvailable: fbModifierOptionsTable.isAvailable,
        groupId: fbModifierOptionsTable.groupId,
        groupOrgId: fbModifierGroupsTable.organizationId,
      }).from(fbModifierOptionsTable)
        .innerJoin(fbModifierGroupsTable, eq(fbModifierGroupsTable.id, fbModifierOptionsTable.groupId))
        .where(and(
          inArray(fbModifierOptionsTable.id, allOptionIds),
          eq(fbModifierGroupsTable.organizationId, orgId),
        ))
    : [];
  const optionsMap = new Map(optionRows.map(o => [o.id, o]));

  // Per-menu-item allowed group IDs
  const allowedGroupsByItem = new Map<number, Set<number>>();
  if (menuItemIds.length > 0) {
    const links = await db.select().from(fbMenuItemModifierGroupsTable)
      .where(inArray(fbMenuItemModifierGroupsTable.menuItemId, menuItemIds));
    for (const l of links) {
      let s = allowedGroupsByItem.get(l.menuItemId);
      if (!s) { s = new Set(); allowedGroupsByItem.set(l.menuItemId, s); }
      s.add(l.groupId);
    }
  }

  for (const item of items) {
    const mi = menuMap.get(item.menuItemId);
    if (!mi) { { res.status(400).json({ error: `Menu item ${item.menuItemId} not found` }); return; } }
    if (!mi.isAvailable) { { res.status(400).json({ error: `${mi.name} is not currently available (86'd)` }); return; } }
    const qty = Math.max(1, item.quantity ?? 1);
    const allowedGroups = allowedGroupsByItem.get(mi.id) ?? new Set<number>();
    let modTotal = 0;
    const resolvedMods: Array<{ groupId: number; optionId: number; name: string; priceDelta: string }> = [];
    for (const m of item.modifiers ?? []) {
      if (typeof m.optionId !== "number") {
        res.status(400).json({ error: `Modifier on '${mi.name}' is missing optionId` }); return;
      }
      const opt = optionsMap.get(m.optionId);
      if (!opt) {
        res.status(400).json({ error: `Modifier option ${m.optionId} not found for this organization` }); return;
      }
      if (!opt.isAvailable) {
        res.status(400).json({ error: `Modifier option '${opt.name}' is not available` }); return;
      }
      if (!allowedGroups.has(opt.groupId)) {
        res.status(400).json({ error: `Modifier option '${opt.name}' is not permitted for '${mi.name}'` }); return;
      }
      modTotal += parseFloat(opt.priceDelta);
      resolvedMods.push({ groupId: opt.groupId, optionId: opt.id, name: opt.name, priceDelta: opt.priceDelta });
    }
    totalAmount += (parseFloat(mi.price) + modTotal) * qty;
    resolvedLines.push({ menuItem: mi, quantity: qty, modifiers: resolvedMods, modifierTotal: modTotal, itemNotes: item.notes ?? null });
  }

  // Validate tab if provided
  let resolvedTableLabel: string | null = tableLabel ?? null;
  let tabRow: typeof fbTabsTable.$inferSelect | null = null;
  if (tabId) {
    const [t] = await db.select().from(fbTabsTable)
      .where(and(eq(fbTabsTable.id, tabId), eq(fbTabsTable.organizationId, orgId)));
    if (!t) { { res.status(404).json({ error: "Tab not found" }); return; } }
    if (t.status !== "open") { { res.status(400).json({ error: "Tab is not open" }); return; } }
    tabRow = t;
    resolvedTableLabel = t.tableLabel;
  }

  // Server attribution
  const finalServerUserId: number | null = serverUserId ?? tabRow?.serverUserId
    ?? ((resolvedOrderType === "counter" || resolvedOrderType === "table") ? caller.id : null);

  const selectedPaymentMethod: "account_charge" | "card_on_delivery" = (paymentMethod as "account_charge" | "card_on_delivery") ?? "card_on_delivery";
  const initialPaymentStatus = resolvedOrderType === "table"
    ? "open_tab"
    : selectedPaymentMethod === "account_charge" ? "pending_settlement" : "pending_cod";
  const paymentRef = selectedPaymentMethod === "account_charge"
    ? `ACCT-${orgId}-USR-${caller.id}-${Date.now()}` : null;

  const [order] = await db.insert(fbOrdersTable).values({
    organizationId: orgId,
    userId: resolvedOrderType === "on_course" ? caller.id : null,
    stationId,
    tabId: tabRow?.id ?? null,
    serverUserId: finalServerUserId,
    orderType: resolvedOrderType,
    tableLabel: resolvedTableLabel,
    holeNumber: holeNumber ?? null,
    status: "received",
    paymentMethod: selectedPaymentMethod,
    paymentStatus: initialPaymentStatus,
    paymentReference: paymentRef,
    totalAmount: String(totalAmount.toFixed(2)),
    currency: menuItems[0]?.currency ?? "INR",
    notes: notes ?? null,
  }).returning();

  const insertedItems = await db.insert(fbOrderItemsTable).values(
    resolvedLines.map(l => ({
      orderId: order.id,
      menuItemId: l.menuItem.id,
      name: l.menuItem.name,
      price: l.menuItem.price,
      quantity: l.quantity,
      modifiers: l.modifiers,
      modifierTotal: String(l.modifierTotal.toFixed(2)),
      itemNotes: l.itemNotes,
    }))
  ).returning();

  // Inventory deduction (best-effort; never fails the order)
  deductInventoryForOrder(
    orgId, order.id,
    resolvedLines.map(l => ({ menuItem: l.menuItem, quantity: l.quantity })),
    finalServerUserId,
  ).catch(err => console.error("F&B inventory deduction failed:", err));

  if (tabRow) {
    await db.update(fbTabsTable).set({ updatedAt: new Date() }).where(eq(fbTabsTable.id, tabRow.id));
  }

  const fullOrder = { ...order, items: insertedItems };
  broadcastFbEvent(orgId, "new_order", fullOrder);

  void track("fb_order_placed", {
    orderId: order.id,
    orderType: resolvedOrderType,
    stationId,
    holeNumber: holeNumber ?? null,
    tabId: tabRow?.id ?? null,
    itemCount: insertedItems.length,
    totalAmount,
    currency: order.currency,
    paymentMethod: selectedPaymentMethod,
  }, { organizationId: orgId, userId: caller.id });

  res.status(201).json(fullOrder);
});

// PATCH /organizations/:orgId/fb/orders/:orderId/status — update order status
router.patch("/orders/:orderId/status", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  const { status } = req.body;
  const validStatuses = ["received", "preparing", "ready", "delivered", "cancelled"];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` }); return;
  }

  // Fetch current order to determine payment method for status-driven payment transitions
  const [currentOrder] = await db.select({ paymentMethod: fbOrdersTable.paymentMethod, paymentStatus: fbOrdersTable.paymentStatus })
    .from(fbOrdersTable).where(and(eq(fbOrdersTable.id, orderId), eq(fbOrdersTable.organizationId, orgId)));
  if (!currentOrder) { { res.status(404).json({ error: "Order not found" }); return; } }

  const extra: { readyAt?: Date; deliveredAt?: Date; paymentStatus?: string } = {};
  if (status === "ready") extra.readyAt = new Date();
  if (status === "delivered") {
    extra.deliveredAt = new Date();
    // For card_on_delivery: staff collects payment at delivery → mark as collected.
    // For account_charge: settlement happens separately → keep as pending_settlement.
    if (currentOrder.paymentMethod === "card_on_delivery" && currentOrder.paymentStatus === "pending_cod") {
      extra.paymentStatus = "collected";
    }
  }
  if (status === "cancelled") {
    extra.paymentStatus = "voided";
  }

  const [order] = await db.update(fbOrdersTable)
    .set({ status, ...extra, updatedAt: new Date() })
    .where(and(eq(fbOrdersTable.id, orderId), eq(fbOrdersTable.organizationId, orgId)))
    .returning();

  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }

  // Award loyalty points when order is delivered
  if (status === "delivered" && order.userId) {
    const totalAmt = parseFloat(String(order.totalAmount ?? "0"));
    if (totalAmt > 0) {
      awardPoints({
        organizationId: orgId,
        userId: order.userId,
        amountSpent: totalAmt,
        category: "fb",
        referenceId: `fb:${orderId}`,
        description: `F&B order #${orderId}`,
      }).catch(() => {});
    }
  }

  // Notify player & staff
  broadcastFbOrderStatus(orderId, { orderId, status });
  broadcastFbEvent(orgId, "order_status", { orderId, status });

  res.json(order);
});

// ─── SSE: Staff order queue ───────────────────────────────────────────────────
// GET /organizations/:orgId/fb/sse/orders
router.get("/sse/orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  addFbClient(orgId, res);
  const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); } }, 30000);
  req.on("close", () => { clearInterval(heartbeat); removeFbClient(orgId, res); });
});

// ─── SSE: Player order tracking ───────────────────────────────────────────────
// GET /organizations/:orgId/fb/orders/:orderId/sse
router.get("/orders/:orderId/sse", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const caller = getUser(req);
  if (!caller) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  const [order] = await db.select().from(fbOrdersTable)
    .where(and(eq(fbOrdersTable.id, orderId), eq(fbOrdersTable.organizationId, orgId)));
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }
  // Only the order owner or an org admin/super_admin may subscribe to order status updates.
  const isOrderOwner = order.userId === caller.id;
  const isOrgAdminCaller = caller.role === "super_admin" ||
    ((caller.role === "org_admin" || caller.role === "tournament_director") && Number(caller.organizationId) === orgId);
  if (!isOrderOwner && !isOrgAdminCaller) {
    res.status(403).json({ error: "Access denied" }); return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(`data: ${JSON.stringify({ type: "order_status", data: { orderId, status: order.status } })}\n\n`);

  addFbPlayerClient(orderId, res);
  const heartbeat = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); } }, 30000);
  req.on("close", () => { clearInterval(heartbeat); removeFbPlayerClient(orderId, res); });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REVENUE REPORTING
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/reports/revenue
// Query: startDate, endDate (YYYY-MM-DD)
router.get("/reports/revenue", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // startDate is inclusive (start of day), endDate is exclusive (start of next day).
  // Callers pass YYYY-MM-DD strings; we parse as UTC midnight and add 1 day for the end boundary.
  const parseDate = (s: string): Date => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? new Date() : d;
  };
  const startDate = req.query.startDate ? parseDate(req.query.startDate as string) : (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 30); d.setUTCHours(0, 0, 0, 0); return d; })();
  const endDate = req.query.endDate ? (() => { const d = parseDate(req.query.endDate as string); d.setUTCDate(d.getUTCDate() + 1); return d; })() : (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0, 0, 0, 0); return d; })();

  const orders = await db.select({
    id: fbOrdersTable.id,
    totalAmount: fbOrdersTable.totalAmount,
    status: fbOrdersTable.status,
    createdAt: fbOrdersTable.createdAt,
  }).from(fbOrdersTable)
    .where(and(
      eq(fbOrdersTable.organizationId, orgId),
      gte(fbOrdersTable.createdAt, startDate),
      lte(fbOrdersTable.createdAt, endDate),
    ));

  const completedOrders = orders.filter(o => o.status !== "cancelled");
  const totalRevenue = completedOrders.reduce((s, o) => s + parseFloat(o.totalAmount), 0);
  const totalOrders = completedOrders.length;
  const cancelledOrders = orders.filter(o => o.status === "cancelled").length;

  const dailyRevenue: Record<string, number> = {};
  for (const o of completedOrders) {
    const day = o.createdAt.toISOString().split("T")[0];
    dailyRevenue[day] = (dailyRevenue[day] ?? 0) + parseFloat(o.totalAmount);
  }

  // Item breakdown
  const orderIds = completedOrders.map(o => o.id);
  const allItems = orderIds.length > 0
    ? await db.select().from(fbOrderItemsTable).where(inArray(fbOrderItemsTable.orderId, orderIds))
    : [];

  const itemRevenue: Record<string, { name: string; quantity: number; revenue: number }> = {};
  for (const item of allItems) {
    const key = item.name;
    if (!itemRevenue[key]) itemRevenue[key] = { name: item.name, quantity: 0, revenue: 0 };
    itemRevenue[key].quantity += item.quantity;
    itemRevenue[key].revenue += parseFloat(item.price) * item.quantity;
  }

  const topItems = Object.values(itemRevenue).sort((a, b) => b.revenue - a.revenue);

  // Category breakdown
  const menuItemsForOrg = allItems.length > 0
    ? await db.select({ id: fbMenuItemsTable.id, categoryId: fbMenuItemsTable.categoryId })
        .from(fbMenuItemsTable).where(eq(fbMenuItemsTable.organizationId, orgId))
    : [];
  const categoriesForOrg = await db.select().from(fbMenuCategoriesTable)
    .where(eq(fbMenuCategoriesTable.organizationId, orgId));

  const categoryMap = new Map(categoriesForOrg.map(c => [c.id, c.name]));
  const menuCatMap = new Map(menuItemsForOrg.map(m => [m.id, m.categoryId]));

  const categoryRevenue: Record<string, { name: string; revenue: number; quantity: number }> = {};
  for (const item of allItems) {
    const catId = item.menuItemId ? menuCatMap.get(item.menuItemId) : null;
    const catName = catId ? (categoryMap.get(catId) ?? "Uncategorized") : "Uncategorized";
    if (!categoryRevenue[catName]) categoryRevenue[catName] = { name: catName, revenue: 0, quantity: 0 };
    categoryRevenue[catName].revenue += parseFloat(item.price) * item.quantity;
    categoryRevenue[catName].quantity += item.quantity;
  }

  res.json({
    totalRevenue: totalRevenue.toFixed(2),
    totalOrders,
    cancelledOrders,
    avgOrderValue: totalOrders > 0 ? (totalRevenue / totalOrders).toFixed(2) : "0.00",
    dailyRevenue: Object.entries(dailyRevenue).map(([date, revenue]) => ({ date, revenue: revenue.toFixed(2) })).sort((a, b) => a.date.localeCompare(b.date)),
    topItems,
    categoryRevenue: Object.values(categoryRevenue).sort((a, b) => b.revenue - a.revenue),
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUMP / RECALL (KDS)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /organizations/:orgId/fb/orders/:orderId/bump — KDS bump (cleared from screen)
router.post("/orders/:orderId/bump", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  const [order] = await db.update(fbOrdersTable)
    .set({ bumpedAt: new Date(), recalledAt: null, updatedAt: new Date() })
    .where(and(eq(fbOrdersTable.id, orderId), eq(fbOrdersTable.organizationId, orgId)))
    .returning();
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }
  broadcastFbEvent(orgId, "order_bumped", { orderId });
  res.json(order);
});

// POST /organizations/:orgId/fb/orders/:orderId/recall — undo a bump
router.post("/orders/:orderId/recall", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  const [order] = await db.update(fbOrdersTable)
    .set({ bumpedAt: null, recalledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(fbOrdersTable.id, orderId), eq(fbOrdersTable.organizationId, orgId)))
    .returning();
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }
  broadcastFbEvent(orgId, "order_recalled", { orderId });
  res.json(order);
});

// ═══════════════════════════════════════════════════════════════════════════════
// MODIFIER GROUPS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/modifier-groups
router.get("/modifier-groups", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const groups = await db.select().from(fbModifierGroupsTable)
    .where(eq(fbModifierGroupsTable.organizationId, orgId))
    .orderBy(asc(fbModifierGroupsTable.sortOrder), asc(fbModifierGroupsTable.name));
  const groupIds = groups.map(g => g.id);
  const opts = groupIds.length > 0
    ? await db.select().from(fbModifierOptionsTable).where(inArray(fbModifierOptionsTable.groupId, groupIds))
        .orderBy(asc(fbModifierOptionsTable.sortOrder), asc(fbModifierOptionsTable.name))
    : [];
  const optsByGroup: Record<number, typeof opts> = {};
  for (const o of opts) (optsByGroup[o.groupId] ??= []).push(o);
  res.json(groups.map(g => ({ ...g, options: optsByGroup[g.id] ?? [] })));
});

// POST /organizations/:orgId/fb/modifier-groups
router.post("/modifier-groups", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, description, selectionType, isRequired, minSelections, maxSelections, sortOrder } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  const [row] = await db.insert(fbModifierGroupsTable).values({
    organizationId: orgId, name, description: description ?? null,
    selectionType: selectionType ?? "single",
    isRequired: !!isRequired,
    minSelections: minSelections ?? 0,
    maxSelections: maxSelections ?? null,
    sortOrder: sortOrder ?? 0,
  }).returning();
  res.status(201).json(row);
});

// PUT /organizations/:orgId/fb/modifier-groups/:groupId
router.put("/modifier-groups/:groupId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const groupId = parseInt(String((req.params as Record<string, string>).groupId));
  const { name, description, selectionType, isRequired, minSelections, maxSelections, sortOrder } = req.body;
  const [row] = await db.update(fbModifierGroupsTable)
    .set({ name, description, selectionType, isRequired, minSelections, maxSelections, sortOrder, updatedAt: new Date() })
    .where(and(eq(fbModifierGroupsTable.id, groupId), eq(fbModifierGroupsTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Modifier group not found" }); return; } }
  res.json(row);
});

// DELETE /organizations/:orgId/fb/modifier-groups/:groupId
router.delete("/modifier-groups/:groupId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const groupId = parseInt(String((req.params as Record<string, string>).groupId));
  await db.delete(fbModifierGroupsTable)
    .where(and(eq(fbModifierGroupsTable.id, groupId), eq(fbModifierGroupsTable.organizationId, orgId)));
  res.status(204).end();
});

// POST /organizations/:orgId/fb/modifier-groups/:groupId/options
router.post("/modifier-groups/:groupId/options", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const groupId = parseInt(String((req.params as Record<string, string>).groupId));
  const [grp] = await db.select().from(fbModifierGroupsTable)
    .where(and(eq(fbModifierGroupsTable.id, groupId), eq(fbModifierGroupsTable.organizationId, orgId)));
  if (!grp) { { res.status(404).json({ error: "Modifier group not found" }); return; } }
  const { name, priceDelta, isAvailable, isDefault, sortOrder } = req.body;
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }
  const [row] = await db.insert(fbModifierOptionsTable).values({
    groupId, name, priceDelta: String(priceDelta ?? 0),
    isAvailable: isAvailable !== false, isDefault: !!isDefault,
    sortOrder: sortOrder ?? 0,
  }).returning();
  res.status(201).json(row);
});

// PUT /organizations/:orgId/fb/modifier-options/:optionId
router.put("/modifier-options/:optionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const optionId = parseInt(String((req.params as Record<string, string>).optionId));
  const [opt] = await db.select({ id: fbModifierOptionsTable.id, groupId: fbModifierOptionsTable.groupId })
    .from(fbModifierOptionsTable)
    .innerJoin(fbModifierGroupsTable, eq(fbModifierGroupsTable.id, fbModifierOptionsTable.groupId))
    .where(and(eq(fbModifierOptionsTable.id, optionId), eq(fbModifierGroupsTable.organizationId, orgId)));
  if (!opt) { { res.status(404).json({ error: "Option not found" }); return; } }
  const { name, priceDelta, isAvailable, isDefault, sortOrder } = req.body;
  const [row] = await db.update(fbModifierOptionsTable)
    .set({ name, priceDelta: priceDelta != null ? String(priceDelta) : undefined,
      isAvailable, isDefault, sortOrder })
    .where(eq(fbModifierOptionsTable.id, optionId))
    .returning();
  res.json(row);
});

// DELETE /organizations/:orgId/fb/modifier-options/:optionId
router.delete("/modifier-options/:optionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const optionId = parseInt(String((req.params as Record<string, string>).optionId));
  const [opt] = await db.select({ id: fbModifierOptionsTable.id })
    .from(fbModifierOptionsTable)
    .innerJoin(fbModifierGroupsTable, eq(fbModifierGroupsTable.id, fbModifierOptionsTable.groupId))
    .where(and(eq(fbModifierOptionsTable.id, optionId), eq(fbModifierGroupsTable.organizationId, orgId)));
  if (!opt) { { res.status(404).json({ error: "Option not found" }); return; } }
  await db.delete(fbModifierOptionsTable).where(eq(fbModifierOptionsTable.id, optionId));
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE PERIODS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/service-periods
router.get("/service-periods", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgMember(req, res, orgId)) return;
  const rows = await db.select().from(fbServicePeriodsTable)
    .where(eq(fbServicePeriodsTable.organizationId, orgId))
    .orderBy(asc(fbServicePeriodsTable.startTime));
  res.json(rows);
});

// POST /organizations/:orgId/fb/service-periods
router.post("/service-periods", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { name, startTime, endTime, daysOfWeek, isActive } = req.body;
  if (!name || !startTime || !endTime) {
    res.status(400).json({ error: "name, startTime, endTime are required" }); return;
  }
  const [row] = await db.insert(fbServicePeriodsTable).values({
    organizationId: orgId, name, startTime, endTime,
    daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : [0,1,2,3,4,5,6],
    isActive: isActive !== false,
  }).returning();
  res.status(201).json(row);
});

// PUT /organizations/:orgId/fb/service-periods/:periodId
router.put("/service-periods/:periodId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const periodId = parseInt(String((req.params as Record<string, string>).periodId));
  const { name, startTime, endTime, daysOfWeek, isActive } = req.body;
  const [row] = await db.update(fbServicePeriodsTable)
    .set({ name, startTime, endTime, daysOfWeek, isActive })
    .where(and(eq(fbServicePeriodsTable.id, periodId), eq(fbServicePeriodsTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Service period not found" }); return; } }
  res.json(row);
});

// DELETE /organizations/:orgId/fb/service-periods/:periodId
router.delete("/service-periods/:periodId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const periodId = parseInt(String((req.params as Record<string, string>).periodId));
  await db.delete(fbServicePeriodsTable)
    .where(and(eq(fbServicePeriodsTable.id, periodId), eq(fbServicePeriodsTable.organizationId, orgId)));
  res.status(204).end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// TABS (table service)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/tabs?status=open
router.get("/tabs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const conditions = [eq(fbTabsTable.organizationId, orgId)];
  if (req.query.status === "open" || req.query.status === "closed" || req.query.status === "voided") {
    conditions.push(eq(fbTabsTable.status, req.query.status));
  }
  const tabs = await db.select({
    id: fbTabsTable.id,
    tableLabel: fbTabsTable.tableLabel,
    guestName: fbTabsTable.guestName,
    partySize: fbTabsTable.partySize,
    status: fbTabsTable.status,
    serverUserId: fbTabsTable.serverUserId,
    serverName: appUsersTable.displayName,
    clubMemberId: fbTabsTable.clubMemberId,
    notes: fbTabsTable.notes,
    closedAt: fbTabsTable.closedAt,
    closedPaymentMethod: fbTabsTable.closedPaymentMethod,
    closedTotal: fbTabsTable.closedTotal,
    createdAt: fbTabsTable.createdAt,
    openedAt: fbTabsTable.createdAt,
    updatedAt: fbTabsTable.updatedAt,
  }).from(fbTabsTable)
    .leftJoin(appUsersTable, eq(fbTabsTable.serverUserId, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(desc(fbTabsTable.updatedAt))
    .limit(200);

  // Compute running total per open tab
  const tabIds = tabs.map(t => t.id);
  const orderRows = tabIds.length > 0
    ? await db.select({
        tabId: fbOrdersTable.tabId,
        totalAmount: fbOrdersTable.totalAmount,
        status: fbOrdersTable.status,
        id: fbOrdersTable.id,
      }).from(fbOrdersTable).where(inArray(fbOrdersTable.tabId, tabIds))
    : [];
  const totalsByTab: Record<number, { running: number; orderCount: number }> = {};
  for (const o of orderRows) {
    if (!o.tabId) continue;
    if (!totalsByTab[o.tabId]) totalsByTab[o.tabId] = { running: 0, orderCount: 0 };
    if (o.status !== "cancelled") {
      totalsByTab[o.tabId].running += parseFloat(o.totalAmount);
      totalsByTab[o.tabId].orderCount += 1;
    }
  }
  res.json(tabs.map(t => ({ ...t, runningTotal: (totalsByTab[t.id]?.running ?? 0).toFixed(2), orderCount: totalsByTab[t.id]?.orderCount ?? 0 })));
});

// GET /organizations/:orgId/fb/tabs/:tabId — full detail incl. orders & items
router.get("/tabs/:tabId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const tabId = parseInt(String((req.params as Record<string, string>).tabId));
  const [tab] = await db.select().from(fbTabsTable)
    .where(and(eq(fbTabsTable.id, tabId), eq(fbTabsTable.organizationId, orgId)));
  if (!tab) { { res.status(404).json({ error: "Tab not found" }); return; } }

  const orders = await db.select().from(fbOrdersTable)
    .where(eq(fbOrdersTable.tabId, tabId))
    .orderBy(asc(fbOrdersTable.createdAt));
  const orderIds = orders.map(o => o.id);
  const items = orderIds.length > 0
    ? await db.select().from(fbOrderItemsTable).where(inArray(fbOrderItemsTable.orderId, orderIds))
    : [];
  const itemsByOrder: Record<number, typeof items> = {};
  for (const it of items) (itemsByOrder[it.orderId] ??= []).push(it);

  let runningTotal = 0;
  const ordersWithItems = orders.map(o => {
    const oi = itemsByOrder[o.id] ?? [];
    if (o.status !== "cancelled") runningTotal += parseFloat(o.totalAmount);
    return { ...o, items: oi };
  });
  const totalStr = runningTotal.toFixed(2);
  res.json({ ...tab, orders: ordersWithItems, runningTotal: totalStr, subtotal: totalStr, openedAt: tab.createdAt });
});

// POST /organizations/:orgId/fb/tabs — open a new tab
router.post("/tabs", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const caller = getUser(req)!;
  const { tableLabel, guestName, partySize, clubMemberId, notes, serverUserId } = req.body;
  if (!tableLabel) { { res.status(400).json({ error: "tableLabel is required" }); return; } }
  const [row] = await db.insert(fbTabsTable).values({
    organizationId: orgId, tableLabel,
    guestName: guestName ?? null,
    partySize: partySize ?? 1,
    clubMemberId: clubMemberId ?? null,
    notes: notes ?? null,
    serverUserId: serverUserId ?? caller.id,
  }).returning();
  broadcastFbEvent(orgId, "tab_opened", row);
  res.status(201).json(row);
});

// PATCH /organizations/:orgId/fb/tabs/:tabId — update tab metadata
router.patch("/tabs/:tabId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const tabId = parseInt(String((req.params as Record<string, string>).tabId));
  const { tableLabel, guestName, partySize, clubMemberId, notes, serverUserId } = req.body;
  const [row] = await db.update(fbTabsTable)
    .set({ tableLabel, guestName, partySize, clubMemberId, notes, serverUserId, updatedAt: new Date() })
    .where(and(eq(fbTabsTable.id, tabId), eq(fbTabsTable.organizationId, orgId), eq(fbTabsTable.status, "open")))
    .returning();
  if (!row) { { res.status(404).json({ error: "Open tab not found" }); return; } }
  res.json(row);
});

// POST /organizations/:orgId/fb/tabs/:tabId/transfer-orders — move orders to another open tab
router.post("/tabs/:tabId/transfer-orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const fromTabId = parseInt(String((req.params as Record<string, string>).tabId));
  const { toTabId, orderIds } = req.body as { toTabId: number; orderIds: number[] };
  if (!toTabId || !Array.isArray(orderIds) || orderIds.length === 0) {
    res.status(400).json({ error: "toTabId and orderIds are required" }); return;
  }
  const [from] = await db.select().from(fbTabsTable)
    .where(and(eq(fbTabsTable.id, fromTabId), eq(fbTabsTable.organizationId, orgId), eq(fbTabsTable.status, "open")));
  const [to] = await db.select().from(fbTabsTable)
    .where(and(eq(fbTabsTable.id, toTabId), eq(fbTabsTable.organizationId, orgId), eq(fbTabsTable.status, "open")));
  if (!from || !to) { { res.status(404).json({ error: "Both tabs must exist and be open" }); return; } }
  await db.update(fbOrdersTable)
    .set({ tabId: toTabId, tableLabel: to.tableLabel, updatedAt: new Date() })
    .where(and(eq(fbOrdersTable.organizationId, orgId), eq(fbOrdersTable.tabId, fromTabId), inArray(fbOrdersTable.id, orderIds)));
  res.json({ ok: true, moved: orderIds.length });
});

// POST /organizations/:orgId/fb/tabs/:tabId/split — split selected orders into a new tab
router.post("/tabs/:tabId/split", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const fromTabId = parseInt(String((req.params as Record<string, string>).tabId));
  const caller = getUser(req)!;
  const { orderIds, newTableLabel, guestName } = req.body as {
    orderIds: number[]; newTableLabel?: string; guestName?: string;
  };
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    res.status(400).json({ error: "orderIds are required" }); return;
  }
  const [from] = await db.select().from(fbTabsTable)
    .where(and(eq(fbTabsTable.id, fromTabId), eq(fbTabsTable.organizationId, orgId), eq(fbTabsTable.status, "open")));
  if (!from) { { res.status(404).json({ error: "Source tab not found or not open" }); return; } }
  const [newTab] = await db.insert(fbTabsTable).values({
    organizationId: orgId,
    tableLabel: newTableLabel ?? `${from.tableLabel} / Split`,
    guestName: guestName ?? null,
    serverUserId: from.serverUserId ?? caller.id,
  }).returning();
  await db.update(fbOrdersTable)
    .set({ tabId: newTab.id, tableLabel: newTab.tableLabel, updatedAt: new Date() })
    .where(and(eq(fbOrdersTable.organizationId, orgId), eq(fbOrdersTable.tabId, fromTabId), inArray(fbOrdersTable.id, orderIds)));
  res.status(201).json(newTab);
});

// POST /organizations/:orgId/fb/tabs/:tabId/close
// Body: { paymentMethod: 'cash' | 'card' | 'member_account', clubMemberId?, tip?, notes? }
// On member_account: writes a memberAccountChargesTable row + financialLedger fb_order entry.
router.post("/tabs/:tabId/close", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;
  const tabId = parseInt(String((req.params as Record<string, string>).tabId));
  const caller = getUser(req)!;
  const { paymentMethod, clubMemberId, tip, notes } = req.body as {
    paymentMethod: "cash" | "card" | "member_account";
    clubMemberId?: number; tip?: number; notes?: string;
  };
  if (!["cash", "card", "member_account"].includes(paymentMethod)) {
    res.status(400).json({ error: "paymentMethod must be cash | card | member_account" }); return;
  }
  const [tab] = await db.select().from(fbTabsTable)
    .where(and(eq(fbTabsTable.id, tabId), eq(fbTabsTable.organizationId, orgId), eq(fbTabsTable.status, "open")));
  if (!tab) { { res.status(404).json({ error: "Open tab not found" }); return; } }

  const orders = await db.select().from(fbOrdersTable)
    .where(and(eq(fbOrdersTable.tabId, tabId), eq(fbOrdersTable.organizationId, orgId)));
  const activeOrders = orders.filter(o => o.status !== "cancelled");
  const subtotal = activeOrders.reduce((s, o) => s + parseFloat(o.totalAmount), 0);
  const tipAmt = Math.max(0, Number(tip ?? 0));
  const total = subtotal + tipAmt;

  // Member account: link charge to ledger
  let memberCharge: typeof memberAccountChargesTable.$inferSelect | null = null;
  if (paymentMethod === "member_account") {
    const memberId = clubMemberId ?? tab.clubMemberId;
    if (!memberId) {
      res.status(400).json({ error: "clubMemberId required for member_account payment" }); return;
    }
    const [m] = await db.select().from(clubMembersTable)
      .where(and(eq(clubMembersTable.id, memberId), eq(clubMembersTable.organizationId, orgId)));
    if (!m) { { res.status(404).json({ error: "Club member not found" }); return; } }
    [memberCharge] = await db.insert(memberAccountChargesTable).values({
      organizationId: orgId,
      clubMemberId: memberId,
      amount: String(total.toFixed(2)),
      currency: "INR",
      description: `F&B tab ${tab.tableLabel} (#${tab.id})${tipAmt ? ` incl. tip ₹${tipAmt.toFixed(2)}` : ""}`,
    }).returning();
    // Mirror to financial ledger
    await db.insert(financialLedgerTable).values({
      organizationId: orgId,
      eventType: "fb_order",
      sourceModule: "fb",
      sourceId: tab.id,
      sourceRef: `fb_tab:${tab.id}`,
      memberId,
      memberName: `${m.firstName} ${m.lastName}`.trim(),
      description: `F&B tab ${tab.tableLabel} (#${tab.id}) charged to member account`,
      amount: String(total.toFixed(2)),
      currency: "INR",
      transactionDate: new Date().toISOString().slice(0, 10),
      syncStatus: "pending",
    }).catch(err => console.error("FB tab ledger insert failed:", err));
  } else {
    // Cash / card → log to financial ledger as direct revenue
    await db.insert(financialLedgerTable).values({
      organizationId: orgId,
      eventType: "fb_order",
      sourceModule: "fb",
      sourceId: tab.id,
      sourceRef: `fb_tab:${tab.id}`,
      description: `F&B tab ${tab.tableLabel} (#${tab.id}) — ${paymentMethod}`,
      amount: String(total.toFixed(2)),
      currency: "INR",
      transactionDate: new Date().toISOString().slice(0, 10),
      syncStatus: "pending",
    }).catch(err => console.error("FB tab ledger insert failed:", err));
  }

  // Mark all active orders on the tab as delivered + paid
  const newPaymentStatus = paymentMethod === "member_account" ? "pending_settlement" : "collected";
  await db.update(fbOrdersTable)
    .set({
      status: "delivered",
      deliveredAt: new Date(),
      paymentStatus: newPaymentStatus,
      paymentMethod: paymentMethod === "member_account" ? "account_charge" : "card_on_delivery",
      updatedAt: new Date(),
    })
    .where(and(eq(fbOrdersTable.tabId, tabId), inArray(fbOrdersTable.status, ["received","preparing","ready","delivered"])));

  const [closedTab] = await db.update(fbTabsTable)
    .set({
      status: "closed",
      closedAt: new Date(),
      closedByUserId: caller.id,
      closedPaymentMethod: paymentMethod,
      closedTotal: String(total.toFixed(2)),
      clubMemberId: paymentMethod === "member_account" ? (clubMemberId ?? tab.clubMemberId) : tab.clubMemberId,
      notes: notes ?? tab.notes,
      updatedAt: new Date(),
    })
    .where(eq(fbTabsTable.id, tabId)).returning();

  broadcastFbEvent(orgId, "tab_closed", closedTab);
  res.json({ tab: closedTab, subtotal: subtotal.toFixed(2), tip: tipAmt.toFixed(2), total: total.toFixed(2), memberCharge });
});

// POST /organizations/:orgId/fb/tabs/:tabId/void — void an open tab
router.post("/tabs/:tabId/void", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const tabId = parseInt(String((req.params as Record<string, string>).tabId));
  const caller = getUser(req)!;
  const [tab] = await db.update(fbTabsTable)
    .set({ status: "voided", closedAt: new Date(), closedByUserId: caller.id, updatedAt: new Date() })
    .where(and(eq(fbTabsTable.id, tabId), eq(fbTabsTable.organizationId, orgId), eq(fbTabsTable.status, "open")))
    .returning();
  if (!tab) { { res.status(404).json({ error: "Open tab not found" }); return; } }
  await db.update(fbOrdersTable)
    .set({ status: "cancelled", paymentStatus: "voided", updatedAt: new Date() })
    .where(and(eq(fbOrdersTable.tabId, tabId), inArray(fbOrdersTable.status, ["received","preparing","ready","delivered"])));
  res.json(tab);
});

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT: Sales by server
// ═══════════════════════════════════════════════════════════════════════════════

// GET /organizations/:orgId/fb/reports/server-sales?startDate&endDate
router.get("/reports/server-sales", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const parseDate = (s: string): Date => {
    const d = new Date(`${s}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? new Date() : d;
  };
  const startDate = req.query.startDate
    ? parseDate(req.query.startDate as string)
    : (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 30); d.setUTCHours(0,0,0,0); return d; })();
  const endDate = req.query.endDate
    ? (() => { const d = parseDate(req.query.endDate as string); d.setUTCDate(d.getUTCDate() + 1); return d; })()
    : (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(0,0,0,0); return d; })();

  const rows = await db.select({
    serverUserId: fbOrdersTable.serverUserId,
    serverName: appUsersTable.displayName,
    serverEmail: appUsersTable.email,
    orderCount: sql<number>`count(*)::int`,
    revenue: sql<string>`COALESCE(SUM(${fbOrdersTable.totalAmount}), 0)::text`,
  }).from(fbOrdersTable)
    .leftJoin(appUsersTable, eq(fbOrdersTable.serverUserId, appUsersTable.id))
    .where(and(
      eq(fbOrdersTable.organizationId, orgId),
      gte(fbOrdersTable.createdAt, startDate),
      lte(fbOrdersTable.createdAt, endDate),
      sql`${fbOrdersTable.status} <> 'cancelled'`,
    ))
    .groupBy(fbOrdersTable.serverUserId, appUsersTable.displayName, appUsersTable.email)
    .orderBy(sql`SUM(${fbOrdersTable.totalAmount}) DESC NULLS LAST`);

  res.json(rows.map(r => ({
    serverUserId: r.serverUserId,
    serverName: r.serverName ?? (r.serverUserId ? `User #${r.serverUserId}` : "Unattributed"),
    serverEmail: r.serverEmail,
    orderCount: r.orderCount,
    revenue: r.revenue,
  })));
});

export default router;
