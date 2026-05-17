import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  shopLocationsTable, shopVariantStockTable, shopStockAdjustmentsTable,
  shopStockTransfersTable, shopStocktakeSessionsTable, shopStocktakeItemsTable,
  shopProductVariantsTable, shopProductsTable, orgMembershipsTable,
  productWaitlistTable,
} from "@workspace/db";
import { eq, and, desc, asc, sql, inArray, or, gte, lte, sum, isNull } from "drizzle-orm";
import { sendBroadcast } from "../lib/comms";
import PDFDocument from "pdfkit";
import bwipjs from "bwip-js/node";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser { id: number; role?: string; organizationId?: number }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

/**
 * Automatically send restock notification emails to waitlist members for a given variant.
 * Finds the parent product, looks up un-notified waitlist entries for that product/variant,
 * marks them as notified, and dispatches broadcast emails. Fire-and-forget safe.
 */
async function autoNotifyWaitlist(orgId: number, variantId: number): Promise<void> {
  const [variantRow] = await db
    .select({ productId: shopProductVariantsTable.productId, productName: shopProductsTable.name })
    .from(shopProductVariantsTable)
    .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
    .where(eq(shopProductVariantsTable.id, variantId));
  if (!variantRow) return;

  const { productId, productName } = variantRow;
  const now = new Date();

  // Find un-notified waitlist entries for this product/variant combo, FIFO order
  const waiters = await db.select()
    .from(productWaitlistTable)
    .where(and(
      eq(productWaitlistTable.organizationId, orgId),
      eq(productWaitlistTable.productId, productId),
      isNull(productWaitlistTable.notifiedAt),
      // Match either variant-specific or product-level entries
      or(
        eq(productWaitlistTable.variantId, variantId),
        isNull(productWaitlistTable.variantId),
      ),
    ))
    .orderBy(productWaitlistTable.createdAt);
  if (waiters.length === 0) return;

  // Mark as notified
  await db.update(productWaitlistTable)
    .set({ notifiedAt: now })
    .where(and(
      eq(productWaitlistTable.organizationId, orgId),
      eq(productWaitlistTable.productId, productId),
      isNull(productWaitlistTable.notifiedAt),
      or(eq(productWaitlistTable.variantId, variantId), isNull(productWaitlistTable.variantId)),
    ));

  const recipients = waiters
    .filter(w => !!w.email)
    .map(w => {
      const parts = (w.name ?? "").split(" ");
      return { email: w.email, firstName: parts[0] || "there", lastName: parts.slice(1).join(" ") || "—" };
    });

  if (recipients.length > 0) {
    await sendBroadcast(recipients, {
      subject: `${productName} is back in stock!`,
      body: `Great news! **${productName}** is back in stock at the Pro Shop. Head over now to grab yours before it sells out.`,
      channels: ["email", "push"],
      eventName: "product_restock",
      // Task #1566 — tag waitlist restock-notification emails with the
      // originating club so the Postmark bounce webhook (Task #981) can
      // attribute hard bounces back to this org instantly.
      organizationId: orgId,
    });
    console.info(`[inventory] auto-notified ${recipients.length} waitlist member(s) for product ${productId} (variant ${variantId})`);
  }
}

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  const caller = getUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if ((caller.role === "org_admin" || caller.role === "tournament_director") && Number(caller.organizationId) === orgId) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"])));
  if (!m) { res.status(403).json({ error: "Admin access required" }); return false; }
  return true;
}

async function requireOrgStaff(req: Request, res: Response, orgId: number): Promise<boolean> {
  const caller = getUser(req);
  if (!caller) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (caller.role === "super_admin") return true;
  if ((caller.role === "org_admin" || caller.role === "tournament_director" || caller.role === "pro_shop") && Number(caller.organizationId) === orgId) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "pro_shop"])));
  if (!m) { res.status(403).json({ error: "Staff access required" }); return false; }
  return true;
}

// ─── LOCATIONS ────────────────────────────────────────────────────────────────

// GET /organizations/:orgId/inventory/locations
router.get("/locations", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const locations = await db.select().from(shopLocationsTable)
    .where(eq(shopLocationsTable.organizationId, orgId))
    .orderBy(asc(shopLocationsTable.isDefault), asc(shopLocationsTable.name));

  res.json({ locations });
});

// POST /organizations/:orgId/inventory/locations
router.post("/locations", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, type, isDefault } = req.body;
  if (!name?.trim()) { { res.status(400).json({ error: "Location name is required" }); return; } }

  const location = await db.transaction(async (tx) => {
    if (isDefault) {
      await tx.update(shopLocationsTable).set({ isDefault: false })
        .where(eq(shopLocationsTable.organizationId, orgId));
    }
    const [loc] = await tx.insert(shopLocationsTable).values({
      organizationId: orgId, name: name.trim(), type: type ?? "pro_shop",
      isDefault: isDefault ?? false,
    }).returning();
    return loc;
  });

  res.status(201).json({ location });
});

// PUT /organizations/:orgId/inventory/locations/:locationId
router.put("/locations/:locationId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const locationId = parseInt(String((req.params as Record<string, string>).locationId));
  const [existing] = await db.select().from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.id, locationId), eq(shopLocationsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Location not found" }); return; } }

  const { name, type, isDefault, isActive } = req.body;

  const location = await db.transaction(async (tx) => {
    if (isDefault && !existing.isDefault) {
      await tx.update(shopLocationsTable).set({ isDefault: false })
        .where(eq(shopLocationsTable.organizationId, orgId));
    }
    const [loc] = await tx.update(shopLocationsTable).set({
      name: name?.trim() ?? existing.name,
      type: type ?? existing.type,
      isDefault: isDefault ?? existing.isDefault,
      isActive: isActive ?? existing.isActive,
      updatedAt: new Date(),
    }).where(eq(shopLocationsTable.id, locationId)).returning();
    return loc;
  });

  res.json({ location });
});

// DELETE /organizations/:orgId/inventory/locations/:locationId
router.delete("/locations/:locationId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const locationId = parseInt(String((req.params as Record<string, string>).locationId));
  const [existing] = await db.select().from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.id, locationId), eq(shopLocationsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Location not found" }); return; } }
  if (existing.isDefault) { { res.status(400).json({ error: "Cannot delete the default location" }); return; } }

  await db.update(shopLocationsTable).set({ isActive: false, updatedAt: new Date() })
    .where(eq(shopLocationsTable.id, locationId));
  res.json({ ok: true });
});

// ─── INVENTORY OVERVIEW ───────────────────────────────────────────────────────

// GET /organizations/:orgId/inventory/overview
// Returns all variants with per-location stock levels, reorder status
router.get("/overview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { locationId: locParam } = req.query;

  const locations = await db.select().from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isActive, true)))
    .orderBy(asc(shopLocationsTable.isDefault));

  const products = await db.select().from(shopProductsTable)
    .where(eq(shopProductsTable.organizationId, orgId))
    .orderBy(asc(shopProductsTable.category), asc(shopProductsTable.name));

  const productIds = products.map(p => p.id);
  if (productIds.length === 0) { { res.json({ locations, products: [] }); return; } }

  const variants = await db.select().from(shopProductVariantsTable)
    .where(inArray(shopProductVariantsTable.productId, productIds))
    .orderBy(asc(shopProductVariantsTable.productId));

  const variantIds = variants.map(v => v.id);

  const stockRows = variantIds.length > 0
    ? await db.select().from(shopVariantStockTable)
        .where(locParam
          ? and(inArray(shopVariantStockTable.variantId, variantIds), eq(shopVariantStockTable.locationId, parseInt(String(locParam))))
          : inArray(shopVariantStockTable.variantId, variantIds)
        )
    : [];

  const stockMap = new Map<string, typeof stockRows[number]>();
  for (const s of stockRows) stockMap.set(`${s.variantId}-${s.locationId}`, s);

  const variantsByProduct = new Map<number, typeof variants>();
  for (const v of variants) {
    if (!variantsByProduct.has(v.productId)) variantsByProduct.set(v.productId, []);
    variantsByProduct.get(v.productId)!.push(v);
  }

  const result = products.map(p => ({
    ...p,
    variants: (variantsByProduct.get(p.id) ?? []).map(v => ({
      ...v,
      stock: locations.map(l => {
        const s = stockMap.get(`${v.id}-${l.id}`);
        return {
          locationId: l.id,
          locationName: l.name,
          quantity: s?.quantity ?? 0,
          reorderPoint: s?.reorderPoint ?? null,
          reorderQty: s?.reorderQty ?? null,
          belowReorder: s?.reorderPoint != null && (s?.quantity ?? 0) < s.reorderPoint,
        };
      }),
      totalStock: stockRows.filter(s => s.variantId === v.id).reduce((sum, s) => sum + s.quantity, 0),
    })),
  }));

  res.json({ locations, products: result });
});

// ─── BARCODE LOOKUP ───────────────────────────────────────────────────────────

// GET /organizations/:orgId/inventory/barcode/:barcode
router.get("/barcode/:barcode", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { barcode } = (req.params as Record<string, string>);

  const [variant] = await db.select({
    variantId: shopProductVariantsTable.id,
    variantColor: shopProductVariantsTable.color,
    variantSize: shopProductVariantsTable.size,
    variantStockQty: shopProductVariantsTable.stockQty,
    variantBarcode: shopProductVariantsTable.barcode,
    variantSku: shopProductVariantsTable.sku,
    variantCostPrice: shopProductVariantsTable.costPrice,
    productId: shopProductsTable.id,
    productName: shopProductsTable.name,
    productCategory: shopProductsTable.category,
    productMarkupPrice: shopProductsTable.markupPrice,
    productBasePrice: shopProductsTable.basePrice,
    productImageUrl: shopProductsTable.imageUrl,
    productCurrency: shopProductsTable.currency,
  }).from(shopProductVariantsTable)
    .innerJoin(shopProductsTable, and(
      eq(shopProductVariantsTable.productId, shopProductsTable.id),
      eq(shopProductsTable.organizationId, orgId),
    ))
    .where(eq(shopProductVariantsTable.barcode, barcode));

  if (!variant) {
    const [bySkuVariant] = await db.select({
      variantId: shopProductVariantsTable.id,
      variantColor: shopProductVariantsTable.color,
      variantSize: shopProductVariantsTable.size,
      variantStockQty: shopProductVariantsTable.stockQty,
      variantBarcode: shopProductVariantsTable.barcode,
      variantSku: shopProductVariantsTable.sku,
      variantCostPrice: shopProductVariantsTable.costPrice,
      productId: shopProductsTable.id,
      productName: shopProductsTable.name,
      productCategory: shopProductsTable.category,
      productMarkupPrice: shopProductsTable.markupPrice,
      productBasePrice: shopProductsTable.basePrice,
      productImageUrl: shopProductsTable.imageUrl,
      productCurrency: shopProductsTable.currency,
    }).from(shopProductVariantsTable)
      .innerJoin(shopProductsTable, and(
        eq(shopProductVariantsTable.productId, shopProductsTable.id),
        eq(shopProductsTable.organizationId, orgId),
      ))
      .where(eq(shopProductVariantsTable.sku, barcode));

    if (!bySkuVariant) { { res.status(404).json({ error: "Product not found for this barcode" }); return; } }
    res.json({ variant: bySkuVariant });
    return;
  }

  res.json({ variant });
});

// ─── VARIANT STOCK MANAGEMENT ─────────────────────────────────────────────────

// PUT /organizations/:orgId/inventory/variants/:variantId/stock
// Set or update stock level at a specific location
router.put("/variants/:variantId/stock", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const variantId = parseInt(String((req.params as Record<string, string>).variantId));
  const { locationId, quantity, reorderPoint, reorderQty } = req.body;

  if (locationId == null) { { res.status(400).json({ error: "locationId is required" }); return; } }

  const [variant] = await db.select({ id: shopProductVariantsTable.id })
    .from(shopProductVariantsTable)
    .innerJoin(shopProductsTable, and(
      eq(shopProductVariantsTable.productId, shopProductsTable.id),
      eq(shopProductsTable.organizationId, orgId),
    ))
    .where(eq(shopProductVariantsTable.id, variantId));
  if (!variant) { { res.status(404).json({ error: "Variant not found" }); return; } }

  // Verify location belongs to this org (prevents cross-tenant stock writes)
  const [loc] = await db.select({ id: shopLocationsTable.id }).from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.id, locationId), eq(shopLocationsTable.organizationId, orgId)));
  if (!loc) { { res.status(404).json({ error: "Location not found" }); return; } }

  const existing = await db.select().from(shopVariantStockTable)
    .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, locationId)));

  let stock;
  if (existing.length > 0) {
    const oldQty = existing[0].quantity;
    const newQty = quantity ?? existing[0].quantity;
    [stock] = await db.update(shopVariantStockTable).set({
      quantity: newQty,
      reorderPoint: reorderPoint ?? existing[0].reorderPoint,
      reorderQty: reorderQty ?? existing[0].reorderQty,
      updatedAt: new Date(),
    }).where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, locationId))).returning();

    if (quantity != null && newQty !== oldQty) {
      const caller = getUser(req)!;
      await db.insert(shopStockAdjustmentsTable).values({
        organizationId: orgId,
        variantId,
        locationId,
        qtyDelta: newQty - oldQty,
        type: "manual_adjustment",
        reason: req.body.reason ?? "Manual stock update",
        createdByUserId: caller.id,
      });

      // Auto-notify waitlist if stock increased from ≤0 to positive
      if (oldQty <= 0 && newQty > 0) {
        autoNotifyWaitlist(orgId, variantId).catch(err =>
          console.warn("[inventory] waitlist auto-notify error:", err instanceof Error ? err.message : err)
        );
      }
    }
  } else {
    [stock] = await db.insert(shopVariantStockTable).values({
      variantId, locationId,
      quantity: quantity ?? 0,
      reorderPoint: reorderPoint ?? null,
      reorderQty: reorderQty ?? null,
    }).returning();

    if (quantity != null && quantity > 0) {
      const caller = getUser(req)!;
      await db.insert(shopStockAdjustmentsTable).values({
        organizationId: orgId,
        variantId,
        locationId,
        qtyDelta: quantity,
        type: "initial_stock",
        reason: "Initial stock set",
        createdByUserId: caller.id,
      });

      // Treat initial stock set as a restock event too
      autoNotifyWaitlist(orgId, variantId).catch(err =>
        console.warn("[inventory] waitlist auto-notify error:", err instanceof Error ? err.message : err)
      );
    }
  }

  res.json({ stock });
});

// PATCH /organizations/:orgId/inventory/variants/:variantId/barcode
router.patch("/variants/:variantId/barcode", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const variantId = parseInt(String((req.params as Record<string, string>).variantId));
  const { barcode, sku, costPrice } = req.body;

  const [variant] = await db.select({ id: shopProductVariantsTable.id })
    .from(shopProductVariantsTable)
    .innerJoin(shopProductsTable, and(
      eq(shopProductVariantsTable.productId, shopProductsTable.id),
      eq(shopProductsTable.organizationId, orgId),
    ))
    .where(eq(shopProductVariantsTable.id, variantId));
  if (!variant) { { res.status(404).json({ error: "Variant not found" }); return; } }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (barcode !== undefined) updateData.barcode = barcode || null;
  if (sku !== undefined) updateData.sku = sku || null;
  if (costPrice !== undefined) updateData.costPrice = costPrice ? String(costPrice) : null;

  const [updated] = await db.update(shopProductVariantsTable)
    .set(updateData as Parameters<ReturnType<typeof db.update>["set"]>[0])
    .where(eq(shopProductVariantsTable.id, variantId))
    .returning();

  res.json({ variant: updated });
});

// ─── STOCK TRANSFERS ─────────────────────────────────────────────────────────

// POST /organizations/:orgId/inventory/transfers
router.post("/transfers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const { fromLocationId, toLocationId, variantId, quantity, notes } = req.body;

  if (!fromLocationId || !toLocationId || !variantId || !quantity) {
    res.status(400).json({ error: "fromLocationId, toLocationId, variantId, quantity are required" }); return;
  }
  if (fromLocationId === toLocationId) {
    res.status(400).json({ error: "Source and destination locations must be different" }); return;
  }
  if (quantity <= 0) { { res.status(400).json({ error: "Quantity must be positive" }); return; } }

  const [fromLoc] = await db.select({ id: shopLocationsTable.id }).from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.id, fromLocationId), eq(shopLocationsTable.organizationId, orgId)));
  if (!fromLoc) { { res.status(404).json({ error: "Source location not found" }); return; } }

  const [toLoc] = await db.select({ id: shopLocationsTable.id }).from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.id, toLocationId), eq(shopLocationsTable.organizationId, orgId)));
  if (!toLoc) { { res.status(404).json({ error: "Destination location not found" }); return; } }

  // Verify that the variant belongs to this org (tenant boundary check)
  const [variantOwnCheck] = await db.select({ id: shopProductVariantsTable.id })
    .from(shopProductVariantsTable)
    .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
    .where(and(
      eq(shopProductVariantsTable.id, variantId),
      eq(shopProductsTable.organizationId, orgId),
    )).limit(1);
  if (!variantOwnCheck) { { res.status(400).json({ error: "Variant not found for this organisation" }); return; } }

  const fromStock = await db.select().from(shopVariantStockTable)
    .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, fromLocationId)));

  const currentFromQty = fromStock[0]?.quantity ?? 0;
  if (currentFromQty < quantity) {
    res.status(400).json({ error: `Insufficient stock. Available at source: ${currentFromQty}` }); return;
  }

  await db.transaction(async (tx) => {
    await tx.insert(shopStockTransfersTable).values({
      organizationId: orgId, fromLocationId, toLocationId, variantId,
      quantity, notes, createdByUserId: caller.id,
    });

    if (fromStock.length > 0) {
      await tx.update(shopVariantStockTable)
        .set({ quantity: sql`${shopVariantStockTable.quantity} - ${quantity}`, updatedAt: new Date() })
        .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, fromLocationId)));
    }

    const toStock = await tx.select().from(shopVariantStockTable)
      .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, toLocationId)));
    if (toStock.length > 0) {
      await tx.update(shopVariantStockTable)
        .set({ quantity: sql`${shopVariantStockTable.quantity} + ${quantity}`, updatedAt: new Date() })
        .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, toLocationId)));
    } else {
      await tx.insert(shopVariantStockTable).values({
        variantId, locationId: toLocationId, quantity,
      });
    }

    await tx.insert(shopStockAdjustmentsTable).values([
      { organizationId: orgId, variantId, locationId: fromLocationId, qtyDelta: -quantity, type: "transfer_out", reason: notes ?? "Stock transfer", createdByUserId: caller.id },
      { organizationId: orgId, variantId, locationId: toLocationId, qtyDelta: quantity, type: "transfer_in", reason: notes ?? "Stock transfer", createdByUserId: caller.id },
    ]);
  });

  res.status(201).json({ ok: true });
});

// GET /organizations/:orgId/inventory/transfers
router.get("/transfers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const transfers = await db.select({
    id: shopStockTransfersTable.id,
    fromLocationId: shopStockTransfersTable.fromLocationId,
    toLocationId: shopStockTransfersTable.toLocationId,
    variantId: shopStockTransfersTable.variantId,
    quantity: shopStockTransfersTable.quantity,
    notes: shopStockTransfersTable.notes,
    createdAt: shopStockTransfersTable.createdAt,
  }).from(shopStockTransfersTable)
    .where(eq(shopStockTransfersTable.organizationId, orgId))
    .orderBy(desc(shopStockTransfersTable.createdAt))
    .limit(100);

  res.json({ transfers });
});

// ─── STOCKTAKE SESSIONS ───────────────────────────────────────────────────────

// GET /organizations/:orgId/inventory/stocktake/sessions
router.get("/stocktake/sessions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const sessions = await db.select().from(shopStocktakeSessionsTable)
    .where(eq(shopStocktakeSessionsTable.organizationId, orgId))
    .orderBy(desc(shopStocktakeSessionsTable.createdAt))
    .limit(50);

  res.json({ sessions });
});

// POST /organizations/:orgId/inventory/stocktake/sessions
router.post("/stocktake/sessions", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const { locationId, notes } = req.body;

  if (!locationId) { { res.status(400).json({ error: "locationId is required" }); return; } }

  const [loc] = await db.select({ id: shopLocationsTable.id }).from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.id, locationId), eq(shopLocationsTable.organizationId, orgId)));
  if (!loc) { { res.status(404).json({ error: "Location not found" }); return; } }

  const [session] = await db.insert(shopStocktakeSessionsTable).values({
    organizationId: orgId, locationId, notes, status: "open",
    startedByUserId: caller.id,
  }).returning();

  const variantStockRows = await db.select({
    variantId: shopVariantStockTable.variantId,
    quantity: shopVariantStockTable.quantity,
  }).from(shopVariantStockTable)
    .where(eq(shopVariantStockTable.locationId, locationId));

  if (variantStockRows.length > 0) {
    await db.insert(shopStocktakeItemsTable).values(
      variantStockRows.map(vs => ({
        sessionId: session.id,
        variantId: vs.variantId,
        expectedQty: vs.quantity,
        countedQty: 0,
      }))
    );
  }

  res.status(201).json({ session });
});

// GET /organizations/:orgId/inventory/stocktake/sessions/:sessionId
router.get("/stocktake/sessions/:sessionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));
  const [session] = await db.select().from(shopStocktakeSessionsTable)
    .where(and(eq(shopStocktakeSessionsTable.id, sessionId), eq(shopStocktakeSessionsTable.organizationId, orgId)));
  if (!session) { { res.status(404).json({ error: "Session not found" }); return; } }

  const items = await db.select({
    id: shopStocktakeItemsTable.id,
    variantId: shopStocktakeItemsTable.variantId,
    expectedQty: shopStocktakeItemsTable.expectedQty,
    countedQty: shopStocktakeItemsTable.countedQty,
    color: shopProductVariantsTable.color,
    size: shopProductVariantsTable.size,
    barcode: shopProductVariantsTable.barcode,
    sku: shopProductVariantsTable.sku,
    productId: shopProductsTable.id,
    productName: shopProductsTable.name,
  }).from(shopStocktakeItemsTable)
    .leftJoin(shopProductVariantsTable, eq(shopStocktakeItemsTable.variantId, shopProductVariantsTable.id))
    .leftJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
    .where(eq(shopStocktakeItemsTable.sessionId, sessionId))
    .orderBy(asc(shopProductsTable.name));

  res.json({ session, items });
});

// POST /organizations/:orgId/inventory/stocktake/sessions/:sessionId/scan
// Scan/count a barcode during a stocktake
router.post("/stocktake/sessions/:sessionId/scan", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));
  const [session] = await db.select().from(shopStocktakeSessionsTable)
    .where(and(eq(shopStocktakeSessionsTable.id, sessionId), eq(shopStocktakeSessionsTable.organizationId, orgId)));
  if (!session) { { res.status(404).json({ error: "Session not found" }); return; } }
  if (session.status !== "open") { { res.status(400).json({ error: "Session is not open" }); return; } }

  const { barcode, variantId: directVariantId, countedQty = 1 } = req.body;

  let resolvedVariantId: number | null = null;

  if (directVariantId) {
    // Validate this variantId actually belongs to this org (prevents cross-tenant injection)
    const [v] = await db.select({ id: shopProductVariantsTable.id })
      .from(shopProductVariantsTable)
      .innerJoin(shopProductsTable, and(
        eq(shopProductVariantsTable.productId, shopProductsTable.id),
        eq(shopProductsTable.organizationId, orgId),
      ))
      .where(eq(shopProductVariantsTable.id, parseInt(String(directVariantId))));
    if (!v) { { res.status(404).json({ error: "Variant not found" }); return; } }
    resolvedVariantId = v.id;
  } else if (barcode) {
    const [variant] = await db.select({ id: shopProductVariantsTable.id })
      .from(shopProductVariantsTable)
      .innerJoin(shopProductsTable, and(
        eq(shopProductVariantsTable.productId, shopProductsTable.id),
        eq(shopProductsTable.organizationId, orgId),
      ))
      .where(or(eq(shopProductVariantsTable.barcode, barcode), eq(shopProductVariantsTable.sku, barcode)));
    if (!variant) { { res.status(404).json({ error: "Barcode not matched to any product variant" }); return; } }
    resolvedVariantId = variant.id;
  }

  if (!resolvedVariantId) { { res.status(400).json({ error: "barcode or variantId is required" }); return; } }

  const existingItem = await db.select().from(shopStocktakeItemsTable)
    .where(and(eq(shopStocktakeItemsTable.sessionId, sessionId), eq(shopStocktakeItemsTable.variantId, resolvedVariantId)));

  let item;
  if (existingItem.length > 0) {
    const newQty = typeof countedQty === "number" && req.body.setAbsolute
      ? countedQty
      : existingItem[0].countedQty + (typeof countedQty === "number" ? countedQty : 1);
    [item] = await db.update(shopStocktakeItemsTable)
      .set({ countedQty: newQty, updatedAt: new Date() })
      .where(and(eq(shopStocktakeItemsTable.sessionId, sessionId), eq(shopStocktakeItemsTable.variantId, resolvedVariantId)))
      .returning();
  } else {
    const stockRow = await db.select({ quantity: shopVariantStockTable.quantity })
      .from(shopVariantStockTable)
      .where(and(eq(shopVariantStockTable.variantId, resolvedVariantId), eq(shopVariantStockTable.locationId, session.locationId)));

    [item] = await db.insert(shopStocktakeItemsTable).values({
      sessionId,
      variantId: resolvedVariantId,
      expectedQty: stockRow[0]?.quantity ?? 0,
      countedQty: typeof countedQty === "number" ? countedQty : 1,
    }).returning();
  }

  res.json({ item, variantId: resolvedVariantId });
});

// POST /organizations/:orgId/inventory/stocktake/sessions/:sessionId/complete
// Finalise session, apply discrepancies as adjustments
router.post("/stocktake/sessions/:sessionId/complete", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));
  const [session] = await db.select().from(shopStocktakeSessionsTable)
    .where(and(eq(shopStocktakeSessionsTable.id, sessionId), eq(shopStocktakeSessionsTable.organizationId, orgId)));
  if (!session) { { res.status(404).json({ error: "Session not found" }); return; } }
  if (session.status !== "open") { { res.status(400).json({ error: "Session is not open" }); return; } }

  const { applyAdjustments = true } = req.body;

  const items = await db.select().from(shopStocktakeItemsTable)
    .where(eq(shopStocktakeItemsTable.sessionId, sessionId));

  const discrepancies = items.filter(i => i.countedQty !== i.expectedQty);

  if (applyAdjustments && discrepancies.length > 0) {
    for (const item of discrepancies) {
      const delta = item.countedQty - item.expectedQty;

      const existing = await db.select().from(shopVariantStockTable)
        .where(and(eq(shopVariantStockTable.variantId, item.variantId), eq(shopVariantStockTable.locationId, session.locationId)));

      if (existing.length > 0) {
        await db.update(shopVariantStockTable)
          .set({ quantity: item.countedQty, updatedAt: new Date() })
          .where(and(eq(shopVariantStockTable.variantId, item.variantId), eq(shopVariantStockTable.locationId, session.locationId)));
      } else {
        await db.insert(shopVariantStockTable).values({
          variantId: item.variantId, locationId: session.locationId, quantity: item.countedQty,
        });
      }

      await db.insert(shopStockAdjustmentsTable).values({
        organizationId: orgId, variantId: item.variantId, locationId: session.locationId,
        qtyDelta: delta, type: "stocktake",
        reason: `Stocktake session #${sessionId}`,
        referenceId: String(sessionId),
        createdByUserId: caller.id,
      });

      if (delta > 0 && (item.expectedQty ?? 0) <= 0 && item.countedQty > 0) {
        autoNotifyWaitlist(orgId, item.variantId).catch(err =>
          console.warn("[inventory] stocktake waitlist notify error:", err instanceof Error ? err.message : err)
        );
      }
    }
  }

  await db.update(shopStocktakeSessionsTable)
    .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(shopStocktakeSessionsTable.id, sessionId));

  res.json({ ok: true, discrepanciesApplied: applyAdjustments ? discrepancies.length : 0 });
});

// ─── STOCK MOVEMENT REPORT ────────────────────────────────────────────────────

// GET /organizations/:orgId/inventory/reports/movement?from=&to=&locationId=
router.get("/reports/movement", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { from, to, locationId } = req.query;

  const conditions = [eq(shopStockAdjustmentsTable.organizationId, orgId)];
  if (from) conditions.push(gte(shopStockAdjustmentsTable.createdAt, new Date(String(from))));
  if (to) conditions.push(lte(shopStockAdjustmentsTable.createdAt, new Date(String(to))));
  if (locationId) conditions.push(eq(shopStockAdjustmentsTable.locationId, parseInt(String(locationId))));

  const adjustments = await db.select({
    id: shopStockAdjustmentsTable.id,
    variantId: shopStockAdjustmentsTable.variantId,
    locationId: shopStockAdjustmentsTable.locationId,
    locationName: shopLocationsTable.name,
    qtyDelta: shopStockAdjustmentsTable.qtyDelta,
    type: shopStockAdjustmentsTable.type,
    reason: shopStockAdjustmentsTable.reason,
    referenceId: shopStockAdjustmentsTable.referenceId,
    createdAt: shopStockAdjustmentsTable.createdAt,
    color: shopProductVariantsTable.color,
    size: shopProductVariantsTable.size,
    barcode: shopProductVariantsTable.barcode,
    sku: shopProductVariantsTable.sku,
    productName: shopProductsTable.name,
    productCategory: shopProductsTable.category,
  }).from(shopStockAdjustmentsTable)
    .leftJoin(shopProductVariantsTable, eq(shopStockAdjustmentsTable.variantId, shopProductVariantsTable.id))
    .leftJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
    .leftJoin(shopLocationsTable, eq(shopStockAdjustmentsTable.locationId, shopLocationsTable.id))
    .where(and(...conditions))
    .orderBy(desc(shopStockAdjustmentsTable.createdAt))
    .limit(500);

  res.json({ adjustments });
});

// GET /organizations/:orgId/inventory/reports/valuation?locationId=
// Stock valuation: units on hand × cost price per variant per location
router.get("/reports/valuation", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { locationId } = req.query;

  const locations = await db.select().from(shopLocationsTable)
    .where(and(
      eq(shopLocationsTable.organizationId, orgId),
      eq(shopLocationsTable.isActive, true),
      ...(locationId ? [eq(shopLocationsTable.id, parseInt(String(locationId)))] : []),
    ));

  const locationIds = locations.map(l => l.id);
  if (locationIds.length === 0) { { res.json({ locations, rows: [], totalValue: 0 }); return; } }

  const stockRows = await db.select({
    variantId: shopVariantStockTable.variantId,
    locationId: shopVariantStockTable.locationId,
    quantity: shopVariantStockTable.quantity,
    costPrice: shopProductVariantsTable.costPrice,
    color: shopProductVariantsTable.color,
    size: shopProductVariantsTable.size,
    sku: shopProductVariantsTable.sku,
    productName: shopProductsTable.name,
    productCategory: shopProductsTable.category,
    markupPrice: shopProductsTable.markupPrice,
    currency: shopProductsTable.currency,
  }).from(shopVariantStockTable)
    .leftJoin(shopProductVariantsTable, eq(shopVariantStockTable.variantId, shopProductVariantsTable.id))
    .leftJoin(shopProductsTable, and(
      eq(shopProductVariantsTable.productId, shopProductsTable.id),
      eq(shopProductsTable.organizationId, orgId),
    ))
    .where(inArray(shopVariantStockTable.locationId, locationIds));

  const rows = stockRows.map(r => {
    const costPrice = r.costPrice ? parseFloat(String(r.costPrice)) : parseFloat(String(r.markupPrice)) * 0.6;
    const lineValue = costPrice * r.quantity;
    return {
      ...r,
      costPrice: costPrice.toFixed(2),
      lineValue: lineValue.toFixed(2),
      locationName: locations.find(l => l.id === r.locationId)?.name ?? "",
    };
  });

  const totalValue = rows.reduce((s, r) => s + parseFloat(r.lineValue), 0);

  res.json({ locations, rows, totalValue: totalValue.toFixed(2) });
});

// ─── LOW STOCK ALERTS ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/inventory/low-stock
router.get("/low-stock", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const locations = await db.select().from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isActive, true)));
  const locationIds = locations.map(l => l.id);

  if (locationIds.length === 0) { { res.json({ alerts: [] }); return; } }

  const allStock = await db.select({
    variantId: shopVariantStockTable.variantId,
    locationId: shopVariantStockTable.locationId,
    quantity: shopVariantStockTable.quantity,
    reorderPoint: shopVariantStockTable.reorderPoint,
    reorderQty: shopVariantStockTable.reorderQty,
    color: shopProductVariantsTable.color,
    size: shopProductVariantsTable.size,
    sku: shopProductVariantsTable.sku,
    productName: shopProductsTable.name,
    productId: shopProductsTable.id,
  }).from(shopVariantStockTable)
    .leftJoin(shopProductVariantsTable, eq(shopVariantStockTable.variantId, shopProductVariantsTable.id))
    .leftJoin(shopProductsTable, and(
      eq(shopProductVariantsTable.productId, shopProductsTable.id),
      eq(shopProductsTable.organizationId, orgId),
    ))
    .where(inArray(shopVariantStockTable.locationId, locationIds));

  const alerts = allStock
    .filter(s => s.reorderPoint != null && s.quantity <= s.reorderPoint)
    .map(s => ({
      ...s,
      locationName: locations.find(l => l.id === s.locationId)?.name ?? "",
      deficit: (s.reorderPoint ?? 0) - s.quantity,
    }))
    .sort((a, b) => b.deficit - a.deficit);

  res.json({ alerts });
});

// ─── STOCK RETURNS ────────────────────────────────────────────────────────────

// POST /organizations/:orgId/inventory/returns
// Process a stock return: look up variant by barcode/SKU, add quantity back to location stock
router.post("/returns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const { barcode, variantId: variantIdParam, locationId, quantity, reason, orderId } = req.body;

  if (!locationId) { { res.status(400).json({ error: "locationId is required" }); return; } }
  const qty = parseInt(String(quantity ?? 1));
  if (qty <= 0) { { res.status(400).json({ error: "quantity must be positive" }); return; } }

  // Validate location belongs to this org
  const [loc] = await db.select({ id: shopLocationsTable.id }).from(shopLocationsTable)
    .where(and(eq(shopLocationsTable.id, locationId), eq(shopLocationsTable.organizationId, orgId)));
  if (!loc) { { res.status(404).json({ error: "Location not found" }); return; } }

  // Resolve variant — by explicit ID, barcode, or SKU
  let variantId: number | null = variantIdParam ? parseInt(String(variantIdParam)) : null;
  let variantInfo: { variantId: number; productName: string; color: string | null; size: string | null; barcode: string | null; sku: string | null } | null = null;

  if (variantId) {
    const [v] = await db.select({
      variantId: shopProductVariantsTable.id,
      productName: shopProductsTable.name,
      color: shopProductVariantsTable.color,
      size: shopProductVariantsTable.size,
      barcode: shopProductVariantsTable.barcode,
      sku: shopProductVariantsTable.sku,
    }).from(shopProductVariantsTable)
      .innerJoin(shopProductsTable, and(
        eq(shopProductVariantsTable.productId, shopProductsTable.id),
        eq(shopProductsTable.organizationId, orgId),
      ))
      .where(eq(shopProductVariantsTable.id, variantId));
    if (!v) { { res.status(404).json({ error: "Variant not found" }); return; } }
    variantInfo = v;
  } else if (barcode) {
    const [byBarcode] = await db.select({
      variantId: shopProductVariantsTable.id,
      productName: shopProductsTable.name,
      color: shopProductVariantsTable.color,
      size: shopProductVariantsTable.size,
      barcode: shopProductVariantsTable.barcode,
      sku: shopProductVariantsTable.sku,
    }).from(shopProductVariantsTable)
      .innerJoin(shopProductsTable, and(
        eq(shopProductVariantsTable.productId, shopProductsTable.id),
        eq(shopProductsTable.organizationId, orgId),
      ))
      .where(eq(shopProductVariantsTable.barcode, String(barcode)));

    if (byBarcode) {
      variantId = byBarcode.variantId;
      variantInfo = byBarcode;
    } else {
      const [bySku] = await db.select({
        variantId: shopProductVariantsTable.id,
        productName: shopProductsTable.name,
        color: shopProductVariantsTable.color,
        size: shopProductVariantsTable.size,
        barcode: shopProductVariantsTable.barcode,
        sku: shopProductVariantsTable.sku,
      }).from(shopProductVariantsTable)
        .innerJoin(shopProductsTable, and(
          eq(shopProductVariantsTable.productId, shopProductsTable.id),
          eq(shopProductsTable.organizationId, orgId),
        ))
        .where(eq(shopProductVariantsTable.sku, String(barcode)));
      if (!bySku) { { res.status(404).json({ error: "Product not found for this barcode/SKU" }); return; } }
      variantId = bySku.variantId;
      variantInfo = bySku;
    }
  } else {
    res.status(400).json({ error: "barcode or variantId is required" }); return;
  }

  // Add quantity back to stock at this location
  const [existingStock] = await db.select().from(shopVariantStockTable)
    .where(and(eq(shopVariantStockTable.variantId, variantId!), eq(shopVariantStockTable.locationId, locationId)));

  if (existingStock) {
    await db.update(shopVariantStockTable)
      .set({ quantity: sql`${shopVariantStockTable.quantity} + ${qty}`, updatedAt: new Date() })
      .where(and(eq(shopVariantStockTable.variantId, variantId!), eq(shopVariantStockTable.locationId, locationId)));
  } else {
    await db.insert(shopVariantStockTable).values({ variantId: variantId!, locationId, quantity: qty });
  }

  // Write stock adjustment audit record
  const [adjustment] = await db.insert(shopStockAdjustmentsTable).values({
    organizationId: orgId,
    variantId: variantId!,
    locationId,
    qtyDelta: qty,
    type: "return",
    reason: reason ?? "POS return",
    referenceId: orderId ? String(orderId) : null,
    createdByUserId: caller.id,
  }).returning();

  const prevQty = existingStock?.quantity ?? 0;
  const newQty = prevQty + qty;

  if (variantId && prevQty <= 0 && newQty > 0) {
    autoNotifyWaitlist(orgId, variantId).catch(err =>
      console.warn("[inventory] return waitlist notify error:", err instanceof Error ? err.message : err)
    );
  }

  res.status(201).json({ adjustment, variant: variantInfo, newQuantity: newQty });
});

// ─── BARCODE LABEL PDF ────────────────────────────────────────────────────────

// GET /organizations/:orgId/inventory/barcode-labels?variantIds=1,2,3
router.get("/barcode-labels", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { variantIds: variantIdsParam } = req.query;
  const variantIds = String(variantIdsParam ?? "").split(",").map(Number).filter(Boolean);

  if (variantIds.length === 0) { { res.status(400).json({ error: "variantIds is required" }); return; } }

  const variants = await db.select({
    id: shopProductVariantsTable.id,
    color: shopProductVariantsTable.color,
    size: shopProductVariantsTable.size,
    barcode: shopProductVariantsTable.barcode,
    sku: shopProductVariantsTable.sku,
    productName: shopProductsTable.name,
    markupPrice: shopProductsTable.markupPrice,
    currency: shopProductsTable.currency,
  }).from(shopProductVariantsTable)
    .innerJoin(shopProductsTable, and(
      eq(shopProductVariantsTable.productId, shopProductsTable.id),
      eq(shopProductsTable.organizationId, orgId),
    ))
    .where(inArray(shopProductVariantsTable.id, variantIds));

  const doc = new PDFDocument({ size: "A4", margin: 20 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=barcode-labels.pdf");
  doc.pipe(res);

  // 3 cols × 7 rows layout on A4 (approx 63.5mm × 38.1mm labels)
  const labelW = 170, labelH = 108, cols = 3, colGap = 5, rowGap = 0;
  const pageMarginX = 15, pageMarginY = 20;

  let col = 0, row = 0;

  for (const v of variants) {
    const x = pageMarginX + col * (labelW + colGap);
    const y = pageMarginY + row * (labelH + rowGap);

    doc.rect(x, y, labelW, labelH).stroke("#cccccc");

    // Product name
    doc.fontSize(9).font("Helvetica-Bold")
      .text(v.productName, x + 5, y + 5, { width: labelW - 10, ellipsis: true });

    // Variant description
    const desc = [v.color, v.size].filter(Boolean).join(" / ");
    if (desc) doc.fontSize(7).font("Helvetica").text(desc, x + 5, y + 16, { width: labelW - 10 });

    // Price
    const priceText = `₹${parseFloat(String(v.markupPrice)).toFixed(2)}`;
    doc.fontSize(8).font("Helvetica").text(priceText, x + labelW - 40, y + 5, { width: 35, align: "right" });

    // Machine-scannable barcode image using bwip-js
    const barcodeValue = v.barcode ?? v.sku ?? `KGV${v.id}`;
    // Determine barcode type: use EAN-13 if 12-13 digits, otherwise code128
    const isEAN13 = /^\d{12,13}$/.test(barcodeValue);
    const barcodeType = isEAN13 ? "ean13" : "code128";
    const barcodeValueToEncode = isEAN13 && barcodeValue.length === 12 ? barcodeValue : barcodeValue;
    try {
      const barcodeBuffer = await bwipjs.toBuffer({
        bcid: barcodeType,
        text: barcodeValueToEncode,
        scale: 2,
        height: 10,
        includetext: false,
        backgroundcolor: "ffffff",
      });
      // Place barcode image centered in label
      const barcodeW = labelW - 20;
      doc.image(barcodeBuffer, x + 10, y + 28, { width: barcodeW });
    } catch {
      // Fallback: render text in monospace if barcode generation fails
      doc.fontSize(8).font("Courier").text(barcodeValue, x + 5, y + 35, { width: labelW - 10, align: "center" });
    }

    // Human-readable barcode text below barcode image
    doc.fontSize(7).font("Courier").text(barcodeValue, x + 5, y + 90, { width: labelW - 10, align: "center" });

    // SKU if different from barcode
    if (v.sku && v.sku !== barcodeValue) {
      doc.fontSize(6).font("Helvetica").text(`SKU: ${v.sku}`, x + 5, y + 100, { width: labelW - 10 });
    }

    col++;
    if (col >= cols) { col = 0; row++; }
    if (row >= 7) { row = 0; col = 0; doc.addPage(); }
  }

  doc.end();
});

// GET /organizations/:orgId/inventory/dropship-status
// Returns dropship product sync status from Printful and/or Printify when API keys are configured.
router.get("/dropship-status", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const results: Array<{
    partner: "printful" | "printify";
    productId: string | number;
    name: string;
    thumbnail?: string;
    variants: Array<{ id: string | number; name: string; available: boolean }>;
    error?: string;
  }> = [];

  // Printful — check API key without throwing
  if (process.env.PRINTFUL_API_KEY) {
    try {
      const { getStoreProducts, getProductVariants } = await import("../lib/printful");
      const products = await getStoreProducts();
      for (const p of products.slice(0, 50)) {
        try {
          const detail = await getProductVariants(p.id);
          results.push({
            partner: "printful",
            productId: p.id,
            name: p.name,
            thumbnail: p.thumbnail_url,
            variants: (detail.variants ?? []).map(v => ({
              id: v.id,
              name: v.name,
              available: v.availability_status === "active",
            })),
          });
        } catch {
          results.push({ partner: "printful", productId: p.id, name: p.name, variants: [], error: "Failed to fetch variants" });
        }
      }
    } catch (err) {
      res.json({ products: [], error: "Printful API error" });
      return;
    }
  }

  // Printify — check API key + shop ID without throwing
  if (process.env.PRINTIFY_API_KEY && process.env.PRINTIFY_SHOP_ID) {
    try {
      const { getShopProducts } = await import("../lib/printify");
      const { data: products } = await getShopProducts();
      for (const p of (products ?? []).slice(0, 50)) {
        results.push({
          partner: "printify",
          productId: p.id,
          name: p.title,
          thumbnail: p.images?.[0]?.src,
          variants: (p.variants ?? []).map(v => ({
            id: v.id,
            name: v.title,
            available: v.is_available,
          })),
        });
      }
    } catch (err) {
      res.json({ products: results, error: "Printify API error" });
      return;
    }
  }

  const configured = !!(process.env.PRINTFUL_API_KEY || (process.env.PRINTIFY_API_KEY && process.env.PRINTIFY_SHOP_ID));
  res.json({ products: results, configured });
});

export default router;
