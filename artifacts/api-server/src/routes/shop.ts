import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  shopProductsTable, shopProductVariantsTable, shopOrdersTable, shopStoreSettingsTable,
  orgMembershipsTable, organizationsTable, appUsersTable,
  shopWishlistTable, shopReviewsTable, shopReviewPromptsTable,
  vendorFacilityAssignmentsTable,
  shopReturnsTable, shopReturnItemsTable, shopReturnBlacklistTable, shopOrderEventsTable,
  clubMembersTable, memberAccountChargesTable,
  posTransactionsTable, posTransactionItemsTable,
  shopVariantStockTable, shopStockAdjustmentsTable, shopLocationsTable,
  promotionsTable, promotionRedemptionsTable,
  affiliateCodesTable, affiliateRedemptionsTable,
  loyaltyAccountsTable, loyaltyTransactionsTable,
  tournamentMerchandiseTable, tournamentsTable,
  productWaitlistTable, shopBundlesTable, shopBundleComponentsTable,
} from "@workspace/db";
import { eq, and, or, desc, asc, inArray, avg, count, sql, lt, isNull, gte } from "drizzle-orm";
import { getRazorpayClient, getRazorpayKeyId } from "../lib/razorpay";
import { sendBroadcast } from "../lib/comms";
import { sendShopOrderReceiptEmail } from "../lib/paymentReceipts";
import { enqueueReviewPrompt } from "../lib/reviewPrompt";
import { gateFeature } from "../lib/featureGate";
import PDFDocument from "pdfkit";
import { objectStorageClient } from "../lib/objectStorage";
import { createGstInvoice, getOrgGstSettings, resolveIndianStateCode } from "../lib/gstInvoice";
import { logger } from "../lib/logger";
import { createCheckoutOrder, resolveOrgTaxes, recordCheckoutSettlement, verifyCheckoutPayment } from "../lib/checkout";
import { evaluateCartDiscounts } from "./promotions";
import { notifyPaymentSettled } from "../lib/notifications";
import { track } from "../lib/analytics";

const router: IRouter = Router({ mergeParams: true });
router.use(gateFeature("shopLockerAccess"));

/** Returns true only for org_admin / tournament_director / super_admin. */
async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number((user as { id: number; role?: string; organizationId?: number }).organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

/** Returns true for org admins + pro_shop vendor staff — for read-only inventory/product access. */
async function requireOrgAdminOrProShop(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string };
  if (user.role === "super_admin") return true;
  if (
    (user.role === "org_admin" || user.role === "tournament_director" || user.role === "pro_shop") &&
    Number((user as { id: number; role?: string; organizationId?: number }).organizationId) === orgId
  ) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "pro_shop"]),
    ));
  if (!m) { res.status(403).json({ error: "Staff or admin access required" }); return false; }
  return true;
}

// ─── STORE SETTINGS ───────────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/store-settings
router.get("/store-settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [settings] = await db.select().from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));

  // Never return the Shiprocket password — indicate whether it's set without exposing the value.
  const safeSettings = settings
    ? {
        ...settings,
        shiprocketPassword: settings.shiprocketPassword ? "••••••••" : null,
        shiprocketToken: undefined,
        shiprocketTokenExpiry: undefined,
      }
    : {
        organizationId: orgId, gstin: null, sellerName: null, sellerAddress: null,
        sellerState: null, sellerStateCode: null, shiprocketEmail: null,
        shiprocketPassword: null,
      };

  res.json(safeSettings);
});

// PUT /organizations/:orgId/shop/store-settings
router.put("/store-settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { gstin, sellerName, sellerAddress, sellerState, sellerStateCode, shiprocketEmail, shiprocketPassword } = req.body;

  // Only update the Shiprocket password if a real new value (not the masked placeholder) is provided.
  const PLACEHOLDER = "••••••••";
  const passwordUpdate = shiprocketPassword && shiprocketPassword !== PLACEHOLDER ? shiprocketPassword : undefined;

  const existing = await db.select({ id: shopStoreSettingsTable.id }).from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));

  if (existing.length > 0) {
    const updatePayload: Record<string, unknown> = {
      gstin, sellerName, sellerAddress, sellerState, sellerStateCode, shiprocketEmail, updatedAt: new Date(),
    };
    if (passwordUpdate !== undefined) updatePayload.shiprocketPassword = passwordUpdate;
    await db.update(shopStoreSettingsTable)
      .set(updatePayload as Parameters<ReturnType<typeof db.update>["set"]>[0])
      .where(eq(shopStoreSettingsTable.organizationId, orgId));
  } else {
    await db.insert(shopStoreSettingsTable).values({
      organizationId: orgId, gstin, sellerName, sellerAddress, sellerState, sellerStateCode,
      shiprocketEmail, shiprocketPassword: passwordUpdate ?? null,
    });
  }
  res.json({ ok: true });
});

// ─── SHOP PRODUCTS ────────────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/products
router.get("/products", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  let adminView = false;
  // facilityType for vendor-staff scope (null = no restriction, show org-wide unscoped products)
  let vendorFacilityTypeFilter: string | null = null;

  if (req.isAuthenticated()) {
    const user = req.user as { id: number; role?: string; organizationId?: number };
    if (user.role === "super_admin") {
      adminView = req.query.admin === "true";
    } else {
      const [m] = await db.select({ role: orgMembershipsTable.role, vendorOperatorId: orgMembershipsTable.vendorOperatorId }).from(orgMembershipsTable)
        .where(and(
          eq(orgMembershipsTable.organizationId, orgId),
          eq(orgMembershipsTable.userId, user.id),
          inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "pro_shop"]),
        ));
      if (m) {
        if (["org_admin", "tournament_director"].includes(m.role) && req.query.admin === "true") {
          adminView = true;
        } else if (m.role === "pro_shop" && m.vendorOperatorId) {
          // Vendor staff: determine their assigned facilityType from the active assignment
          const [assignment] = await db
            .select({ facilityType: vendorFacilityAssignmentsTable.facilityType })
            .from(vendorFacilityAssignmentsTable)
            .where(and(
              eq(vendorFacilityAssignmentsTable.organizationId, orgId),
              eq(vendorFacilityAssignmentsTable.vendorOperatorId, m.vendorOperatorId),
              eq(vendorFacilityAssignmentsTable.isActive, true),
            ))
            .limit(1);
          if (assignment) {
            vendorFacilityTypeFilter = assignment.facilityType;
          }
        }
      }
    }
  }

  // Build where clause
  // - Admin: all products for org
  // - Vendor staff with facility assignment: active products scoped to their facilityType OR unscoped (null facilityType)
  // - Public/member: active, unscoped products only
  const baseCondition = eq(shopProductsTable.organizationId, orgId);
  const activeCondition = eq(shopProductsTable.isActive, true);

  let whereClause;
  if (adminView) {
    whereClause = baseCondition;
  } else if (vendorFacilityTypeFilter) {
    whereClause = and(
      baseCondition,
      activeCondition,
      or(
        eq(shopProductsTable.vendorFacilityType, vendorFacilityTypeFilter),
        isNull(shopProductsTable.vendorFacilityType),
      ),
    );
  } else {
    whereClause = and(
      baseCondition,
      activeCondition,
      isNull(shopProductsTable.vendorFacilityType),
    );
  }

  const products = await db.select().from(shopProductsTable)
    .where(whereClause)
    .orderBy(asc(shopProductsTable.category), asc(shopProductsTable.name));

  res.json(products);
});

// POST /organizations/:orgId/shop/products (admin)
router.post("/products", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, imageUrl, category, basePrice, markupPrice, currency, sizes, hsnCode, gstRate } = req.body;
  if (!name || !basePrice || !markupPrice) { { res.status(400).json({ error: "name, basePrice and markupPrice are required" }); return; } }

  const [product] = await db.insert(shopProductsTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    imageUrl: imageUrl ?? null,
    category: category ?? "apparel",
    basePrice,
    markupPrice,
    currency: currency ?? "INR",
    sizes: sizes ?? ["S", "M", "L", "XL"],
    hsnCode: hsnCode ?? null,
    gstRate: gstRate ?? "18",
  }).returning();

  res.status(201).json(product);
});

// PUT /organizations/:orgId/shop/products/:productId (admin)
router.put("/products/:productId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, imageUrl, category, basePrice, markupPrice, sizes, isActive, currency, hsnCode, gstRate, tierPricing } = req.body;
  const [product] = await db.update(shopProductsTable)
    .set({ name, description, imageUrl, category, basePrice, markupPrice, sizes, isActive, currency, hsnCode, gstRate,
      ...(tierPricing !== undefined && { tierPricing }),
      updatedAt: new Date() })
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)))
    .returning();
  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }
  res.json(product);
});

// PATCH /organizations/:orgId/shop/products/:productId/tier-pricing (admin)
// Sets per-membership-tier price overrides for a product. Body: { tierPricing: { "<tierId>": price, ... } }
router.patch("/products/:productId/tier-pricing", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { tierPricing } = req.body;
  if (!tierPricing || typeof tierPricing !== "object") {
    res.status(400).json({ error: "tierPricing must be an object mapping tierId to price" });
    return;
  }
  // Validate values are non-negative numbers
  for (const [k, v] of Object.entries(tierPricing)) {
    if (typeof v !== "number" || (v as number) < 0) {
      res.status(400).json({ error: `Invalid tier price for tierId ${k}: must be a non-negative number` });
      return;
    }
  }
  const [product] = await db.update(shopProductsTable)
    .set({ tierPricing: tierPricing as Record<string, number>, updatedAt: new Date() })
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)))
    .returning();
  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }
  res.json({ ok: true, tierPricing: product.tierPricing });
});

// DELETE /organizations/:orgId/shop/products/:productId (admin)
router.delete("/products/:productId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.update(shopProductsTable).set({ isActive: false }).where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── PRODUCT VARIANTS ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/products/:productId/variants
router.get("/products/:productId/variants", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (isNaN(orgId) || isNaN(productId)) { { res.status(400).json({ error: "Invalid params" }); return; } }

  const [product] = await db.select({ id: shopProductsTable.id }).from(shopProductsTable)
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }

  const variants = await db.select().from(shopProductVariantsTable)
    .where(eq(shopProductVariantsTable.productId, productId))
    .orderBy(asc(shopProductVariantsTable.color), asc(shopProductVariantsTable.size));

  res.json(variants);
});

// POST /organizations/:orgId/shop/products/:productId/variants (admin)
router.post("/products/:productId/variants", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [product] = await db.select({ id: shopProductsTable.id }).from(shopProductsTable)
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }

  const { color, size, stockQty } = req.body;
  const [variant] = await db.insert(shopProductVariantsTable).values({
    productId,
    color: color ?? null,
    size: size ?? null,
    stockQty: stockQty ?? 0,
  }).returning();

  res.status(201).json(variant);
});

// PUT /organizations/:orgId/shop/products/:productId/variants/:variantId (admin)
router.put("/products/:productId/variants/:variantId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  const variantId = parseInt(String((req.params as Record<string, string>).variantId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { color, size, stockQty, tierPricing, salePrice, saleStart, saleEnd } = req.body;

  const [variant] = await db.update(shopProductVariantsTable)
    .set({
      ...(color !== undefined ? { color } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(stockQty !== undefined ? { stockQty } : {}),
      // Flash-sale fields (pass null to clear)
      ...(salePrice !== undefined ? { salePrice: salePrice !== null ? String(salePrice) : null } : {}),
      ...(saleStart !== undefined ? { saleStart: saleStart !== null ? new Date(saleStart as string) : null } : {}),
      ...(saleEnd !== undefined ? { saleEnd: saleEnd !== null ? new Date(saleEnd as string) : null } : {}),
      // Member-tier pricing: { silver: 1800, gold: 1600, platinum: 1400 } — pass null to clear
      ...(tierPricing !== undefined ? { tierPricing } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(shopProductVariantsTable.id, variantId), eq(shopProductVariantsTable.productId, productId)))
    .returning();

  if (!variant) { { res.status(404).json({ error: "Variant not found" }); return; } }
  res.json(variant);
});

// DELETE /organizations/:orgId/shop/products/:productId/variants/:variantId (admin)
router.delete("/products/:productId/variants/:variantId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  const variantId = parseInt(String((req.params as Record<string, string>).variantId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(shopProductVariantsTable)
    .where(and(eq(shopProductVariantsTable.id, variantId), eq(shopProductVariantsTable.productId, productId)));
  res.json({ ok: true });
});

// ─── SHOP ORDERS ─────────────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/orders (admin)
router.get("/orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const orders = await db.select({
    id: shopOrdersTable.id,
    customerName: shopOrdersTable.customerName,
    customerEmail: shopOrdersTable.customerEmail,
    customerPhone: shopOrdersTable.customerPhone,
    size: shopOrdersTable.size,
    color: shopOrdersTable.color,
    quantity: shopOrdersTable.quantity,
    totalAmount: shopOrdersTable.totalAmount,
    currency: shopOrdersTable.currency,
    status: shopOrdersTable.status,
    paymentMode: shopOrdersTable.paymentMode,
    razorpayPaymentId: shopOrdersTable.razorpayPaymentId,
    shiprocketOrderId: shopOrdersTable.shiprocketOrderId,
    awbCode: shopOrdersTable.awbCode,
    trackingNumber: shopOrdersTable.trackingNumber,
    trackingUrl: shopOrdersTable.trackingUrl,
    invoicePath: shopOrdersTable.invoicePath,
    shippingAddress: shopOrdersTable.shippingAddress,
    createdAt: shopOrdersTable.createdAt,
    productName: shopProductsTable.name,
    productImage: shopProductsTable.imageUrl,
    hsnCode: shopOrdersTable.hsnCode,
    gstRate: shopOrdersTable.gstRate,
  })
  .from(shopOrdersTable)
  .leftJoin(shopProductsTable, eq(shopOrdersTable.productId, shopProductsTable.id))
  .where(eq(shopOrdersTable.organizationId, orgId))
  .orderBy(desc(shopOrdersTable.createdAt));

  res.json(orders);
});

// GET /organizations/:orgId/shop/my-orders
router.get("/my-orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const authUser = req.user as { id: number };
  const [dbUser] = await db.select({ email: appUsersTable.email })
    .from(appUsersTable).where(eq(appUsersTable.id, authUser.id));
  if (!dbUser?.email) { { res.json([]); return; } }

  const orders = await db.select({
    id: shopOrdersTable.id,
    productId: shopOrdersTable.productId,
    size: shopOrdersTable.size,
    color: shopOrdersTable.color,
    quantity: shopOrdersTable.quantity,
    unitPrice: shopOrdersTable.unitPrice,
    totalAmount: shopOrdersTable.totalAmount,
    currency: shopOrdersTable.currency,
    status: shopOrdersTable.status,
    paymentMode: shopOrdersTable.paymentMode,
    trackingNumber: shopOrdersTable.trackingNumber,
    trackingUrl: shopOrdersTable.trackingUrl,
    awbCode: shopOrdersTable.awbCode,
    invoicePath: shopOrdersTable.invoicePath,
    createdAt: shopOrdersTable.createdAt,
    productName: shopProductsTable.name,
    productImage: shopProductsTable.imageUrl,
  })
  .from(shopOrdersTable)
  .leftJoin(shopProductsTable, eq(shopOrdersTable.productId, shopProductsTable.id))
  .where(and(
    eq(shopOrdersTable.organizationId, orgId),
    or(
      eq(shopOrdersTable.userId, authUser.id),
      ...(dbUser.email ? [eq(shopOrdersTable.customerEmail, dbUser.email)] : []),
    ),
  ))
  .orderBy(desc(shopOrdersTable.createdAt));

  res.json(orders);
});

// POST /organizations/:orgId/shop/orders/initiate-cart (Razorpay)
router.post("/orders/initiate-cart", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Login required to purchase" }); return; } }

  type ShippingAddr = { line1: string; line2?: string; city: string; state: string; pincode: string; country: string };
  const {
    items, customerName, customerEmail, customerPhone, shippingAddress, buyerGstin,
    promoCode, affiliateCode, loyaltyPointsToRedeem,
  } = req.body as {
    items: Array<{ productId: number; variantId?: number; size?: string; color?: string; quantity: number }>;
    customerName: string; customerEmail: string; customerPhone?: string;
    shippingAddress?: ShippingAddr;
    buyerGstin?: string;
    promoCode?: string;
    affiliateCode?: string;
    loyaltyPointsToRedeem?: number;
  };

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array is required" }); return;
  }
  if (!customerName || !customerEmail) {
    res.status(400).json({ error: "customerName and customerEmail are required" }); return;
  }

  const productIds = items.map(i => i.productId);
  const products = await db.select().from(shopProductsTable)
    .where(and(eq(shopProductsTable.organizationId, orgId), inArray(shopProductsTable.id, productIds)));

  type ResolvedLine = {
    product: typeof products[number];
    variantId: number | null;
    size: string | null;
    color: string | null;
    qty: number;
    unitPrice: number;
    lineTotal: number;
  };

  const lines: ResolvedLine[] = [];
  for (const item of items) {
    const product = products.find(p => p.id === item.productId);
    if (!product || !product.isActive) { { res.status(400).json({ error: `Product ${item.productId} not available` }); return; } }
    const qty = Math.max(1, item.quantity ?? 1);

    if (item.variantId) {
      const [variant] = await db.select().from(shopProductVariantsTable)
        .where(and(eq(shopProductVariantsTable.id, item.variantId), eq(shopProductVariantsTable.productId, item.productId)));
      if (!variant) { { res.status(400).json({ error: `Variant ${item.variantId} not found` }); return; } }
      if (variant.stockQty < qty) { { res.status(400).json({ error: `Insufficient stock for ${product.name} (${variant.color ?? ""} ${variant.size ?? ""})` }); return; } }
    }

    // Always use base markupPrice — the discount engine handles flash sales as explicit discount candidates
    // so they obey stacking policy and appear in the breakdown.
    const unitPrice = parseFloat(product.markupPrice);
    lines.push({ product, variantId: item.variantId ?? null, size: item.size ?? null, color: item.color ?? null, qty, unitPrice, lineTotal: unitPrice * qty });
  }

  const currencies = [...new Set(lines.map(l => l.product.currency))];
  if (currencies.length > 1) {
    res.status(400).json({ error: `All cart items must share the same currency. Found: ${currencies.join(", ")}` }); return;
  }
  const currency = currencies[0]!;
  const cartTotal = lines.reduce((s, l) => s + l.lineTotal, 0);

  const userId: number | null = req.isAuthenticated() ? (req.user as { id: number }).id : null;

  // Evaluate discounts
  const cartItems = lines.map(l => ({
    productId: l.product.id,
    variantId: l.variantId ?? undefined,
    qty: l.qty,
    unitPrice: l.unitPrice,
    category: l.product.category,
  }));

  const discountResult = await evaluateCartDiscounts({
    orgId,
    userId: userId ?? undefined,
    items: cartItems,
    cartTotal,
    promoCode,
    affiliateCode,
    loyaltyPointsToRedeem: loyaltyPointsToRedeem ?? 0,
  });

  const finalAmount = discountResult.finalTotal;
  const amountSmallestUnit = Math.round(finalAmount * 100);

  await resolveOrgTaxes({
    organizationId: orgId,
    taxableAmount: finalAmount,
    currency,
    productClass: "shop_cart",
  }).catch((err) => logger.warn({ err }, "[SHOP] tax resolution skipped — initiate-cart"));

  const checkout = await createCheckoutOrder({
    organizationId: orgId,
    amount: finalAmount,
    currency,
    receipt: `cart-${orgId}-${Date.now()}`,
    description: `Shop cart — ${items.length} item(s)`,
    customerEmail,
    metadata: { orgId: String(orgId), customerEmail, items: String(items.length) },
    sourceType: "shop_cart",
    sourceId: `cart-${orgId}-${Date.now()}`,
  });
  const rzOrder = { id: checkout.orderId, amount: checkout.amountMinor, currency: checkout.currency };

  const [storeSettings] = await db.select().from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));

  // Per-line discount ratio for splitting total discount across lines
  const discountRatio = cartTotal > 0 ? finalAmount / cartTotal : 1;

  const createdOrderIds: number[] = await db.transaction(async (tx) => {
    const ids: number[] = [];
    for (const { product, variantId, size, color, qty, unitPrice, lineTotal } of lines) {
      const adjustedLineTotal = +(lineTotal * discountRatio).toFixed(2);
      const [order] = await tx.insert(shopOrdersTable).values({
        organizationId: orgId,
        productId: product.id,
        variantId: variantId ?? undefined,
        userId: userId ?? undefined,
        customerName,
        customerEmail,
        customerPhone: customerPhone ?? undefined,
        size: size ?? undefined,
        color: color ?? undefined,
        quantity: qty,
        unitPrice: String(unitPrice),
        totalAmount: adjustedLineTotal.toFixed(2),
        currency,
        shippingAddress: (shippingAddress ?? undefined) as ShippingAddr | undefined,
        razorpayOrderId: rzOrder.id,
        paymentMode: "razorpay",
        buyerGstin: buyerGstin ?? undefined,
        sellerGstin: storeSettings?.gstin ?? undefined,
        gstRate: (product.gstRate ?? "18") as string,
        hsnCode: (product.hsnCode ?? undefined) as string | undefined,
        status: "pending",
        promoCode: promoCode ? promoCode.trim().toUpperCase() : null,
        affiliateCode: affiliateCode ? affiliateCode.trim().toUpperCase() : null,
        discountBreakdown: discountResult.discounts.length > 0 ? discountResult.discounts : null,
        discountTotal: String(discountResult.discountTotal.toFixed(2)),
        loyaltyPointsRedeemed: discountResult.loyaltyPointsRedeemed,
        stackingPolicyApplied: discountResult.stackingPolicy,
      }).returning({ id: shopOrdersTable.id });
      if (order) ids.push(order.id);
    }
    return ids;
  });

  // NOTE: promo/affiliate/loyalty redemption writes happen in verify-cart (post-payment success),
  // not here, to avoid consuming benefits on abandoned/failed payments.

  res.json({
    orderIds: createdOrderIds,
    processor: checkout.processor,
    razorpayOrderId: rzOrder.id,
    amount: amountSmallestUnit,
    currency,
    keyId: checkout.razorpayKeyId,
    stripePublishableKey: checkout.stripePublishableKey,
    clientSecret: checkout.clientSecret,
    discounts: discountResult.discounts,
    discountTotal: discountResult.discountTotal,
    finalTotal: discountResult.finalTotal,
    stackingPolicy: discountResult.stackingPolicy,
  });
});

// POST /organizations/:orgId/shop/orders/initiate (single product - kept for mobile compat)
router.post("/orders/initiate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const {
    productId, variantId, size, color, quantity,
    customerName, customerEmail, customerPhone, shippingAddress, buyerGstin,
    promoCode, affiliateCode, loyaltyPointsToRedeem,
  } = req.body;

  if (!productId || !customerName || !customerEmail) {
    res.status(400).json({ error: "productId, customerName and customerEmail are required" });
    return;
  }

  const [product] = await db.select().from(shopProductsTable)
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId), eq(shopProductsTable.isActive, true)));
  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }

  const qty = quantity ?? 1;

  if (variantId) {
    const [variant] = await db.select().from(shopProductVariantsTable)
      .where(and(eq(shopProductVariantsTable.id, variantId), eq(shopProductVariantsTable.productId, productId)));
    if (!variant) { { res.status(400).json({ error: "Variant not found" }); return; } }
    if (variant.stockQty < qty) { { res.status(400).json({ error: "Insufficient stock" }); return; } }
  }

  const userId: number | null = req.isAuthenticated() ? (req.user as { id: number }).id : null;
  const unitPrice = parseFloat(product.markupPrice);
  const cartTotal = unitPrice * qty;

  // Run the same discount engine used by initiate-cart
  const discountResult = await evaluateCartDiscounts({
    orgId,
    userId: userId ?? undefined,
    items: [{ productId: product.id, variantId: variantId ?? undefined, qty, unitPrice, category: product.category }],
    cartTotal,
    promoCode: promoCode ?? undefined,
    affiliateCode: affiliateCode ?? undefined,
    loyaltyPointsToRedeem: loyaltyPointsToRedeem ?? 0,
  });

  const finalAmount = discountResult.finalTotal;
  const amountSmallestUnit = Math.round(finalAmount * 100);

  const [storeSettings] = await db.select().from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));

  await resolveOrgTaxes({
    organizationId: orgId,
    taxableAmount: finalAmount,
    currency: product.currency,
    productClass: product.category ?? "shop",
  }).catch((err) => logger.warn({ err }, "[SHOP] tax resolution skipped — initiate single"));

  const checkout = await createCheckoutOrder({
    organizationId: orgId,
    amount: finalAmount,
    currency: product.currency,
    receipt: `shop-${Date.now()}`,
    description: `Shop — ${product.name ?? "item"}`,
    customerEmail,
    metadata: { orgId: String(orgId), productId: String(productId), size: size ?? "", customerName, customerEmail },
    sourceType: "shop_order",
    sourceId: `shop-${Date.now()}`,
  });
  const rzOrder = { id: checkout.orderId, amount: checkout.amountMinor, currency: checkout.currency };

  const [order] = await db.insert(shopOrdersTable).values({
    organizationId: orgId,
    productId,
    variantId: variantId ?? null,
    userId,
    customerName,
    customerEmail,
    customerPhone,
    size,
    color,
    quantity: qty,
    unitPrice: String(unitPrice),
    totalAmount: finalAmount.toFixed(2),
    currency: product.currency,
    shippingAddress,
    razorpayOrderId: rzOrder.id,
    paymentMode: "razorpay",
    buyerGstin: buyerGstin ?? null,
    sellerGstin: storeSettings?.gstin ?? null,
    gstRate: product.gstRate ?? "18",
    hsnCode: product.hsnCode ?? null,
    status: "pending",
    promoCode: promoCode ? promoCode.trim().toUpperCase() : null,
    affiliateCode: affiliateCode ? affiliateCode.trim().toUpperCase() : null,
    discountBreakdown: discountResult.discounts.length > 0 ? discountResult.discounts : null,
    discountTotal: String(discountResult.discountTotal.toFixed(2)),
    loyaltyPointsRedeemed: discountResult.loyaltyPointsRedeemed,
    stackingPolicyApplied: discountResult.stackingPolicy,
  }).returning();

  res.json({
    orderId: order.id,
    processor: checkout.processor,
    razorpayOrderId: rzOrder.id,
    amount: amountSmallestUnit,
    currency: product.currency,
    keyId: checkout.razorpayKeyId,
    stripePublishableKey: checkout.stripePublishableKey,
    clientSecret: checkout.clientSecret,
    discountBreakdown: discountResult.discounts,
    discountTotal: discountResult.discountTotal,
    finalAmount: discountResult.finalTotal,
  });
});

// POST /organizations/:orgId/shop/orders/cod — create COD order
router.post("/orders/cod", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Login required" }); return; } }

  type ShippingAddr2 = { line1: string; line2?: string; city: string; state: string; pincode: string; country: string };
  const {
    items, customerName, customerEmail, customerPhone, shippingAddress, buyerGstin,
    locationId: reqLocationId,
    promoCode, affiliateCode, loyaltyPointsToRedeem,
  } = req.body as {
    items: Array<{ productId: number; variantId?: number; size?: string; color?: string; quantity: number }>;
    customerName: string; customerEmail: string; customerPhone?: string;
    shippingAddress?: ShippingAddr2;
    buyerGstin?: string;
    locationId?: number;
    promoCode?: string;
    affiliateCode?: string;
    loyaltyPointsToRedeem?: number;
  };

  if (!Array.isArray(items) || items.length === 0) { { res.status(400).json({ error: "items required" }); return; } }
  if (!customerName || !customerEmail) { { res.status(400).json({ error: "customerName and customerEmail required" }); return; } }
  if (!shippingAddress) { { res.status(400).json({ error: "shippingAddress required for COD" }); return; } }

  const productIds = items.map(i => i.productId);
  const products = await db.select().from(shopProductsTable)
    .where(and(eq(shopProductsTable.organizationId, orgId), inArray(shopProductsTable.id, productIds)));

  const [storeSettings] = await db.select().from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));

  type ResolvedLine = { product: typeof products[number]; variantId: number | null; size: string | null; color: string | null; qty: number; unitPrice: number; lineTotal: number };
  const lines: ResolvedLine[] = [];

  for (const item of items) {
    const product = products.find(p => p.id === item.productId);
    if (!product || !product.isActive) { { res.status(400).json({ error: `Product ${item.productId} not available` }); return; } }
    const qty = Math.max(1, item.quantity ?? 1);

    if (item.variantId) {
      const [variant] = await db.select().from(shopProductVariantsTable)
        .where(and(eq(shopProductVariantsTable.id, item.variantId), eq(shopProductVariantsTable.productId, item.productId)));
      if (!variant) { { res.status(400).json({ error: `Variant not found` }); return; } }
      if (variant.stockQty < qty) { { res.status(400).json({ error: `Insufficient stock for ${product.name}` }); return; } }
    }

    // Always use base markupPrice; engine handles flash sales as explicit candidates
    const unitPrice = parseFloat(product.markupPrice);
    lines.push({ product, variantId: item.variantId ?? null, size: item.size ?? null, color: item.color ?? null, qty, unitPrice, lineTotal: unitPrice * qty });
  }

  // Resolve fulfillment location: use request-supplied locationId if provided and valid,
  // otherwise fall back to the org's default location.
  let fulfillmentLocationId: number | null = null;
  if (reqLocationId) {
    const [reqLoc] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.id, reqLocationId), eq(shopLocationsTable.organizationId, orgId)));
    fulfillmentLocationId = reqLoc?.id ?? null;
  }
  if (!fulfillmentLocationId) {
    const [defaultLoc] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isDefault, true)));
    fulfillmentLocationId = defaultLoc?.id ?? null;
  }

  const userId = (req.user as { id: number }).id;
  const cartTotal = lines.reduce((s, l) => s + l.lineTotal, 0);

  // Run the same discount engine used by initiate-cart and initiate
  const discountResult = await evaluateCartDiscounts({
    orgId,
    userId,
    items: lines.map(l => ({
      productId: l.product.id,
      variantId: l.variantId ?? undefined,
      qty: l.qty,
      unitPrice: l.unitPrice,
      category: l.product.category,
    })),
    cartTotal,
    promoCode: promoCode ?? undefined,
    affiliateCode: affiliateCode ?? undefined,
    loyaltyPointsToRedeem: loyaltyPointsToRedeem ?? 0,
  });

  const discountRatio = cartTotal > 0 ? discountResult.finalTotal / cartTotal : 1;

  // Create orders, deduct stock, and deduct loyalty points atomically.
  // A LOYALTY_DEDUCTION_FAILED throw inside the transaction rolls back everything.
  let createdOrders: { id: number }[];
  try {
    createdOrders = await db.transaction(async (tx) => {
    const created: { id: number }[] = [];
    for (const { product, variantId, size, color, qty, unitPrice, lineTotal } of lines) {
      const adjustedLineTotal = +(lineTotal * discountRatio).toFixed(2);
      const [order] = await tx.insert(shopOrdersTable).values({
        organizationId: orgId,
        productId: product.id,
        variantId: variantId ?? undefined,
        userId,
        customerName,
        customerEmail,
        customerPhone: customerPhone ?? undefined,
        size: size ?? undefined,
        color: color ?? undefined,
        quantity: qty,
        unitPrice: String(unitPrice),
        totalAmount: adjustedLineTotal.toFixed(2),
        currency: product.currency,
        shippingAddress: shippingAddress as ShippingAddr2,
        paymentMode: "cod",
        buyerGstin: buyerGstin ?? undefined,
        sellerGstin: storeSettings?.gstin ?? undefined,
        gstRate: (product.gstRate ?? "18") as string,
        hsnCode: (product.hsnCode ?? undefined) as string | undefined,
        status: "cod_pending",
        promoCode: promoCode ? promoCode.trim().toUpperCase() : null,
        affiliateCode: affiliateCode ? affiliateCode.trim().toUpperCase() : null,
        discountBreakdown: discountResult.discounts.length > 0 ? discountResult.discounts : null,
        discountTotal: String(discountResult.discountTotal.toFixed(2)),
        loyaltyPointsRedeemed: discountResult.loyaltyPointsRedeemed,
        stackingPolicyApplied: discountResult.stackingPolicy,
      }).returning({ id: shopOrdersTable.id });
      if (order) created.push(order);

      if (variantId) {
        await tx.update(shopProductVariantsTable)
          .set({ stockQty: sql`${shopProductVariantsTable.stockQty} - ${qty}`, updatedAt: new Date() })
          .where(eq(shopProductVariantsTable.id, variantId));
        // Deduct from per-location stock; log accurate delta inside tx
        if (fulfillmentLocationId) {
          // Ensure row exists, then deduct — allow negative stock to keep ledger consistent.
          await tx.insert(shopVariantStockTable)
            .values({ variantId, locationId: fulfillmentLocationId, quantity: 0 })
            .onConflictDoNothing();
          await tx.update(shopVariantStockTable)
            .set({ quantity: sql`${shopVariantStockTable.quantity} - ${qty}`, updatedAt: new Date() })
            .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, fulfillmentLocationId)));
          // Stock adjustment audit log (non-critical; catch to not break order creation)
          await tx.insert(shopStockAdjustmentsTable).values({
            organizationId: orgId,
            variantId,
            locationId: fulfillmentLocationId,
            qtyDelta: -qty,
            type: "sale",
            reason: `Online COD order — ${product.name}`,
            referenceId: order ? String(order.id) : undefined,
          }).catch(() => {});
        }
      }
    }

    // Loyalty deduction inside transaction for COD atomicity.
    // If deduction fails (concurrent race or insufficient balance), throw to roll back
    // order creation and stock deduction — preserving financial integrity.
    if (discountResult.loyaltyPointsRedeemed > 0) {
      const [account] = await tx.select().from(loyaltyAccountsTable)
        .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, userId)));
      if (!account) {
        throw new Error("LOYALTY_DEDUCTION_FAILED: no loyalty account found");
      }
      const deductResult = await tx.execute(
        sql`UPDATE loyalty_accounts
            SET points_balance = points_balance - ${discountResult.loyaltyPointsRedeemed},
                updated_at = NOW()
            WHERE id = ${account.id} AND points_balance >= ${discountResult.loyaltyPointsRedeemed}
            RETURNING id, points_balance`
      );
      if ((deductResult.rows as unknown[]).length === 0) {
        throw new Error("LOYALTY_DEDUCTION_FAILED: insufficient balance");
      }
      const newBalance = parseInt(String((deductResult.rows as Record<string, unknown>[])[0].points_balance ?? 0));
      const firstCreatedId = created[0]?.id;
      await tx.insert(loyaltyTransactionsTable).values({
        accountId: account.id,
        organizationId: orgId,
        userId,
        type: "redeem",
        points: -discountResult.loyaltyPointsRedeemed,
        balanceAfter: newBalance,
        serviceCategory: "pos",
        referenceId: firstCreatedId !== undefined ? `shop:${firstCreatedId}` : "shop:cod",
        description: `Redeemed at COD checkout (order #${firstCreatedId ?? "?"})`,
      });
    }

      return created;
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("LOYALTY_DEDUCTION_FAILED")) {
      res.status(409).json({ error: "Loyalty points could not be deducted — insufficient balance or concurrent redemption. Please try without loyalty redemption." });
      return;
    }
    throw err;
  }

  const createdOrderIds = createdOrders.map(o => o.id);

  // Record promo/affiliate redemptions at COD creation time
  // (Loyalty deduction is already done inside the transaction above)
  const firstOrderId = createdOrderIds[0];
  if (firstOrderId !== undefined) {
    // Promo
    if (promoCode) {
      const breakdown = discountResult.discounts as Array<{ type: string; amount: number }>;
      const promoEntry = breakdown.find(d => d.type === "promo");
      if (promoEntry && promoEntry.amount > 0) {
        const [promo] = await db.select({ id: promotionsTable.id })
          .from(promotionsTable)
          .where(and(eq(promotionsTable.organizationId, orgId), eq(promotionsTable.code, promoCode.trim().toUpperCase())));
        if (promo) {
          await db.update(promotionsTable)
            .set({ usedCount: sql`${promotionsTable.usedCount} + 1`, updatedAt: new Date() })
            .where(eq(promotionsTable.id, promo.id));
          await db.insert(promotionRedemptionsTable).values({
            promotionId: promo.id,
            organizationId: orgId,
            orderId: firstOrderId,
            userId,
            discountAmount: String(promoEntry.amount),
          });
        }
      }
    }

    // Affiliate
    if (affiliateCode) {
      const breakdown = discountResult.discounts as Array<{ type: string; amount: number; commission?: number }>;
      const affEntry = breakdown.find(d => d.type === "affiliate");
      if (affEntry && affEntry.amount > 0) {
        const [aff] = await db.select().from(affiliateCodesTable)
          .where(and(eq(affiliateCodesTable.organizationId, orgId), eq(affiliateCodesTable.code, affiliateCode.trim().toUpperCase())));
        if (aff) {
          const commission = affEntry.commission ?? 0;
          await db.update(affiliateCodesTable).set({
            totalOrders: sql`${affiliateCodesTable.totalOrders} + 1`,
            totalDiscountGiven: sql`${affiliateCodesTable.totalDiscountGiven} + ${String(affEntry.amount)}`,
            totalCommissionEarned: sql`${affiliateCodesTable.totalCommissionEarned} + ${String(commission)}`,
            updatedAt: new Date(),
          }).where(eq(affiliateCodesTable.id, aff.id));
          await db.insert(affiliateRedemptionsTable).values({
            affiliateCodeId: aff.id,
            organizationId: orgId,
            orderId: firstOrderId,
            userId,
            orderAmount: String(cartTotal.toFixed(2)),
            discountAmount: String(affEntry.amount),
            commissionAmount: String(commission),
          });
        }
      }
    }

  }
  // Loyalty deduction was performed atomically inside the transaction above

  const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const orderLines = lines.map(l => `• ${l.product.name}${l.size ? ` (${l.size})` : ""}${l.color ? ` / ${l.color}` : ""} × ${l.qty}`);
  const nameParts = customerName.trim().split(/\s+/);
  await sendBroadcast(
    [{ firstName: nameParts[0] ?? customerName, lastName: nameParts.slice(1).join(" ") || "-", email: customerEmail }],
    {
      channels: ["email"],
      subject: `COD Order Received — ${org?.name ?? "Club Shop"}`,
      body: `Hi ${customerName},\n\nYour Cash on Delivery order has been received!\n\n${orderLines.join("\n")}\n\nPayment of ₹${discountResult.finalTotal.toFixed(2)} is due on delivery.\n\nThank you!`,
      eventName: org?.name ?? "Club Shop",
      // Task #1566 — tag COD order-confirmation emails with the
      // originating club so the Postmark bounce webhook (Task #981) can
      // attribute hard bounces back to this org instantly.
      organizationId: orgId,
    },
  ).catch(() => {});

  res.status(201).json({
    ok: true,
    orderIds: createdOrderIds,
    paymentMode: "cod",
    discountBreakdown: discountResult.discounts,
    discountTotal: discountResult.discountTotal,
    finalTotal: discountResult.finalTotal,
  });
});

// POST /organizations/:orgId/shop/orders/verify-cart
router.post("/orders/verify-cart", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const razorpayPaymentId: string | undefined = req.body.razorpayPaymentId ?? req.body.razorpay_payment_id;
  const razorpayOrderId: string | undefined = req.body.razorpayOrderId ?? req.body.razorpay_order_id;
  const razorpaySignature: string | undefined = req.body.razorpaySignature ?? req.body.razorpay_signature;
  const stripePaymentIntentId: string | undefined = req.body.stripePaymentIntentId ?? req.body.stripe_payment_intent_id;
  const stripeCheckoutSessionId: string | undefined = req.body.stripeCheckoutSessionId ?? req.body.stripe_checkout_session_id;

  // Resolve which processor reference to look up the pending orders by, and
  // (for Stripe) verify the payment with the processor before marking paid.
  let lookupOrderId: string;
  let settledPaymentRef: string;
  let settledCurrencyFromProcessor = "";
  let settledAmountMinorFromProcessor = 0;
  let processorUsed: "razorpay" | "stripe";

  if (stripePaymentIntentId || stripeCheckoutSessionId) {
    const v = await verifyCheckoutPayment({
      processor: "stripe",
      stripePaymentIntentId,
      stripeCheckoutSessionId,
    });
    if (!v.paid) { { res.status(400).json({ error: "Stripe payment not yet settled" }); return; } }
    lookupOrderId = (stripePaymentIntentId ?? stripeCheckoutSessionId) as string;
    settledPaymentRef = v.paymentRef;
    settledCurrencyFromProcessor = v.currency;
    settledAmountMinorFromProcessor = v.amountMinor;
    processorUsed = "stripe";
  } else {
    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      res.status(400).json({ error: "razorpayPaymentId, razorpayOrderId and razorpaySignature are required (or Stripe equivalents)" }); return;
    }
    const { verifyPaymentSignature } = await import("../lib/razorpay");
    if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      res.status(400).json({ error: "Payment signature verification failed" }); return;
    }
    lookupOrderId = razorpayOrderId;
    settledPaymentRef = razorpayPaymentId;
    processorUsed = "razorpay";
  }

  const authUser = req.user as { id: number };
  const [dbUser] = await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, authUser.id));

  const pendingOrders = await db.select().from(shopOrdersTable)
    .where(and(
      eq(shopOrdersTable.organizationId, orgId),
      eq(shopOrdersTable.razorpayOrderId, lookupOrderId),
      eq(shopOrdersTable.status, "pending"),
      or(
        eq(shopOrdersTable.userId, authUser.id),
        ...(dbUser?.email ? [eq(shopOrdersTable.customerEmail, dbUser.email)] : []),
      ),
    ));

  if (pendingOrders.length === 0) {
    res.status(400).json({ error: "No pending orders found for this payment" }); return;
  }

  const orderIds = pendingOrders.map(o => o.id);
  const firstOrder = pendingOrders[0];

  // HARD GATE: Attempt loyalty deduction BEFORE marking order paid.
  // If deduction fails (concurrent redemption race), reject verification
  // to preserve financial integrity — the discounted amount must not be
  // collected without the corresponding point deduction.
  let loyaltyAccount: { id: number } | null = null;
  let loyaltyNewBalance: number | null = null;
  if (firstOrder && firstOrder.loyaltyPointsRedeemed && firstOrder.loyaltyPointsRedeemed > 0 && firstOrder.userId) {
    // Idempotency: skip if already deducted for this order
    const [existingAccount] = await db.select().from(loyaltyAccountsTable)
      .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, firstOrder.userId)));
    if (existingAccount) {
      const alreadyDeducted = await db.select({ id: loyaltyTransactionsTable.id })
        .from(loyaltyTransactionsTable)
        .where(and(
          eq(loyaltyTransactionsTable.accountId, existingAccount.id),
          eq(loyaltyTransactionsTable.referenceId, `shop:${firstOrder.id}`),
        ));
      if (alreadyDeducted.length === 0) {
        const deductResult = await db.execute(
          sql`UPDATE loyalty_accounts
              SET points_balance = points_balance - ${firstOrder.loyaltyPointsRedeemed},
                  updated_at = NOW()
              WHERE id = ${existingAccount.id} AND points_balance >= ${firstOrder.loyaltyPointsRedeemed}
              RETURNING id, points_balance`
        );
        if ((deductResult.rows as unknown[]).length === 0) {
          // Deduction failed: balance is insufficient (concurrent race won first)
          res.status(409).json({
            error: "Your loyalty points have already been redeemed by a concurrent checkout. Please contact support.",
          });
          return;
        }
        loyaltyAccount = existingAccount;
        loyaltyNewBalance = parseInt(String((deductResult.rows as Record<string, unknown>[])[0].points_balance ?? 0));
      }
      // else: already deducted (idempotent re-verify), nothing to do
    } else {
      // Loyalty account expected but not found — block payment to protect discount integrity
      res.status(409).json({
        error: "Loyalty account not found. Cannot complete checkout with loyalty redemption. Please contact support.",
      });
      return;
    }
  }

  // Loyalty gate passed — now mark orders paid and deduct stock.
  // Status-flip guard (status = "pending") protects against duplicate
  // verify calls re-firing the in-app push for Task #978.
  const flippedShopOrders = await db.update(shopOrdersTable)
    .set({
      razorpayPaymentId: settledPaymentRef,
      paymentMode: processorUsed,
      status: "paid",
      updatedAt: new Date(),
    })
    .where(and(inArray(shopOrdersTable.id, orderIds), eq(shopOrdersTable.status, "pending")))
    .returning({ id: shopOrdersTable.id });

  // Resolve fulfillment location: use request-supplied locationId if valid, else org default
  const verifyReqLocationId: number | undefined = req.body.locationId ? parseInt(String(req.body.locationId)) : undefined;
  let verifyFulfillmentLocId: number | null = null;
  if (verifyReqLocationId) {
    const [reqLoc] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.id, verifyReqLocationId), eq(shopLocationsTable.organizationId, orgId)));
    verifyFulfillmentLocId = reqLoc?.id ?? null;
  }
  if (!verifyFulfillmentLocId) {
    const [verifyDefaultLoc] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isDefault, true)));
    verifyFulfillmentLocId = verifyDefaultLoc?.id ?? null;
  }

  // Status-flip guard: only deduct stock + write a stock-adjustment ledger
  // row for orders that THIS request actually flipped from "pending" to
  // "paid". Two verify-cart calls can land concurrently for the same Stripe
  // session and both will see the same pre-flip `pendingOrders` snapshot;
  // without this gate, both would decrement variant stock and emit a
  // duplicate "sale" adjustment, double-counting the same purchase
  // (Task #1572 — same race that caused duplicate receipts in #1307).
  const flippedOrderIds = new Set(flippedShopOrders.map(o => o.id));
  const ordersToDeduct = pendingOrders.filter(o => flippedOrderIds.has(o.id));
  for (const order of ordersToDeduct) {
    if (order.variantId) {
      await db.update(shopProductVariantsTable)
        .set({ stockQty: sql`${shopProductVariantsTable.stockQty} - ${order.quantity}`, updatedAt: new Date() })
        .where(eq(shopProductVariantsTable.id, order.variantId));
      if (verifyFulfillmentLocId) {
        // Ensure row exists, then deduct — allow negative stock to keep ledger consistent.
        await db.insert(shopVariantStockTable)
          .values({ variantId: order.variantId, locationId: verifyFulfillmentLocId, quantity: 0 })
          .onConflictDoNothing();
        await db.update(shopVariantStockTable)
          .set({ quantity: sql`${shopVariantStockTable.quantity} - ${order.quantity}`, updatedAt: new Date() })
          .where(and(eq(shopVariantStockTable.variantId, order.variantId), eq(shopVariantStockTable.locationId, verifyFulfillmentLocId)));
        await db.insert(shopStockAdjustmentsTable).values({
          organizationId: orgId,
          variantId: order.variantId,
          locationId: verifyFulfillmentLocId,
          qtyDelta: -order.quantity,
          type: "sale",
          reason: `Online Razorpay order #${order.id}`,
          referenceId: String(order.id),
        }).catch(() => {});
      }
    }
  }

  // Post-payment: record promo/affiliate redemptions and log loyalty transaction
  if (firstOrder) {
    // Status-flip guard: only the request that actually flipped the order(s)
    // from "pending" to "paid" should bump promo `usedCount` /
    // affiliate `totalOrders` and write the redemption row. Two concurrent
    // verify-cart calls for the same Stripe session both pass the
    // SELECT-then-INSERT existence check before either insert lands, so
    // without this gate both would double-increment usage counters and
    // (modulo the unique index added later) attempt duplicate inserts —
    // mirrors the same race that affected stock (Task #1572) and receipts
    // (Task #1307).
    const promoOrAffiliateFlipped = flippedShopOrders.some(o => o.id === firstOrder.id);

    // Promo redemption — only if discount was actually applied (amount > 0 in breakdown)
    if (promoOrAffiliateFlipped && firstOrder.promoCode) {
      const breakdown = (firstOrder.discountBreakdown ?? []) as Array<{ type: string; amount: number }>;
      const promoEntry = breakdown.find(d => d.type === "promo");
      if (promoEntry && promoEntry.amount > 0) {
        const [promo] = await db.select({ id: promotionsTable.id })
          .from(promotionsTable)
          .where(and(eq(promotionsTable.organizationId, orgId), eq(promotionsTable.code, (firstOrder.promoCode ?? "").toUpperCase())));
        if (promo) {
          // Idempotency: skip if already recorded for this order
          const existing = await db.select({ id: promotionRedemptionsTable.id })
            .from(promotionRedemptionsTable)
            .where(and(eq(promotionRedemptionsTable.promotionId, promo.id), eq(promotionRedemptionsTable.orderId, firstOrder.id)));
          if (existing.length === 0) {
            await db.update(promotionsTable)
              .set({ usedCount: sql`${promotionsTable.usedCount} + 1`, updatedAt: new Date() })
              .where(eq(promotionsTable.id, promo.id));
            await db.insert(promotionRedemptionsTable).values({
              promotionId: promo.id,
              organizationId: orgId,
              orderId: firstOrder.id,
              userId: firstOrder.userId ?? null,
              discountAmount: String(promoEntry.amount),
            });
          }
        }
      }
    }

    // Affiliate redemption — only if discount was actually applied (amount > 0 in breakdown)
    if (promoOrAffiliateFlipped && firstOrder.affiliateCode) {
      const breakdown = (firstOrder.discountBreakdown ?? []) as Array<{ type: string; amount: number; commission?: number }>;
      const affEntry = breakdown.find(d => d.type === "affiliate");
      if (affEntry && affEntry.amount > 0) {
        const [aff] = await db.select().from(affiliateCodesTable)
          .where(and(eq(affiliateCodesTable.organizationId, orgId), eq(affiliateCodesTable.code, (firstOrder.affiliateCode ?? "").toUpperCase())));
        if (aff) {
          const existing = await db.select({ id: affiliateRedemptionsTable.id })
            .from(affiliateRedemptionsTable)
            .where(and(eq(affiliateRedemptionsTable.affiliateCodeId, aff.id), eq(affiliateRedemptionsTable.orderId, firstOrder.id)));
          if (existing.length === 0) {
            const affDiscount = affEntry.amount;
            const commission = affEntry.commission ?? 0;
            const cartTotalForOrder = pendingOrders.reduce((s, o) => s + parseFloat(o.totalAmount), 0);
            await db.update(affiliateCodesTable).set({
              totalOrders: sql`${affiliateCodesTable.totalOrders} + 1`,
              totalDiscountGiven: sql`${affiliateCodesTable.totalDiscountGiven} + ${String(affDiscount)}`,
              totalCommissionEarned: sql`${affiliateCodesTable.totalCommissionEarned} + ${String(commission)}`,
              updatedAt: new Date(),
            }).where(eq(affiliateCodesTable.id, aff.id));
            await db.insert(affiliateRedemptionsTable).values({
              affiliateCodeId: aff.id,
              organizationId: orgId,
              orderId: firstOrder.id,
              userId: firstOrder.userId ?? null,
              orderAmount: String(cartTotalForOrder.toFixed(2)),
              discountAmount: String(affDiscount),
              commissionAmount: String(commission),
            });
          }
        }
      }
    }

    // Log loyalty transaction for successful deduction performed by hard gate above
    if (loyaltyAccount && loyaltyNewBalance !== null && firstOrder.loyaltyPointsRedeemed && firstOrder.userId) {
      await db.insert(loyaltyTransactionsTable).values({
        accountId: loyaltyAccount.id,
        organizationId: orgId,
        userId: firstOrder.userId,
        type: "redeem",
        points: -firstOrder.loyaltyPointsRedeemed,
        balanceAfter: loyaltyNewBalance,
        serviceCategory: "pos",
        referenceId: `shop:${firstOrder.id}`,
        description: `Redeemed at checkout (order #${firstOrder.id})`,
      });
    }
  }

  // Status-flip guard: only the request that actually flipped the order(s)
  // from "pending" to "paid" should send the buyer receipt + generate GST
  // invoices. Two verify-cart calls can land concurrently (double-click on
  // "Pay", SPA retry of the post-checkout redirect, etc.) and both will see
  // the same `pendingOrders` snapshot; without this gate, both would email
  // a receipt even though only one wins the UPDATE. Mirrors the same guard
  // already used by the Razorpay in-app push branch below (Task #1307).
  if (flippedShopOrders.length > 0) (async () => {
    const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));
    const receiptLines: Array<{ description: string; quantity: number; totalAmountSubunit: number }> = [];
    const lineItems: Array<{ description: string; hsnSacCode: string; quantity: number; unitPrice: number; gstRate: number }> = [];

    for (const order of pendingOrders) {
      const [product] = await db.select().from(shopProductsTable).where(eq(shopProductsTable.id, order.productId));
      const label = product?.name ?? `Item #${order.id}`;
      const sizeLabel = order.size ? ` (${order.size})` : "";
      receiptLines.push({
        description: `${label}${sizeLabel}`,
        quantity: order.quantity,
        totalAmountSubunit: Math.round(parseFloat(String(order.totalAmount ?? "0")) * 100),
      });
      // Use stored unitPrice (pre-tax, pre-discount per unit) for accurate GST base;
      // fall back to totalAmount / quantity if unitPrice is absent.
      const unitPrice = order.unitPrice != null
        ? parseFloat(String(order.unitPrice))
        : Number(order.totalAmount) / order.quantity;
      lineItems.push({
        description: `${label}${sizeLabel}`,
        hsnSacCode: order.hsnCode ?? "6212",
        quantity: order.quantity,
        unitPrice,
        gstRate: Number(order.gstRate ?? 18),
      });
    }

    const customerName = pendingOrders[0]!.customerName;
    const customerEmail = pendingOrders[0]!.customerEmail;
    const totalSubunit = receiptLines.reduce((s, li) => s + li.totalAmountSubunit, 0);
    const orgName = org?.name ?? "Club Shop";
    await sendShopOrderReceiptEmail({
      email: customerEmail,
      buyerName: customerName,
      orderId: pendingOrders[0]!.id,
      lineItems: receiptLines,
      totalSubunit,
      currency: pendingOrders[0]!.currency || "INR",
      paymentId: settledPaymentRef,
      paidAt: new Date(),
      branding: { orgName, logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined },
    }).catch((e) => logger.warn({ err: e }, "[shop] verify-cart receipt email failed"));

    // Generate GST invoices (one per cart order for GSTR-1 accuracy, fire-and-forget)
    const gstSettings = await getOrgGstSettings(orgId);
    if (gstSettings) {
      // Derive buyer state code: prefer explicit stateCode, then resolve from state name
      const shippingAddr = pendingOrders[0]?.shippingAddress as
        { stateCode?: string; state?: string; line1?: string; city?: string; pincode?: string; country?: string } | null;
      const rawState = shippingAddr?.stateCode ?? shippingAddr?.state ?? "";
      const buyerStateCode = resolveIndianStateCode(rawState);
      const buyerAddress = shippingAddr
        ? [shippingAddr.line1, shippingAddr.city, shippingAddr.state, shippingAddr.pincode].filter(Boolean).join(", ")
        : "";

      for (let i = 0; i < pendingOrders.length; i++) {
        const order = pendingOrders[i]!;
        const item = lineItems[i];
        if (!item) continue;
        await createGstInvoice({
          organizationId: orgId,
          channel: "shop",
          shopOrderId: order.id,
          buyerName: customerName,
          buyerEmail: customerEmail,
          buyerGstin: order.buyerGstin ?? undefined,
          buyerAddress,
          buyerState: shippingAddr?.state ?? undefined,
          buyerStateCode,
          buyerCountry: shippingAddr?.country ?? undefined,
          sellerGstin: gstSettings.gstin ?? undefined,
          sellerName: gstSettings.sellerName ?? undefined,
          sellerAddress: gstSettings.sellerAddress ?? undefined,
          sellerState: gstSettings.sellerState ?? undefined,
          sellerStateCode: gstSettings.sellerStateCode ?? undefined,
          lineItems: [item],
        }).catch((e) => logger.warn({ err: e, orderId: order.id }, "[shop] GST invoice generation failed"));
      }
    }
  })().catch((e) => logger.warn({ err: e }, "[shop] post-verify-cart async block failed"));

  // Record FX ledger entry on settlement (one per cart for traceability).
  // Gated on `flippedShopOrders.length > 0` so concurrent verify-cart calls
  // (double-click on "Pay", SPA retry of the post-checkout redirect, etc.)
  // for the same Stripe session don't write two FX ledger rows for a single
  // payment. Only the request that actually flipped the order(s) to paid
  // records the settlement — mirrors the receipt + push gating above
  // (Task #1573, same race family as Task #1307).
  if (flippedShopOrders.length > 0) {
    try {
      const cartTotal = pendingOrders.reduce((s, o) => s + parseFloat(o.totalAmount), 0);
      const settlementCurrency = settledCurrencyFromProcessor || pendingOrders[0]!.currency;
      const settlementAmount = settledAmountMinorFromProcessor > 0
        ? settledAmountMinorFromProcessor / 100
        : cartTotal;
      await recordCheckoutSettlement({
        organizationId: orgId,
        processor: processorUsed,
        settledCurrency: settlementCurrency,
        settledAmount: settlementAmount,
        paymentRef: settledPaymentRef,
        sourceType: "shop_cart",
        sourceId: pendingOrders[0]!.id,
      });
    } catch (e) {
      logger.warn({ err: e }, "[shop] FX settlement recording failed");
    }
  }

  // In-app push to the buyer (Task #978 — Razorpay parity with the Stripe
  // notification path from Task #832). Razorpay branch only; Stripe push is
  // dispatched by the Stripe verify path / webhook. Status-flip guarded via
  // flippedShopOrders so concurrent re-verifies don't re-fire.
  if (processorUsed === "razorpay" && firstOrder && flippedShopOrders.length > 0) {
    try {
      const [org] = await db.select({ name: organizationsTable.name })
        .from(organizationsTable).where(eq(organizationsTable.id, orgId));
      const cartTotalMinor = settledAmountMinorFromProcessor > 0
        ? settledAmountMinorFromProcessor
        : Math.round(pendingOrders.reduce((s, o) => s + parseFloat(o.totalAmount), 0) * 100);
      await notifyPaymentSettled({
        userId: firstOrder.userId,
        kind: "shop",
        eventName: org?.name ?? "Club Shop",
        amountMinor: cartTotalMinor,
        currency: settledCurrencyFromProcessor || firstOrder.currency || "INR",
        paymentRef: settledPaymentRef,
        organizationId: orgId,
        entityId: firstOrder.id,
      });
    } catch (pushErr) {
      logger.warn({ err: pushErr, orderId: firstOrder.id }, "[shop/verify-cart] push failed");
    }
  }

  void track("shop_checkout_completed", {
    mode: "cart",
    orderIds,
    orderCount: orderIds.length,
    processor: processorUsed,
    paymentRef: settledPaymentRef,
    amountMinor: settledAmountMinorFromProcessor,
    currency: settledCurrencyFromProcessor || null,
  }, { organizationId: orgId, userId: authUser.id });

  res.json({ ok: true, orderIds, processor: processorUsed });
});

// POST /organizations/:orgId/shop/orders/:orderId/verify (single order - mobile compat)
router.post("/orders/:orderId/verify", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));

  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number; role?: string };

  const razorpayPaymentId: string | undefined = req.body.razorpayPaymentId ?? req.body.razorpay_payment_id;
  const razorpayOrderId: string | undefined = req.body.razorpayOrderId ?? req.body.razorpay_order_id;
  const razorpaySignature: string | undefined = req.body.razorpaySignature ?? req.body.razorpay_signature;
  const stripePaymentIntentId: string | undefined = req.body.stripePaymentIntentId ?? req.body.stripe_payment_intent_id;
  const stripeCheckoutSessionId: string | undefined = req.body.stripeCheckoutSessionId ?? req.body.stripe_checkout_session_id;

  const [order] = await db.select().from(shopOrdersTable)
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.organizationId, orgId)));
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }

  const isSuperAdmin = authUser.role === "super_admin";
  const authUserExt = authUser as { id: number; role?: string; organizationId?: number };
  const isOrgScopedAdmin =
    (authUser.role === "org_admin" || authUser.role === "tournament_director") &&
    Number(authUserExt.organizationId) === orgId;
  let isOrgAdmin = isSuperAdmin || isOrgScopedAdmin;
  if (!isOrgAdmin) {
    const [membership] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        eq(orgMembershipsTable.userId, authUser.id),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
      ));
    if (membership) isOrgAdmin = true;
  }
  if (!isOrgAdmin) {
    const [dbUser] = await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, authUser.id));
    const ownsOrder = order.userId === authUser.id || (dbUser?.email && order.customerEmail === dbUser.email);
    if (!ownsOrder) { { res.status(403).json({ error: "You do not have permission to verify this order" }); return; } }
  }

  if (order.status !== "pending") { { res.status(400).json({ error: "Order is not in pending state" }); return; } }

  let soSettledPaymentRef: string;
  let soSettledCurrency = "";
  let soSettledAmountMinor = 0;
  let soProcessor: "razorpay" | "stripe";

  if (stripePaymentIntentId || stripeCheckoutSessionId) {
    const expected = stripePaymentIntentId ?? stripeCheckoutSessionId;
    if (!order.razorpayOrderId || order.razorpayOrderId !== expected) {
      res.status(400).json({ error: "Order ID does not match this order's pending payment" }); return;
    }
    const v = await verifyCheckoutPayment({
      processor: "stripe",
      stripePaymentIntentId,
      stripeCheckoutSessionId,
    });
    if (!v.paid) { { res.status(400).json({ error: "Stripe payment not yet settled" }); return; } }
    soSettledPaymentRef = v.paymentRef;
    soSettledCurrency = v.currency;
    soSettledAmountMinor = v.amountMinor;
    soProcessor = "stripe";
  } else {
    if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
      res.status(400).json({ error: "razorpayPaymentId, razorpayOrderId and razorpaySignature are required (or Stripe equivalents)" }); return;
    }
    if (!order.razorpayOrderId || order.razorpayOrderId !== razorpayOrderId) {
      res.status(400).json({ error: "Razorpay order ID does not match this order" }); return;
    }
    const { verifyPaymentSignature } = await import("../lib/razorpay");
    if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      res.status(400).json({ error: "Payment signature verification failed" }); return;
    }
    soSettledPaymentRef = razorpayPaymentId;
    soProcessor = "razorpay";
  }

  // HARD GATE: Attempt loyalty deduction BEFORE marking order paid.
  // If deduction fails (concurrent redemption race), reject verification
  // to preserve financial integrity — the discounted amount must not be
  // collected without the corresponding point deduction.
  let soLoyaltyAccount: { id: number } | null = null;
  let soLoyaltyNewBalance: number | null = null;
  if (order.loyaltyPointsRedeemed && order.loyaltyPointsRedeemed > 0 && order.userId) {
    const [existingAccount] = await db.select().from(loyaltyAccountsTable)
      .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, order.userId)));
    if (existingAccount) {
      const alreadyDeducted = await db.select({ id: loyaltyTransactionsTable.id })
        .from(loyaltyTransactionsTable)
        .where(and(
          eq(loyaltyTransactionsTable.accountId, existingAccount.id),
          eq(loyaltyTransactionsTable.referenceId, `shop:${order.id}`),
        ));
      if (alreadyDeducted.length === 0) {
        const deductResult = await db.execute(
          sql`UPDATE loyalty_accounts
              SET points_balance = points_balance - ${order.loyaltyPointsRedeemed},
                  updated_at = NOW()
              WHERE id = ${existingAccount.id} AND points_balance >= ${order.loyaltyPointsRedeemed}
              RETURNING id, points_balance`
        );
        if ((deductResult.rows as unknown[]).length === 0) {
          res.status(409).json({
            error: "Your loyalty points have already been redeemed by a concurrent checkout. Please contact support.",
          });
          return;
        }
        soLoyaltyAccount = existingAccount;
        soLoyaltyNewBalance = parseInt(String((deductResult.rows as Record<string, unknown>[])[0].points_balance ?? 0));
      }
      // else: already deducted (idempotent re-verify), nothing to do
    } else {
      // Loyalty account expected but not found — block payment to protect discount integrity
      res.status(409).json({
        error: "Loyalty account not found. Cannot complete checkout with loyalty redemption. Please contact support.",
      });
      return;
    }
  }

  // Loyalty gate passed — now mark order paid and deduct stock.
  // Status-flip guard for Task #978 (push must fire exactly once on the
  // pending → paid transition, even on concurrent re-verifies).
  const flippedSingleOrder = await db.update(shopOrdersTable)
    .set({
      razorpayPaymentId: soSettledPaymentRef,
      paymentMode: soProcessor,
      status: "paid",
      updatedAt: new Date(),
    })
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.status, "pending")))
    .returning({ id: shopOrdersTable.id });

  if (order.variantId) {
    await db.update(shopProductVariantsTable)
      .set({ stockQty: sql`${shopProductVariantsTable.stockQty} - ${order.quantity}`, updatedAt: new Date() })
      .where(eq(shopProductVariantsTable.id, order.variantId));

    // Resolve fulfillment location (request body locationId → org default)
    const verifySingleReqLocId: number | undefined = req.body.locationId ? parseInt(String(req.body.locationId)) : undefined;
    let verifySingleLocId: number | null = null;
    if (verifySingleReqLocId) {
      const [reqLoc] = await db.select({ id: shopLocationsTable.id })
        .from(shopLocationsTable)
        .where(and(eq(shopLocationsTable.id, verifySingleReqLocId), eq(shopLocationsTable.organizationId, orgId)));
      verifySingleLocId = reqLoc?.id ?? null;
    }
    if (!verifySingleLocId) {
      const [defaultLoc] = await db.select({ id: shopLocationsTable.id })
        .from(shopLocationsTable)
        .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isDefault, true)));
      verifySingleLocId = defaultLoc?.id ?? null;
    }
    if (verifySingleLocId) {
      // Ensure row exists, then deduct — allow negative stock to keep ledger consistent.
      await db.insert(shopVariantStockTable)
        .values({ variantId: order.variantId, locationId: verifySingleLocId, quantity: 0 })
        .onConflictDoNothing();
      await db.update(shopVariantStockTable)
        .set({ quantity: sql`${shopVariantStockTable.quantity} - ${order.quantity}`, updatedAt: new Date() })
        .where(and(eq(shopVariantStockTable.variantId, order.variantId), eq(shopVariantStockTable.locationId, verifySingleLocId)));
      await db.insert(shopStockAdjustmentsTable).values({
        organizationId: orgId,
        variantId: order.variantId,
        locationId: verifySingleLocId,
        qtyDelta: -order.quantity,
        type: "sale",
        reason: `Online Razorpay order #${orderId}`,
        referenceId: String(orderId),
      }).catch(() => {});
    }
  }

  // Post-payment: record promo/affiliate redemptions and log loyalty transaction
  // Promo redemption
  if (order.promoCode) {
    const breakdown = (order.discountBreakdown ?? []) as Array<{ type: string; amount: number }>;
    const promoEntry = breakdown.find(d => d.type === "promo");
    if (promoEntry && promoEntry.amount > 0) {
      const [promo] = await db.select({ id: promotionsTable.id })
        .from(promotionsTable)
        .where(and(eq(promotionsTable.organizationId, orgId), eq(promotionsTable.code, (order.promoCode ?? "").toUpperCase())));
      if (promo) {
        const existing = await db.select({ id: promotionRedemptionsTable.id })
          .from(promotionRedemptionsTable)
          .where(and(eq(promotionRedemptionsTable.promotionId, promo.id), eq(promotionRedemptionsTable.orderId, order.id)));
        if (existing.length === 0) {
          await db.update(promotionsTable)
            .set({ usedCount: sql`${promotionsTable.usedCount} + 1`, updatedAt: new Date() })
            .where(eq(promotionsTable.id, promo.id));
          await db.insert(promotionRedemptionsTable).values({
            promotionId: promo.id,
            organizationId: orgId,
            orderId: order.id,
            userId: order.userId ?? null,
            discountAmount: String(promoEntry.amount),
          });
        }
      }
    }
  }

  // Affiliate redemption
  if (order.affiliateCode) {
    const breakdown = (order.discountBreakdown ?? []) as Array<{ type: string; amount: number; commission?: number }>;
    const affEntry = breakdown.find(d => d.type === "affiliate");
    if (affEntry && affEntry.amount > 0) {
      const [aff] = await db.select().from(affiliateCodesTable)
        .where(and(eq(affiliateCodesTable.organizationId, orgId), eq(affiliateCodesTable.code, (order.affiliateCode ?? "").toUpperCase())));
      if (aff) {
        const existing = await db.select({ id: affiliateRedemptionsTable.id })
          .from(affiliateRedemptionsTable)
          .where(and(eq(affiliateRedemptionsTable.affiliateCodeId, aff.id), eq(affiliateRedemptionsTable.orderId, order.id)));
        if (existing.length === 0) {
          const affDiscount = affEntry.amount;
          const commission = affEntry.commission ?? 0;
          await db.update(affiliateCodesTable).set({
            totalOrders: sql`${affiliateCodesTable.totalOrders} + 1`,
            totalDiscountGiven: sql`${affiliateCodesTable.totalDiscountGiven} + ${String(affDiscount)}`,
            totalCommissionEarned: sql`${affiliateCodesTable.totalCommissionEarned} + ${String(commission)}`,
            updatedAt: new Date(),
          }).where(eq(affiliateCodesTable.id, aff.id));
          await db.insert(affiliateRedemptionsTable).values({
            affiliateCodeId: aff.id,
            organizationId: orgId,
            orderId: order.id,
            userId: order.userId ?? null,
            orderAmount: String(parseFloat(order.totalAmount).toFixed(2)),
            discountAmount: String(affDiscount),
            commissionAmount: String(commission),
          });
        }
      }
    }
  }

  // Log loyalty transaction for successful deduction performed by hard gate above
  if (soLoyaltyAccount && soLoyaltyNewBalance !== null && order.loyaltyPointsRedeemed && order.userId) {
    await db.insert(loyaltyTransactionsTable).values({
      accountId: soLoyaltyAccount.id,
      organizationId: orgId,
      userId: order.userId,
      type: "redeem",
      points: -order.loyaltyPointsRedeemed,
      balanceAfter: soLoyaltyNewBalance,
      serviceCategory: "pos",
      referenceId: `shop:${order.id}`,
      description: `Redeemed at checkout (order #${order.id})`,
    });
  }

  const [product] = await db.select().from(shopProductsTable).where(eq(shopProductsTable.id, order.productId));
  const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  {
    const sizeLabel = order.size ? ` (${order.size})` : "";
    const productLabel = product?.name ?? "Merchandise";
    const totalSubunit = Math.round(parseFloat(String(order.totalAmount ?? "0")) * 100);
    const orgName = org?.name ?? "Club Shop";
    await sendShopOrderReceiptEmail({
      email: order.customerEmail,
      buyerName: order.customerName,
      orderId: order.id,
      lineItems: [{
        description: `${productLabel}${sizeLabel}`,
        quantity: order.quantity,
        totalAmountSubunit: totalSubunit,
      }],
      totalSubunit,
      currency: order.currency || "INR",
      paymentId: soSettledPaymentRef,
      paidAt: new Date(),
      branding: { orgName, logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined },
    }).catch((e) => logger.warn({ err: e, orderId: order.id }, "[shop] single-order receipt email failed"));
  }

  // Generate GST invoice (fire-and-forget)
  ;(async () => {
    const gstSettings = await getOrgGstSettings(orgId).catch(() => null);
    if (gstSettings && product) {
      const shippingAddr = order.shippingAddress as
        { stateCode?: string; state?: string; line1?: string; city?: string; pincode?: string; country?: string } | null;
      const rawState = shippingAddr?.stateCode ?? shippingAddr?.state ?? "";
      const buyerStateCode = resolveIndianStateCode(rawState);
      const buyerAddress = shippingAddr
        ? [shippingAddr.line1, shippingAddr.city, shippingAddr.state, shippingAddr.pincode].filter(Boolean).join(", ")
        : "";
      await createGstInvoice({
        organizationId: orgId,
        channel: "shop",
        shopOrderId: order.id,
        buyerName: order.customerName,
        buyerEmail: order.customerEmail,
        buyerGstin: order.buyerGstin ?? undefined,
        buyerAddress,
        buyerState: shippingAddr?.state ?? undefined,
        buyerStateCode,
        buyerCountry: shippingAddr?.country ?? undefined,
        sellerGstin: gstSettings.gstin ?? undefined,
        sellerName: gstSettings.sellerName ?? undefined,
        sellerAddress: gstSettings.sellerAddress ?? undefined,
        sellerState: gstSettings.sellerState ?? undefined,
        sellerStateCode: gstSettings.sellerStateCode ?? undefined,
        lineItems: [{
          description: product.name,
          hsnSacCode: product.hsnCode ?? undefined,
          quantity: order.quantity,
          unitPrice: order.unitPrice != null
            ? parseFloat(String(order.unitPrice))
            : parseFloat(String(order.totalAmount ?? 0)) / order.quantity,
          gstRate: Number(product.gstRate ?? 18),
        }],
      }).catch((e) => logger.warn({ err: e, orderId: order.id }, "[shop] GST invoice generation failed — single-order verify"));
    }
  })().catch((e) => logger.warn({ err: e }, "[shop] post-single-order-verify async block failed"));

  // FX ledger entry on settlement. Status-flip guarded (Task #1955) so
  // concurrent single-order re-verifies for the same payment can't write
  // two FX ledger rows — same race-condition family as Task #1573 fixed
  // for the verify-cart endpoint.
  if (flippedSingleOrder.length > 0) {
    try {
      const settlementCurrency = soSettledCurrency || order.currency;
      const settlementAmount = soSettledAmountMinor > 0
        ? soSettledAmountMinor / 100
        : parseFloat(order.totalAmount);
      await recordCheckoutSettlement({
        organizationId: orgId,
        processor: soProcessor,
        settledCurrency: settlementCurrency,
        settledAmount: settlementAmount,
        paymentRef: soSettledPaymentRef,
        sourceType: "shop_order",
        sourceId: order.id,
      });
    } catch (e) {
      logger.warn({ err: e }, "[shop] FX settlement recording failed (single order)");
    }
  }

  // In-app push to the buyer (Task #978 — Razorpay parity for the
  // single-order verify endpoint). Razorpay branch only; status-flip
  // guarded so concurrent re-verifies don't re-fire.
  if (soProcessor === "razorpay" && flippedSingleOrder.length > 0) {
    try {
      const amtMinor = soSettledAmountMinor > 0
        ? soSettledAmountMinor
        : Math.round(parseFloat(order.totalAmount) * 100);
      await notifyPaymentSettled({
        userId: order.userId,
        kind: "shop",
        eventName: org?.name ?? "Club Shop",
        amountMinor: amtMinor,
        currency: soSettledCurrency || order.currency || "INR",
        paymentRef: soSettledPaymentRef,
        organizationId: orgId,
        entityId: order.id,
      });
    } catch (pushErr) {
      logger.warn({ err: pushErr, orderId: order.id }, "[shop/verify] single-order push failed");
    }
  }

  void track("shop_checkout_completed", {
    mode: "single",
    orderId,
    processor: soProcessor,
    paymentRef: soSettledPaymentRef,
    amountMinor: soSettledAmountMinor,
    currency: soSettledCurrency || order.currency || null,
  }, { organizationId: orgId, userId: authUser.id });

  res.json({ ok: true, orderId, processor: soProcessor, discountBreakdown: order.discountBreakdown, discountTotal: order.discountTotal });
});

// POST /organizations/:orgId/shop/orders/:orderId/cancel
router.post("/orders/:orderId/cancel", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  if (isNaN(orgId) || isNaN(orderId)) { { res.status(400).json({ error: "Invalid params" }); return; } }

  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number; role?: string; organizationId?: number };

  // Determine if caller is an admin (without sending premature responses)
  let isAdmin = authUser.role === "super_admin";
  if (!isAdmin && (authUser.role === "org_admin" || authUser.role === "tournament_director") && Number(authUser.organizationId) === orgId) {
    isAdmin = true;
  }
  if (!isAdmin) {
    const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        eq(orgMembershipsTable.userId, authUser.id),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
      ));
    if (m) isAdmin = true;
  }

  const [order] = await db.select().from(shopOrdersTable)
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.organizationId, orgId)));
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }

  if (isAdmin) {
    // Admin can cancel any non-final order
    if (["delivered", "cancelled", "refunded"].includes(order.status)) {
      res.status(400).json({ error: "Order is already in a final state" }); return;
    }
  } else {
    // Customer can only cancel their own pending/cod_pending orders
    if (order.userId !== authUser.id) { { res.status(403).json({ error: "Not your order" }); return; } }
    if (!["pending", "cod_pending"].includes(order.status)) {
      res.status(400).json({ error: "Only pending orders can be cancelled by the customer" }); return;
    }
  }

  await db.update(shopOrdersTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(shopOrdersTable.id, orderId));

  // Restore variant stock only when stock was actually decremented.
  // Rules by payment mode and status:
  //   COD orders:     stock decremented at creation (cod_pending).
  //                   Restoring on any cancel of cod_pending, processing, or shipped.
  //   Razorpay orders: stock decremented at payment verify (transitions to paid).
  //                   "pending" = not yet verified, no decrement → do NOT restore.
  //                   Restoring on cancel of paid, processing, or shipped.
  const pm: string = order.paymentMode ?? "razorpay";
  const stockWasDecremented =
    (pm === "cod" && ["cod_pending", "processing", "shipped"].includes(order.status)) ||
    (pm !== "cod" && ["paid", "processing", "shipped"].includes(order.status));

  if (order.variantId && stockWasDecremented) {
    await db.update(shopProductVariantsTable)
      .set({ stockQty: sql`${shopProductVariantsTable.stockQty} + ${order.quantity}`, updatedAt: new Date() })
      .where(eq(shopProductVariantsTable.id, order.variantId));

    // Restore per-location stock: find the original sale adjustment(s) via referenceId
    const saleAdjustments = await db.select()
      .from(shopStockAdjustmentsTable)
      .where(and(
        eq(shopStockAdjustmentsTable.referenceId, String(orderId)),
        eq(shopStockAdjustmentsTable.type, "sale"),
        eq(shopStockAdjustmentsTable.variantId, order.variantId),
      ));
    for (const adj of saleAdjustments) {
      if (adj.locationId) {
        const restoreQty = Math.abs(adj.qtyDelta);
        await db.insert(shopVariantStockTable)
          .values({ variantId: order.variantId, locationId: adj.locationId, quantity: 0 })
          .onConflictDoNothing();
        await db.update(shopVariantStockTable)
          .set({ quantity: sql`${shopVariantStockTable.quantity} + ${restoreQty}`, updatedAt: new Date() })
          .where(and(eq(shopVariantStockTable.variantId, order.variantId), eq(shopVariantStockTable.locationId, adj.locationId)));
        await db.insert(shopStockAdjustmentsTable).values({
          organizationId: orgId,
          variantId: order.variantId,
          locationId: adj.locationId,
          qtyDelta: restoreQty,
          type: "cancellation",
          reason: `Cancelled order #${orderId} — stock restored`,
          referenceId: String(orderId),
        }).catch(() => {});
      }
    }
    // If no adjustment records found (legacy orders), fall back to org default location restoration
    if (saleAdjustments.length === 0) {
      const [defaultLoc] = await db.select({ id: shopLocationsTable.id })
        .from(shopLocationsTable)
        .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isDefault, true)));
      if (defaultLoc) {
        await db.insert(shopVariantStockTable)
          .values({ variantId: order.variantId, locationId: defaultLoc.id, quantity: 0 })
          .onConflictDoNothing();
        await db.update(shopVariantStockTable)
          .set({ quantity: sql`${shopVariantStockTable.quantity} + ${order.quantity}`, updatedAt: new Date() })
          .where(and(eq(shopVariantStockTable.variantId, order.variantId), eq(shopVariantStockTable.locationId, defaultLoc.id)));
        await db.insert(shopStockAdjustmentsTable).values({
          organizationId: orgId,
          variantId: order.variantId,
          locationId: defaultLoc.id,
          qtyDelta: order.quantity,
          type: "cancellation",
          reason: `Cancelled order #${orderId} — stock restored (legacy)`,
          referenceId: String(orderId),
        }).catch(() => {});
      }
    }
  }

  res.json({ ok: true });
});

// POST /organizations/:orgId/shop/orders/:orderId/shiprocket (admin — create shipment)
router.post("/orders/:orderId/shiprocket", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [order] = await db.select().from(shopOrdersTable)
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.organizationId, orgId)));
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }
  if (!["cod_pending", "paid", "processing"].includes(order.status)) {
    res.status(400).json({ error: "Order must be confirmed (COD pending, paid, or processing) to create a shipment" }); return;
  }

  const [storeSettings] = await db.select().from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));
  if (!storeSettings?.shiprocketEmail || !storeSettings?.shiprocketPassword) {
    res.status(400).json({ error: "Shiprocket credentials not configured in store settings" }); return;
  }

  const [product] = await db.select().from(shopProductsTable).where(eq(shopProductsTable.id, order.productId));

  let token = storeSettings.shiprocketToken;
  const tokenExpired = !token || !storeSettings.shiprocketTokenExpiry || new Date() > new Date(storeSettings.shiprocketTokenExpiry);

  if (tokenExpired) {
    const loginRes = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: storeSettings.shiprocketEmail, password: storeSettings.shiprocketPassword }),
    });
    if (!loginRes.ok) {
      const err = await loginRes.json() as { message?: string };
      res.status(502).json({ error: `Shiprocket login failed: ${err.message ?? "Unknown error"}` }); return;
    }
    const loginData = await loginRes.json() as { token: string };
    token = loginData.token;
    const expiry = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    await db.update(shopStoreSettingsTable)
      .set({ shiprocketToken: token, shiprocketTokenExpiry: expiry, updatedAt: new Date() })
      .where(eq(shopStoreSettingsTable.organizationId, orgId));
  }

  const addr = order.shippingAddress as { line1: string; line2?: string; city: string; state: string; pincode: string; country: string } | null;
  if (!addr) { { res.status(400).json({ error: "Order has no shipping address" }); return; } }

  const nameParts = order.customerName.trim().split(/\s+/);
  const orderPayload = {
    order_id: `KG-${orderId}-${Date.now()}`,
    order_date: new Date().toISOString().split("T")[0],
    pickup_location: storeSettings.sellerName ?? "Primary",
    channel_id: "",
    comment: `Order #${orderId}`,
    billing_customer_name: nameParts[0] ?? order.customerName,
    billing_last_name: nameParts.slice(1).join(" ") || "-",
    billing_address: addr.line1,
    billing_address_2: addr.line2 ?? "",
    billing_city: addr.city,
    billing_pincode: addr.pincode,
    billing_state: addr.state,
    billing_country: addr.country ?? "India",
    billing_email: order.customerEmail,
    billing_phone: order.customerPhone ?? "",
    shipping_is_billing: true,
    order_items: [{
      name: product?.name ?? `Item #${order.productId}`,
      sku: `SKU-${order.productId}${order.size ? `-${order.size}` : ""}`,
      units: order.quantity,
      selling_price: parseFloat(order.unitPrice),
      discount: 0,
      tax: 0,
      hsn: product?.hsnCode ?? "",
    }],
    payment_method: order.paymentMode === "cod" ? "COD" : "Prepaid",
    shipping_charges: 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: parseFloat(order.totalAmount),
    length: 10, breadth: 10, height: 10, weight: 0.5,
  };

  const createRes = await fetch("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(orderPayload),
  });

  if (!createRes.ok) {
    const errData = await createRes.json() as { message?: string };
    res.status(502).json({ error: `Shiprocket order creation failed: ${errData.message ?? "Unknown error"}` }); return;
  }

  const srData = await createRes.json() as {
    order_id: number; shipment_id: number; awb_code?: string; tracking_url?: string;
  };

  const awbCode = srData.awb_code ?? null;
  await db.update(shopOrdersTable)
    .set({
      shiprocketOrderId: String(srData.order_id),
      awbCode,
      trackingNumber: awbCode,
      trackingUrl: srData.tracking_url ?? null,
      status: "processing",
      updatedAt: new Date(),
    })
    .where(eq(shopOrdersTable.id, orderId));

  res.json({ ok: true, shiprocketOrderId: srData.order_id, awbCode, trackingNumber: awbCode, trackingUrl: srData.tracking_url });
});

// GET /organizations/:orgId/shop/orders/:orderId/invoice — generate/retrieve GST invoice PDF
router.get("/orders/:orderId/invoice", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  if (isNaN(orgId) || isNaN(orderId)) { { res.status(400).json({ error: "Invalid params" }); return; } }

  const isAdmin = req.isAuthenticated() && await (async () => {
    const user = req.user as { id: number; role?: string };
    if (user.role === "super_admin") return true;
    const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id), inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"])));
    return !!m;
  })();

  const [order] = await db.select().from(shopOrdersTable)
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.organizationId, orgId)));
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }

  if (!isAdmin && req.isAuthenticated()) {
    const authUser = req.user as { id: number };
    if (order.userId !== authUser.id) { { res.status(403).json({ error: "Access denied" }); return; } }
  } else if (!isAdmin) {
    res.status(401).json({ error: "Authentication required" }); return;
  }

  const confirmedStatuses = ["paid", "processing", "shipped", "delivered"];
  const codConfirmedStatuses = ["cod_pending", "processing", "shipped", "delivered"];
  const isConfirmedOrder =
    confirmedStatuses.includes(order.status) ||
    (order.paymentMode === "cod" && codConfirmedStatuses.includes(order.status));
  if (!isConfirmedOrder) {
    res.status(400).json({ error: "Invoice only available for confirmed, non-cancelled orders" }); return;
  }

  const [product] = await db.select().from(shopProductsTable).where(eq(shopProductsTable.id, order.productId));
  const [storeSettings] = await db.select().from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));
  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const sellerGstin = order.sellerGstin ?? storeSettings?.gstin ?? "";
  const sellerName = storeSettings?.sellerName ?? org?.name ?? "Club";
  const sellerAddress = storeSettings?.sellerAddress ?? org?.address ?? "";
  const sellerState = storeSettings?.sellerState ?? "";
  const sellerStateCode = storeSettings?.sellerStateCode ?? "29";
  const buyerState = (order.shippingAddress as { state?: string } | null)?.state ?? "";
  const isIntraState = buyerState.toLowerCase() === sellerState.toLowerCase();

  const gstRate = parseFloat(order.gstRate ?? product?.gstRate ?? "18");
  const grandTotal = parseFloat(order.totalAmount); // total for all units, tax-inclusive
  const qty = order.quantity ?? 1;
  const unitTotal = grandTotal / qty; // per-unit, tax-inclusive
  const unitBase = unitTotal / (1 + gstRate / 100); // per-unit, tax-exclusive
  const unitGst = unitTotal - unitBase; // per-unit GST
  const totalBase = unitBase * qty; // all-units base (tax-exclusive)
  const totalGst = unitGst * qty; // all-units GST

  const doc = new PDFDocument({ margin: 50, size: "A4" });
  const buffers: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => buffers.push(chunk));

  await new Promise<void>(resolve => {
    doc.on("end", resolve);

    doc.fontSize(18).font("Helvetica-Bold").text("TAX INVOICE", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica").text(`Invoice No: INV-${orderId}`, { align: "right" });
    doc.text(`Date: ${new Date(order.createdAt).toLocaleDateString("en-IN")}`, { align: "right" });
    doc.moveDown();

    doc.font("Helvetica-Bold").text("Seller:");
    doc.font("Helvetica").text(sellerName);
    doc.text(sellerAddress);
    doc.text(`State: ${sellerState} (${sellerStateCode})`);
    if (sellerGstin) doc.text(`GSTIN: ${sellerGstin}`);
    doc.moveDown();

    doc.font("Helvetica-Bold").text("Buyer:");
    doc.font("Helvetica").text(order.customerName);
    doc.text(order.customerEmail);
    if (order.customerPhone) doc.text(order.customerPhone);
    const addr = order.shippingAddress as { line1: string; line2?: string; city: string; state: string; pincode: string } | null;
    if (addr) doc.text(`${addr.line1}${addr.line2 ? ", " + addr.line2 : ""}, ${addr.city}, ${addr.state} - ${addr.pincode}`);
    if (order.buyerGstin) doc.text(`GSTIN: ${order.buyerGstin}`);
    doc.moveDown();

    doc.font("Helvetica-Bold").text("Order Details:");
    doc.font("Helvetica");
    doc.text(`Order ID: #${orderId}`);
    doc.text(`Payment Mode: ${order.paymentMode === "cod" ? "Cash on Delivery" : "Online Payment"}`);
    if (order.awbCode) doc.text(`AWB Code: ${order.awbCode}`);
    doc.moveDown();

    const tableTop = doc.y;
    const col = [50, 200, 280, 350, 420, 490];
    doc.font("Helvetica-Bold");
    doc.text("Product", col[0]!, tableTop);
    doc.text("HSN", col[1]!, tableTop);
    doc.text("Qty", col[2]!, tableTop);
    doc.text("Unit Price", col[3]!, tableTop);
    doc.text("GST%", col[4]!, tableTop);
    doc.text("Total", col[5]!, tableTop);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica");
    const rowY = doc.y;
    const productName = product?.name ?? `Item #${order.productId}`;
    const variantLabel = [order.size, order.color].filter(Boolean).join("/");
    doc.text(`${productName}${variantLabel ? ` (${variantLabel})` : ""}`, col[0]!, rowY);
    doc.text(order.hsnCode ?? product?.hsnCode ?? "-", col[1]!, rowY);
    doc.text(String(qty), col[2]!, rowY);
    doc.text(`₹${unitBase.toFixed(2)}`, col[3]!, rowY);
    doc.text(`${gstRate}%`, col[4]!, rowY);
    doc.text(`₹${grandTotal.toFixed(2)}`, col[5]!, rowY);
    doc.moveDown(1.5);

    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold");
    doc.text("Tax Summary:", col[0]!);
    doc.font("Helvetica");
    doc.text(`Taxable Amount: ₹${totalBase.toFixed(2)}`);
    if (isIntraState) {
      const half = totalGst / 2;
      doc.text(`CGST @ ${gstRate / 2}%: ₹${half.toFixed(2)}`);
      doc.text(`SGST @ ${gstRate / 2}%: ₹${half.toFixed(2)}`);
    } else {
      doc.text(`IGST @ ${gstRate}%: ₹${totalGst.toFixed(2)}`);
    }
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text(`Grand Total: ₹${grandTotal.toFixed(2)}`, { align: "right" });
    doc.moveDown();
    doc.font("Helvetica").fontSize(9).text("This is a computer generated invoice.", { align: "center" });

    doc.end();
  });

  const pdfBuffer = Buffer.concat(buffers);

  try {
    const privateDir = process.env.PRIVATE_OBJECT_DIR;
    if (privateDir) {
      const invoiceKey = `invoices/org-${orgId}/order-${orderId}.pdf`;
      const fullPath = `${privateDir}/${invoiceKey}`;
      const [bucketName, ...rest] = fullPath.replace("gs://", "").split("/");
      const objectName = rest.join("/");
      const file = objectStorageClient.bucket(bucketName!).file(objectName);
      await file.save(pdfBuffer, { contentType: "application/pdf", resumable: false });
      await db.update(shopOrdersTable).set({ invoicePath: fullPath }).where(eq(shopOrdersTable.id, orderId));
    }
  } catch {
    // non-fatal: serve directly even if storage fails
  }

  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", `attachment; filename="invoice-${orderId}.pdf"`);
  res.send(pdfBuffer);
});

// PATCH /organizations/:orgId/shop/orders/:orderId — update tracking info (admin)
router.patch("/orders/:orderId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { trackingNumber, trackingUrl, awbCode, status } = req.body;

  const [existingOrder] = await db.select().from(shopOrdersTable)
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.organizationId, orgId)));
  if (!existingOrder) { { res.status(404).json({ error: "Order not found" }); return; } }

  const [order] = await db.update(shopOrdersTable)
    .set({ trackingNumber, trackingUrl, awbCode, status, updatedAt: new Date() })
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.organizationId, orgId)))
    .returning();
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }

  if (status === "cancelled" && existingOrder.status !== "cancelled" && existingOrder.variantId) {
    const wasStockDecremented = ["paid", "processing", "shipped", "cod_pending"].includes(existingOrder.status);
    if (wasStockDecremented) {
      await db.update(shopProductVariantsTable)
        .set({ stockQty: sql`${shopProductVariantsTable.stockQty} + ${existingOrder.quantity}`, updatedAt: new Date() })
        .where(eq(shopProductVariantsTable.id, existingOrder.variantId));
    }
  }

  if (trackingNumber && order.customerEmail) {
    const parts = order.customerName.trim().split(/\s+/);
    await sendBroadcast(
      [{ firstName: parts[0] ?? order.customerName, lastName: parts.slice(1).join(" ") || "-", email: order.customerEmail }],
      {
        channels: ["email"],
        subject: "Your Order Has Shipped!",
        body: `Hi ${order.customerName},\n\nYour merchandise order has shipped!\n\nTracking: ${trackingNumber}${trackingUrl ? `\nTrack here: ${trackingUrl}` : ""}\n\nThank you!`,
        eventName: "Club Shop",
        // Task #1566 — tag tracking-update emails with the originating
        // club so the Postmark bounce webhook (Task #981) can attribute
        // hard bounces back to this org instantly.
        organizationId: orgId,
      },
    ).catch(() => {});
  }

  if (status === "shipped" || status === "delivered") {
    await enqueueReviewPrompt(order);
  }

  res.json(order);
});

// ─── SHOP SETTINGS ────────────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/settings
router.get("/settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const [org] = await db.select({ shopReviewModerationEnabled: organizationsTable.shopReviewModerationEnabled })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  res.json({ reviewModerationEnabled: org.shopReviewModerationEnabled });
});

// PATCH /organizations/:orgId/shop/settings
router.patch("/settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!(await requireOrgAdmin(req, res, orgId))) return;

  const { reviewModerationEnabled } = req.body;
  if (typeof reviewModerationEnabled !== "boolean") {
    res.status(400).json({ error: "reviewModerationEnabled must be a boolean" }); return;
  }

  await db.update(organizationsTable)
    .set({ shopReviewModerationEnabled: reviewModerationEnabled, updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId));

  res.json({ reviewModerationEnabled });
});

// GET /organizations/:orgId/shop/review-aggregates
router.get("/review-aggregates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const rows = await db
    .select({
      productId: shopReviewsTable.productId,
      avgRating: avg(shopReviewsTable.rating),
      totalCount: count(shopReviewsTable.id),
    })
    .from(shopReviewsTable)
    .where(and(eq(shopReviewsTable.organizationId, orgId), eq(shopReviewsTable.isApproved, true)))
    .groupBy(shopReviewsTable.productId);

  const result: Record<number, { avgRating: number; totalCount: number }> = {};
  for (const row of rows) {
    result[row.productId] = {
      avgRating: row.avgRating ? parseFloat(String(row.avgRating)) : 0,
      totalCount: Number(row.totalCount),
    };
  }
  res.json(result);
});

// ─── WISHLIST ─────────────────────────────────────────────────────────────────

router.get("/wishlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  const rows = await db
    .select({
      wishlistId: shopWishlistTable.id,
      createdAt: shopWishlistTable.createdAt,
      product: {
        id: shopProductsTable.id,
        name: shopProductsTable.name,
        description: shopProductsTable.description,
        imageUrl: shopProductsTable.imageUrl,
        category: shopProductsTable.category,
        markupPrice: shopProductsTable.markupPrice,
        currency: shopProductsTable.currency,
        sizes: shopProductsTable.sizes,
        isActive: shopProductsTable.isActive,
        hsnCode: shopProductsTable.hsnCode,
        gstRate: shopProductsTable.gstRate,
      },
    })
    .from(shopWishlistTable)
    .innerJoin(shopProductsTable, eq(shopWishlistTable.productId, shopProductsTable.id))
    .where(and(eq(shopWishlistTable.userId, authUser.id), eq(shopProductsTable.organizationId, orgId), eq(shopProductsTable.isActive, true)))
    .orderBy(desc(shopWishlistTable.createdAt));

  res.json(rows);
});

router.post("/wishlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  const { productId } = req.body;
  if (!productId) { { res.status(400).json({ error: "productId is required" }); return; } }

  const [product] = await db.select().from(shopProductsTable)
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }

  const [entry] = await db.insert(shopWishlistTable)
    .values({ userId: authUser.id, productId })
    .onConflictDoNothing({ target: [shopWishlistTable.userId, shopWishlistTable.productId] })
    .returning();

  const wishlistId = entry?.id ?? null;
  const existing = !entry;
  res.status(existing ? 200 : 201).json({ wishlistId, createdAt: entry?.createdAt ?? new Date().toISOString(), product, existing });
});

router.delete("/wishlist/:productId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (isNaN(orgId) || isNaN(productId)) { { res.status(400).json({ error: "Invalid orgId or productId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  const orgProductIds = db.select({ id: shopProductsTable.id }).from(shopProductsTable)
    .where(eq(shopProductsTable.organizationId, orgId));

  await db.delete(shopWishlistTable)
    .where(and(
      eq(shopWishlistTable.userId, authUser.id),
      eq(shopWishlistTable.productId, productId),
      inArray(shopWishlistTable.productId, orgProductIds),
    ));

  res.json({ ok: true });
});

router.get("/wishlist/ids", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  const rows = await db
    .select({ productId: shopWishlistTable.productId })
    .from(shopWishlistTable)
    .innerJoin(shopProductsTable, eq(shopWishlistTable.productId, shopProductsTable.id))
    .where(and(eq(shopWishlistTable.userId, authUser.id), eq(shopProductsTable.organizationId, orgId)));

  res.json(rows.map(r => r.productId));
});

// ─── REVIEWS ─────────────────────────────────────────────────────────────────

router.get("/products/:productId/reviews/can-review", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (isNaN(orgId) || isNaN(productId)) { { res.status(400).json({ error: "Invalid orgId or productId" }); return; } }
  if (!req.isAuthenticated()) { { res.json({ canReview: false, reason: "not_authenticated" }); return; } }
  const authUser = req.user as { id: number };

  const [existing] = await db.select({ id: shopReviewsTable.id }).from(shopReviewsTable)
    .where(and(eq(shopReviewsTable.productId, productId), eq(shopReviewsTable.organizationId, orgId), eq(shopReviewsTable.userId, authUser.id)));
  if (existing) { { res.json({ canReview: false, reason: "already_reviewed" }); return; } }

  const [eligibleOrder] = await db.select({ id: shopOrdersTable.id }).from(shopOrdersTable)
    .where(and(
      eq(shopOrdersTable.productId, productId),
      eq(shopOrdersTable.organizationId, orgId),
      eq(shopOrdersTable.userId, authUser.id),
      sql`${shopOrdersTable.status} IN ('shipped', 'delivered')`,
    ));

  if (!eligibleOrder) { { res.json({ canReview: false, reason: "no_qualifying_order" }); return; } }
  res.json({ canReview: true });
});

router.get("/products/:productId/reviews", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (isNaN(orgId) || isNaN(productId)) { { res.status(400).json({ error: "Invalid orgId or productId" }); return; } }

  const page = parseInt(String(req.query.page ?? "1")) || 1;
  const limit = Math.min(parseInt(String(req.query.limit ?? "10")) || 10, 50);
  const offset = (page - 1) * limit;

  const [aggRow] = await db.select({ avgRating: avg(shopReviewsTable.rating), totalCount: count(shopReviewsTable.id) })
    .from(shopReviewsTable)
    .where(and(eq(shopReviewsTable.productId, productId), eq(shopReviewsTable.organizationId, orgId), eq(shopReviewsTable.isApproved, true)));

  const reviews = await db.select({
    id: shopReviewsTable.id,
    rating: shopReviewsTable.rating,
    comment: shopReviewsTable.comment,
    createdAt: shopReviewsTable.createdAt,
    reviewerName: appUsersTable.displayName,
  })
  .from(shopReviewsTable)
  .leftJoin(appUsersTable, eq(shopReviewsTable.userId, appUsersTable.id))
  .where(and(eq(shopReviewsTable.productId, productId), eq(shopReviewsTable.organizationId, orgId), eq(shopReviewsTable.isApproved, true)))
  .orderBy(desc(shopReviewsTable.createdAt))
  .limit(limit)
  .offset(offset);

  res.json({ avgRating: aggRow?.avgRating ? parseFloat(String(aggRow.avgRating)) : null, totalCount: Number(aggRow?.totalCount ?? 0), page, limit, reviews });
});

router.post("/products/:productId/reviews", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (isNaN(orgId) || isNaN(productId)) { { res.status(400).json({ error: "Invalid orgId or productId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) { { res.status(400).json({ error: "rating must be 1–5" }); return; } }
  if (comment && comment.length > 500) { { res.status(400).json({ error: "comment must not exceed 500 characters" }); return; } }

  const [eligibleOrder] = await db.select({ id: shopOrdersTable.id }).from(shopOrdersTable)
    .where(and(
      eq(shopOrdersTable.productId, productId),
      eq(shopOrdersTable.organizationId, orgId),
      eq(shopOrdersTable.userId, authUser.id),
      sql`${shopOrdersTable.status} IN ('shipped', 'delivered')`,
    ));
  if (!eligibleOrder) { { res.status(403).json({ error: "You can only review products you have received" }); return; } }

  const [orgSettings] = await db.select({ shopReviewModerationEnabled: organizationsTable.shopReviewModerationEnabled })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const autoApprove = !orgSettings?.shopReviewModerationEnabled;

  try {
    const [review] = await db.insert(shopReviewsTable)
      .values({ userId: authUser.id, productId, organizationId: orgId, rating, comment: comment ?? null, isApproved: autoApprove })
      .returning();

    await db.update(shopReviewPromptsTable)
      .set({ isDismissed: true })
      .where(and(eq(shopReviewPromptsTable.userId, authUser.id), eq(shopReviewPromptsTable.productId, productId)));

    res.status(201).json(review);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to submit review";
    if (msg.includes("unique")) { res.status(409).json({ error: "You have already reviewed this product" }); }
    else { res.status(500).json({ error: msg }); }
  }
});

router.patch("/reviews/:reviewId/approve", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reviewId = parseInt(String((req.params as Record<string, string>).reviewId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { isApproved } = req.body;
  const [review] = await db.update(shopReviewsTable)
    .set({ isApproved: !!isApproved, updatedAt: new Date() })
    .where(and(eq(shopReviewsTable.id, reviewId), eq(shopReviewsTable.organizationId, orgId)))
    .returning();
  if (!review) { { res.status(404).json({ error: "Review not found" }); return; } }
  res.json(review);
});

router.delete("/reviews/:reviewId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const reviewId = parseInt(String((req.params as Record<string, string>).reviewId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(shopReviewsTable).where(and(eq(shopReviewsTable.id, reviewId), eq(shopReviewsTable.organizationId, orgId)));
  res.json({ ok: true });
});

router.get("/reviews", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const reviews = await db.select({
    id: shopReviewsTable.id,
    productId: shopReviewsTable.productId,
    rating: shopReviewsTable.rating,
    comment: shopReviewsTable.comment,
    isApproved: shopReviewsTable.isApproved,
    createdAt: shopReviewsTable.createdAt,
    reviewerName: appUsersTable.displayName,
    reviewerEmail: appUsersTable.email,
    productName: shopProductsTable.name,
  })
  .from(shopReviewsTable)
  .leftJoin(appUsersTable, eq(shopReviewsTable.userId, appUsersTable.id))
  .leftJoin(shopProductsTable, eq(shopReviewsTable.productId, shopProductsTable.id))
  .where(eq(shopReviewsTable.organizationId, orgId))
  .orderBy(desc(shopReviewsTable.createdAt));

  res.json(reviews);
});

router.get("/review-prompts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  const prompts = await db.select({
    id: shopReviewPromptsTable.id,
    orderId: shopReviewPromptsTable.orderId,
    productId: shopReviewPromptsTable.productId,
    productName: shopProductsTable.name,
    productImage: shopProductsTable.imageUrl,
    createdAt: shopReviewPromptsTable.createdAt,
  })
  .from(shopReviewPromptsTable)
  .innerJoin(shopProductsTable, eq(shopReviewPromptsTable.productId, shopProductsTable.id))
  .where(and(
    eq(shopReviewPromptsTable.userId, authUser.id),
    eq(shopProductsTable.organizationId, orgId),
    eq(shopReviewPromptsTable.isDismissed, false),
  ))
  .orderBy(desc(shopReviewPromptsTable.createdAt))
  .limit(5);

  res.json(prompts);
});

router.post("/review-prompts/:promptId/dismiss", async (req: Request, res: Response) => {
  const promptId = parseInt(String((req.params as Record<string, string>).promptId));
  if (isNaN(promptId)) { { res.status(400).json({ error: "Invalid promptId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  await db.update(shopReviewPromptsTable)
    .set({ isDismissed: true })
    .where(and(eq(shopReviewPromptsTable.id, promptId), eq(shopReviewPromptsTable.userId, authUser.id)));

  res.json({ ok: true });
});

// ─── RETURNS, REFUNDS & EXCHANGES ────────────────────────────────────────────

const RETURN_WINDOW_DAYS = process.env.RETURN_WINDOW_DAYS ? parseInt(process.env.RETURN_WINDOW_DAYS) : 30;
const FRAUD_SCORE_THRESHOLD = 60;

async function logOrderEvent(opts: {
  organizationId: number;
  orderId?: number | null;
  returnId?: number | null;
  eventType: string;
  description: string;
  userId?: number | null;
  metadata?: Record<string, unknown>;
}) {
  try {
    await db.insert(shopOrderEventsTable).values({
      organizationId: opts.organizationId,
      orderId: opts.orderId ?? null,
      returnId: opts.returnId ?? null,
      eventType: opts.eventType,
      description: opts.description,
      userId: opts.userId ?? null,
      metadata: opts.metadata ?? null,
    });
  } catch (err) {
    // Non-fatal — do not let event logging break the main flow
    console.error("[orderEvent] failed to log event:", err instanceof Error ? err.message : err);
  }
}

/**
 * Fraud detection engine — scores a return request.
 * Returns { score, flagReason } where score ∈ [0, 100].
 * Score >= FRAUD_SCORE_THRESHOLD → auto-flag.
 */
async function scoreFraud(orgId: number, userId: number | null, customerEmail: string, refundAmount: number, orderId?: number): Promise<{ score: number; flagReason: string | null }> {
  const reasons: string[] = [];
  let score = 0;

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Rule 1: Frequency — more than 3 returns in rolling 90-day window
  const [recentReturnsRow] = await db.select({ cnt: count() }).from(shopReturnsTable)
    .where(and(
      eq(shopReturnsTable.organizationId, orgId),
      userId ? eq(shopReturnsTable.userId, userId) : eq(shopReturnsTable.customerEmail, customerEmail),
      gte(shopReturnsTable.createdAt, ninetyDaysAgo),
    ));
  const recentCount = Number(recentReturnsRow?.cnt ?? 0);
  if (recentCount >= 5) { score += 40; reasons.push(`${recentCount} returns in last 90 days`); }
  else if (recentCount >= 3) { score += 20; reasons.push(`${recentCount} returns in last 90 days`); }

  // Rule 2: High-value return (> ₹5000 equivalent)
  if (refundAmount > 5000) { score += 20; reasons.push(`high-value return ₹${refundAmount.toFixed(0)}`); }

  // Rule 3: Prior fraud flags on this account
  const [priorFlagRow] = await db.select({ cnt: count() }).from(shopReturnsTable)
    .where(and(
      eq(shopReturnsTable.organizationId, orgId),
      userId ? eq(shopReturnsTable.userId, userId) : eq(shopReturnsTable.customerEmail, customerEmail),
      eq(shopReturnsTable.fraudFlag, true),
    ));
  const priorFlags = Number(priorFlagRow?.cnt ?? 0);
  if (priorFlags > 0) { score += 30; reasons.push(`${priorFlags} prior fraud flag(s)`); }

  // Rule 4: Account age < 30 days with no purchase history before that
  if (userId) {
    const [userRow] = await db.select({ createdAt: appUsersTable.createdAt }).from(appUsersTable).where(eq(appUsersTable.id, userId));
    if (userRow && userRow.createdAt > thirtyDaysAgo) {
      const [oldOrderRow] = await db.select({ cnt: count() }).from(shopOrdersTable)
        .where(and(
          eq(shopOrdersTable.userId, userId),
          eq(shopOrdersTable.organizationId, orgId),
          sql`${shopOrdersTable.status} IN ('paid', 'shipped', 'delivered')`,
          lt(shopOrdersTable.createdAt, thirtyDaysAgo),
        ));
      if (Number(oldOrderRow?.cnt ?? 0) === 0) {
        score += 20;
        reasons.push("account < 30 days old with no prior purchase history");
      }
    }
  }

  // Rule 5: Prior completed return on the same order (double-dip attempt)
  if (orderId) {
    const [priorOrderReturnRow] = await db.select({ cnt: count() }).from(shopReturnsTable)
      .where(and(
        eq(shopReturnsTable.organizationId, orgId),
        eq(shopReturnsTable.orderId, orderId),
        sql`${shopReturnsTable.status} IN ('refunded', 'exchanged', 'approved')`,
      ));
    if (Number(priorOrderReturnRow?.cnt ?? 0) > 0) {
      score += 50;
      reasons.push("prior completed return already exists for this order");
    }
  }

  score = Math.min(100, score);
  return { score, flagReason: reasons.length > 0 ? reasons.join("; ") : null };
}

// POST /organizations/:orgId/shop/returns — customer creates a return request
router.post("/returns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const authUser = req.user as { id: number };
  const { orderId, reason, reasonDetail, returnType = "refund", exchangeVariantId, items } = req.body;

  if (!orderId || !reason) { { res.status(400).json({ error: "orderId and reason are required" }); return; } }

  const validReasons = ["wrong_size", "defective", "changed_mind", "wrong_item", "damaged_in_shipping", "other"];
  if (!validReasons.includes(reason)) { { res.status(400).json({ error: "Invalid reason" }); return; } }

  // Check this order belongs to the customer and is eligible
  const [order] = await db.select().from(shopOrdersTable)
    .where(and(
      eq(shopOrdersTable.id, orderId),
      eq(shopOrdersTable.organizationId, orgId),
      or(
        eq(shopOrdersTable.userId, authUser.id),
        eq(shopOrdersTable.customerEmail, (await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, authUser.id)).then(r => r[0]?.email ?? ""))),
      ),
    ));
  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }
  if (!["paid", "shipped", "delivered"].includes(order.status)) {
    res.status(400).json({ error: "Only paid, shipped, or delivered orders are eligible for returns" }); return;
  }

  // Return window check
  const returnWindowMs = RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() - new Date(order.createdAt).getTime() > returnWindowMs) {
    res.status(400).json({ error: `Return window of ${RETURN_WINDOW_DAYS} days has passed` }); return;
  }

  // Check for existing open return on this order
  const [existingReturn] = await db.select({ id: shopReturnsTable.id, status: shopReturnsTable.status })
    .from(shopReturnsTable)
    .where(and(
      eq(shopReturnsTable.orderId, orderId),
      eq(shopReturnsTable.organizationId, orgId),
      sql`${shopReturnsTable.status} NOT IN ('rejected', 'refunded', 'exchanged')`,
    ));
  if (existingReturn) {
    res.status(409).json({ error: "A return request already exists for this order", returnId: existingReturn.id }); return;
  }

  // Check blacklist
  const [blacklisted] = await db.select({ id: shopReturnBlacklistTable.id }).from(shopReturnBlacklistTable)
    .where(and(eq(shopReturnBlacklistTable.organizationId, orgId), eq(shopReturnBlacklistTable.userId, authUser.id)));
  if (blacklisted) { { res.status(403).json({ error: "Your account is not eligible for returns. Please contact support." }); return; } }

  // Compute already-returned quantity for this order (across all prior returns regardless of status)
  const priorReturnItems = await db.select({ quantity: shopReturnItemsTable.quantity })
    .from(shopReturnItemsTable)
    .innerJoin(shopReturnsTable, eq(shopReturnItemsTable.returnId, shopReturnsTable.id))
    .where(and(
      eq(shopReturnItemsTable.orderId, orderId),
      eq(shopReturnsTable.organizationId, orgId),
      sql`${shopReturnsTable.status} NOT IN ('rejected')`,
    ));
  const alreadyReturnedQty = priorReturnItems.reduce((s, r) => s + r.quantity, 0);
  const maxReturnableQty = order.quantity - alreadyReturnedQty;
  if (maxReturnableQty <= 0) {
    res.status(400).json({ error: "All items from this order have already been returned" }); return;
  }

  // Determine return quantity — default to full remaining, cap to maxReturnableQty
  // Online orders are single-product; ignore client-supplied productId/variantId and use order's own values
  const requestedQty = items && Array.isArray(items) && items.length > 0
    ? Math.min(parseInt(String(items[0]?.quantity ?? order.quantity)), maxReturnableQty)
    : maxReturnableQty;
  if (requestedQty <= 0) {
    res.status(400).json({ error: "Return quantity must be at least 1" }); return;
  }

  const refundAmount = parseFloat(order.unitPrice) * requestedQty;

  // Run fraud detection
  const { score: fraudScore, flagReason } = await scoreFraud(orgId, authUser.id, order.customerEmail, refundAmount, orderId);
  const isFlagged = fraudScore >= FRAUD_SCORE_THRESHOLD;

  // Get product info
  const [product] = await db.select({ name: shopProductsTable.name })
    .from(shopProductsTable).where(eq(shopProductsTable.id, order.productId));

  const newReturn = await db.transaction(async (tx) => {
    const [ret] = await tx.insert(shopReturnsTable).values({
      organizationId: orgId,
      orderId,
      sourceType: "online",
      userId: authUser.id,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      reason: reason as typeof shopReturnsTable.$inferInsert["reason"],
      reasonDetail: reasonDetail ?? null,
      status: isFlagged ? "flagged" : "pending",
      returnType,
      refundAmount: String(refundAmount.toFixed(2)),
      currency: order.currency,
      exchangeVariantId: exchangeVariantId ?? null,
      fraudScore,
      fraudFlag: isFlagged,
      fraudFlagReason: flagReason ?? null,
    }).returning();

    // Insert return items — always use server-verified product/variant from the original order
    await tx.insert(shopReturnItemsTable).values({
      returnId: ret.id,
      orderId,
      productId: order.productId,
      variantId: order.variantId ?? null,
      productName: product?.name ?? "Product",
      size: order.size ?? null,
      color: order.color ?? null,
      quantity: requestedQty,
      unitPrice: order.unitPrice,
      exchangeVariantId: exchangeVariantId ?? null,
    });

    return ret;
  });

  // Log order timeline event (non-fatal)
  logOrderEvent({
    organizationId: orgId,
    orderId: orderId ?? null,
    returnId: newReturn.id,
    eventType: "return_submitted",
    description: `Return request submitted: ${reason}${isFlagged ? " [FRAUD FLAGGED]" : ""}`,
    userId: authUser.id,
    metadata: { returnType, fraudScore, isFlagged },
  });

  res.status(201).json({ ...newReturn, flagged: isFlagged });
});

// GET /organizations/:orgId/shop/my-returns — customer views their returns
router.get("/my-returns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const authUser = req.user as { id: number };

  const returns = await db.select({
    id: shopReturnsTable.id,
    orderId: shopReturnsTable.orderId,
    reason: shopReturnsTable.reason,
    reasonDetail: shopReturnsTable.reasonDetail,
    status: shopReturnsTable.status,
    returnType: shopReturnsTable.returnType,
    refundAmount: shopReturnsTable.refundAmount,
    currency: shopReturnsTable.currency,
    fraudFlag: shopReturnsTable.fraudFlag,
    createdAt: shopReturnsTable.createdAt,
    resolvedAt: shopReturnsTable.resolvedAt,
  })
  .from(shopReturnsTable)
  .where(and(
    eq(shopReturnsTable.organizationId, orgId),
    eq(shopReturnsTable.userId, authUser.id),
  ))
  .orderBy(desc(shopReturnsTable.createdAt));

  res.json(returns);
});

// GET /organizations/:orgId/shop/returns — admin lists returns
router.get("/returns", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const { status, flagged } = req.query;

  const conditions = [eq(shopReturnsTable.organizationId, orgId)];
  if (status && typeof status === "string") {
    conditions.push(eq(shopReturnsTable.status, status as typeof shopReturnsTable.$inferSelect["status"]));
  }
  if (flagged === "true") {
    conditions.push(eq(shopReturnsTable.fraudFlag, true));
  }

  const returns = await db.select({
    id: shopReturnsTable.id,
    orderId: shopReturnsTable.orderId,
    posTransactionId: shopReturnsTable.posTransactionId,
    sourceType: shopReturnsTable.sourceType,
    customerName: shopReturnsTable.customerName,
    customerEmail: shopReturnsTable.customerEmail,
    reason: shopReturnsTable.reason,
    reasonDetail: shopReturnsTable.reasonDetail,
    status: shopReturnsTable.status,
    returnType: shopReturnsTable.returnType,
    refundAmount: shopReturnsTable.refundAmount,
    currency: shopReturnsTable.currency,
    fraudScore: shopReturnsTable.fraudScore,
    fraudFlag: shopReturnsTable.fraudFlag,
    fraudFlagReason: shopReturnsTable.fraudFlagReason,
    adminNotes: shopReturnsTable.adminNotes,
    resolvedAt: shopReturnsTable.resolvedAt,
    createdAt: shopReturnsTable.createdAt,
  })
  .from(shopReturnsTable)
  .where(and(...conditions))
  .orderBy(desc(shopReturnsTable.createdAt));

  res.json(returns);
});

// GET /organizations/:orgId/shop/returns/:returnId — admin gets return detail
router.get("/returns/:returnId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const returnId = parseInt(String((req.params as Record<string, string>).returnId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const [ret] = await db.select().from(shopReturnsTable)
    .where(and(eq(shopReturnsTable.id, returnId), eq(shopReturnsTable.organizationId, orgId)));
  if (!ret) { { res.status(404).json({ error: "Return not found" }); return; } }

  const items = await db.select().from(shopReturnItemsTable).where(eq(shopReturnItemsTable.returnId, returnId));

  res.json({ ...ret, items });
});

// PATCH /organizations/:orgId/shop/returns/:returnId — admin updates status (approve/reject/received/override)
router.patch("/returns/:returnId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const returnId = parseInt(String((req.params as Record<string, string>).returnId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const adminUser = req.user as { id: number };
  const { action, adminNotes, refundAmount: overrideRefundAmount } = req.body;

  const [ret] = await db.select().from(shopReturnsTable)
    .where(and(eq(shopReturnsTable.id, returnId), eq(shopReturnsTable.organizationId, orgId)));
  if (!ret) { { res.status(404).json({ error: "Return not found" }); return; } }

  const validActions = ["approve", "reject", "received", "override_fraud"];
  if (!validActions.includes(action)) { { res.status(400).json({ error: `action must be one of: ${validActions.join(", ")}` }); return; } }

  if (action === "approve") {
    if (!["pending", "received", "flagged"].includes(ret.status)) {
      res.status(400).json({ error: "Return cannot be approved in its current state" }); return;
    }

    const refundAmt = overrideRefundAmount ? parseFloat(overrideRefundAmount) : parseFloat(ret.refundAmount ?? "0");
    let razorpayRefundId: string | null = null;

    // For online Razorpay orders — trigger refund; fail hard if refund cannot be processed
    if (ret.sourceType === "online" && ret.orderId) {
      const [order] = await db.select({ razorpayPaymentId: shopOrdersTable.razorpayPaymentId, paymentMode: shopOrdersTable.paymentMode })
        .from(shopOrdersTable).where(eq(shopOrdersTable.id, ret.orderId));
      if (order?.razorpayPaymentId && order.paymentMode === "razorpay") {
        try {
          const rz = getRazorpayClient();
          const rzRefund = await (rz.payments as unknown as { refund(id: string, opts: { amount: number; notes: Record<string, string> }): Promise<{ id: string }> })
            .refund(order.razorpayPaymentId, {
              amount: Math.round(refundAmt * 100),
              notes: { returnId: String(returnId), reason: ret.reason },
            });
          razorpayRefundId = rzRefund.id;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[returns] Razorpay refund error:", msg);
          res.status(502).json({ error: `Razorpay refund failed: ${msg}. Return status has not been changed — please retry or process the refund manually.` });
          return;
        }
      }
    }

    // POS settlement: restock items + apply refund method + update transaction status
    let posPreviouslyFlagged = false;
    if (ret.sourceType === "pos") {
      posPreviouslyFlagged = !!ret.fraudFlag;
      const returnItems = await db.select().from(shopReturnItemsTable)
        .where(eq(shopReturnItemsTable.returnId, returnId));

      // Restock items that haven't been restocked yet (idempotent)
      for (const item of returnItems) {
        if (!item.restocked) {
          if (item.variantId) {
            await db.update(shopProductVariantsTable)
              .set({ stockQty: sql`${shopProductVariantsTable.stockQty} + ${item.quantity}`, updatedAt: new Date() })
              .where(eq(shopProductVariantsTable.id, item.variantId));
          } else if (item.productId) {
            await db.update(shopProductsTable)
              .set({ stockCount: sql`COALESCE(${shopProductsTable.stockCount}, 0) + ${item.quantity}`, updatedAt: new Date() })
              .where(eq(shopProductsTable.id, item.productId));
          }
          await db.update(shopReturnItemsTable).set({ restocked: true }).where(eq(shopReturnItemsTable.id, item.id));
        }
      }

      // Apply member account credit if refund method is member_account and user is linked
      if (ret.posRefundMethod === "member_account" && ret.userId && ret.posTransactionId) {
        const [member] = await db.select({ id: clubMembersTable.id })
          .from(clubMembersTable)
          .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.userId, ret.userId)));
        if (member) {
          // Check if credit was already applied (idempotent guard)
          const existing = await db.select({ id: memberAccountChargesTable.id })
            .from(memberAccountChargesTable)
            .where(and(
              eq(memberAccountChargesTable.organizationId, orgId),
              eq(memberAccountChargesTable.clubMemberId, member.id),
              eq(memberAccountChargesTable.posTransactionId, ret.posTransactionId),
            ));
          if (existing.length === 0) {
            await db.insert(memberAccountChargesTable).values({
              organizationId: orgId,
              clubMemberId: member.id,
              posTransactionId: ret.posTransactionId,
              amount: String((-refundAmt).toFixed(2)),
              description: `POS Return Approved — Ref #${ret.id}`,
            });
          }
        }
      }

      // Mark POS transaction as refunded when this was a full return
      if (ret.posTransactionId) {
        const txnItems = await db.select({ productId: posTransactionItemsTable.productId, variantId: posTransactionItemsTable.variantId, quantity: posTransactionItemsTable.quantity })
          .from(posTransactionItemsTable).where(eq(posTransactionItemsTable.transactionId, ret.posTransactionId));
        const totalTxnQty = txnItems.reduce((s: number, i: { quantity: number | string }) => s + parseInt(String(i.quantity)), 0);
        const allReturnsForTxn = await db.select({ quantity: shopReturnItemsTable.quantity })
          .from(shopReturnItemsTable)
          .innerJoin(shopReturnsTable, eq(shopReturnItemsTable.returnId, shopReturnsTable.id))
          .where(and(eq(shopReturnsTable.posTransactionId, ret.posTransactionId), sql`${shopReturnsTable.status} NOT IN ('rejected')`));
        const totalReturnedQty = allReturnsForTxn.reduce((s: number, i: { quantity: number | string }) => s + parseInt(String(i.quantity)), 0);
        if (totalReturnedQty >= totalTxnQty) {
          await db.update(posTransactionsTable)
            .set({ status: "refunded", updatedAt: new Date() })
            .where(eq(posTransactionsTable.id, ret.posTransactionId));
        }
      }
    }

    const [updated] = await db.update(shopReturnsTable)
      .set({
        status: ret.sourceType === "pos" ? "refunded" : (razorpayRefundId ? "refunded" : "approved"),
        refundAmount: String(refundAmt),
        razorpayRefundId: razorpayRefundId ?? undefined,
        resolvedByUserId: adminUser.id,
        resolvedAt: new Date(),
        adminNotes: adminNotes ?? ret.adminNotes,
        fraudFlag: posPreviouslyFlagged ? false : ret.fraudFlag,
        updatedAt: new Date(),
      })
      .where(eq(shopReturnsTable.id, returnId))
      .returning();

    // Update online order status — only "refunded" when Razorpay refund was confirmed; otherwise "returned"
    if (ret.orderId && ret.sourceType === "online") {
      await db.update(shopOrdersTable)
        .set({ status: razorpayRefundId ? "refunded" : "returned", updatedAt: new Date() })
        .where(eq(shopOrdersTable.id, ret.orderId));
    }

    // Send customer confirmation email
    if (ret.customerEmail) {
      const nameParts = ret.customerName.trim().split(/\s+/);
      sendBroadcast(
        [{ firstName: nameParts[0] ?? ret.customerName, lastName: nameParts.slice(1).join(" ") || "-", email: ret.customerEmail }],
        {
          channels: ["email"],
          subject: "Return Approved — Refund Initiated",
          body: `Hi ${ret.customerName},\n\nYour return request has been approved. A refund of ${ret.currency} ${refundAmt.toFixed(2)} has been initiated.\n\nPlease allow 3-7 business days for the amount to reflect in your account.\n\nThank you!`,
          eventName: "Return Approved",
          // Task #1566 — tag return-approval emails with the originating
          // club so the Postmark bounce webhook (Task #981) can attribute
          // hard bounces back to this org instantly.
          organizationId: orgId,
        },
      ).catch(() => {});
    }

    logOrderEvent({ organizationId: orgId, orderId: ret.orderId, returnId, eventType: "return_approved", description: razorpayRefundId ? `Refund approved and processed via Razorpay (${ret.currency} ${refundAmt.toFixed(2)})` : `Return approved — refund of ${ret.currency} ${refundAmt.toFixed(2)} pending manual processing`, userId: adminUser.id, metadata: { refundAmt, razorpayRefundId } });

    res.json(updated);

  } else if (action === "reject") {
    // Guard: block rejection if POS return items have already been restocked or refund was applied
    // to prevent inventory/accounting mismatch without a compensating reversal
    if (ret.sourceType === "pos" && ret.status === "received") {
      const restockedItems = await db.select({ id: shopReturnItemsTable.id })
        .from(shopReturnItemsTable)
        .where(and(eq(shopReturnItemsTable.returnId, returnId), eq(shopReturnItemsTable.restocked, true)));
      if (restockedItems.length > 0) {
        res.status(400).json({
          error: "Cannot reject a POS return after inventory has been restocked. Manually reverse the restock and member-account credit (if any) before rejecting, or use override_fraud to re-open the return for review.",
        });
        return;
      }
    }

    const [updated] = await db.update(shopReturnsTable)
      .set({
        status: "rejected",
        resolvedByUserId: adminUser.id,
        resolvedAt: new Date(),
        adminNotes: adminNotes ?? ret.adminNotes,
        updatedAt: new Date(),
      })
      .where(eq(shopReturnsTable.id, returnId))
      .returning();

    logOrderEvent({ organizationId: orgId, orderId: ret.orderId, returnId, eventType: "return_rejected", description: `Return request rejected${adminNotes ? `: ${adminNotes}` : ""}`, userId: adminUser.id });

    // Notify customer
    if (ret.customerEmail) {
      const nameParts = ret.customerName.trim().split(/\s+/);
      sendBroadcast(
        [{ firstName: nameParts[0] ?? ret.customerName, lastName: nameParts.slice(1).join(" ") || "-", email: ret.customerEmail }],
        {
          channels: ["email"],
          subject: "Return Request — Decision",
          body: `Hi ${ret.customerName},\n\nUnfortunately, your return request has been rejected.${adminNotes ? `\n\nReason: ${adminNotes}` : ""}\n\nPlease contact us if you have any questions.`,
          eventName: "Return Rejected",
          // Task #1566 — tag return-rejection emails with the originating
          // club so the Postmark bounce webhook (Task #981) can attribute
          // hard bounces back to this org instantly.
          organizationId: orgId,
        },
      ).catch(() => {});
    }

    res.json(updated);

  } else if (action === "received") {
    const [updated] = await db.update(shopReturnsTable)
      .set({
        status: "received",
        adminNotes: adminNotes ?? ret.adminNotes,
        updatedAt: new Date(),
      })
      .where(eq(shopReturnsTable.id, returnId))
      .returning();

    // Restock inventory
    const returnItems = await db.select().from(shopReturnItemsTable).where(eq(shopReturnItemsTable.returnId, returnId));
    let restockedCount = 0;
    for (const item of returnItems) {
      if (!item.restocked) {
        if (item.variantId) {
          await db.update(shopProductVariantsTable)
            .set({ stockQty: sql`${shopProductVariantsTable.stockQty} + ${item.quantity}`, updatedAt: new Date() })
            .where(eq(shopProductVariantsTable.id, item.variantId));
        } else if (item.productId) {
          await db.update(shopProductsTable)
            .set({ stockCount: sql`COALESCE(${shopProductsTable.stockCount}, 0) + ${item.quantity}`, updatedAt: new Date() })
            .where(eq(shopProductsTable.id, item.productId));
        }
        await db.update(shopReturnItemsTable).set({ restocked: true }).where(eq(shopReturnItemsTable.id, item.id));
        restockedCount += item.quantity;
      }
    }

    logOrderEvent({ organizationId: orgId, orderId: ret.orderId, returnId, eventType: "return_received", description: `Returned items received physically${restockedCount > 0 ? `; ${restockedCount} unit(s) restocked` : ""}`, userId: adminUser.id, metadata: { restockedCount } });

    res.json(updated);

  } else if (action === "override_fraud") {
    const [updated] = await db.update(shopReturnsTable)
      .set({
        status: "pending",
        fraudFlag: false,
        fraudOverriddenByUserId: adminUser.id,
        fraudOverriddenAt: new Date(),
        adminNotes: adminNotes ?? ret.adminNotes,
        updatedAt: new Date(),
      })
      .where(eq(shopReturnsTable.id, returnId))
      .returning();

    logOrderEvent({ organizationId: orgId, orderId: ret.orderId, returnId, eventType: "fraud_override", description: `Fraud flag overridden by admin; return moved back to pending`, userId: adminUser.id });

    res.json(updated);
  }
});

// POST /organizations/:orgId/shop/returns/:returnId/exchange — admin processes exchange
router.post("/returns/:returnId/exchange", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const returnId = parseInt(String((req.params as Record<string, string>).returnId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const adminUser = req.user as { id: number };
  const { newVariantId, adminNotes } = req.body;
  if (!newVariantId) { { res.status(400).json({ error: "newVariantId is required" }); return; } }

  const [ret] = await db.select().from(shopReturnsTable)
    .where(and(eq(shopReturnsTable.id, returnId), eq(shopReturnsTable.organizationId, orgId)));
  if (!ret) { { res.status(404).json({ error: "Return not found" }); return; } }
  if (!["pending", "received", "approved", "flagged"].includes(ret.status)) {
    res.status(400).json({ error: "Return cannot be exchanged in its current state" }); return;
  }

  // Fetch return items to determine actual returned quantity before any writes
  const returnItemsForExchange = await db.select().from(shopReturnItemsTable).where(eq(shopReturnItemsTable.returnId, returnId));
  const totalReturnedQty = returnItemsForExchange.reduce((s, i) => s + i.quantity, 0);

  // Check replacement stock FIRST — must have enough for actual returned quantity
  const [newVariant] = await db.select().from(shopProductVariantsTable).where(eq(shopProductVariantsTable.id, newVariantId));
  if (!newVariant) { { res.status(404).json({ error: "New variant not found" }); return; } }
  if (newVariant.stockQty < totalReturnedQty) {
    res.status(400).json({ error: `New variant only has ${newVariant.stockQty} units in stock; return requires ${totalReturnedQty}` }); return;
  }

  type ShippingAddress = { line1: string; line2?: string; city: string; state: string; pincode: string; country: string };

  // Fetch original order for price comparison and replacement order creation
  let originalOrder: { unitPrice: string; productId: number; userId: number | null; customerName: string; customerEmail: string; shippingAddress: ShippingAddress | null; currency: string } | null = null;
  if (ret.orderId) {
    const [ord] = await db.select({
      unitPrice: shopOrdersTable.unitPrice,
      productId: shopOrdersTable.productId,
      userId: shopOrdersTable.userId,
      customerName: shopOrdersTable.customerName,
      customerEmail: shopOrdersTable.customerEmail,
      shippingAddress: shopOrdersTable.shippingAddress,
      currency: shopOrdersTable.currency,
    }).from(shopOrdersTable).where(eq(shopOrdersTable.id, ret.orderId));
    originalOrder = ord ?? null;
  }

  // Fetch new product for pricing and replacement order creation
  const [newProduct] = await db.select({ markupPrice: shopProductsTable.markupPrice, name: shopProductsTable.name })
    .from(shopProductsTable).where(eq(shopProductsTable.id, newVariant.productId));
  const newUnitPrice = parseFloat(newProduct?.markupPrice ?? "0");

  // Calculate credit note or price-difference owed
  let creditNoteAmount = 0;
  let priceDifferenceOwed = 0;
  if (originalOrder) {
    const originalPrice = parseFloat(originalOrder.unitPrice ?? "0");
    const diff = originalPrice - newUnitPrice;
    if (diff > 0) {
      creditNoteAmount = diff * totalReturnedQty;
    } else if (diff < 0) {
      priceDifferenceOwed = Math.abs(diff) * totalReturnedQty;
    }
  }

  // Execute all writes atomically
  const { updated, replacementOrderId } = await db.transaction(async (tx) => {
    // Restock original items
    for (const item of returnItemsForExchange) {
      if (!item.restocked && item.variantId) {
        await tx.update(shopProductVariantsTable)
          .set({ stockQty: sql`${shopProductVariantsTable.stockQty} + ${item.quantity}`, updatedAt: new Date() })
          .where(eq(shopProductVariantsTable.id, item.variantId));
        await tx.update(shopReturnItemsTable).set({ restocked: true, exchangeVariantId: newVariantId }).where(eq(shopReturnItemsTable.id, item.id));
      } else if (!item.restocked && item.productId && !item.variantId) {
        await tx.update(shopProductsTable)
          .set({ stockCount: sql`COALESCE(${shopProductsTable.stockCount}, 0) + ${item.quantity}`, updatedAt: new Date() })
          .where(eq(shopProductsTable.id, item.productId));
        await tx.update(shopReturnItemsTable).set({ restocked: true, exchangeVariantId: newVariantId }).where(eq(shopReturnItemsTable.id, item.id));
      }
    }

    // Deduct actual returned quantity from replacement variant stock
    await tx.update(shopProductVariantsTable)
      .set({ stockQty: sql`${shopProductVariantsTable.stockQty} - ${totalReturnedQty}`, updatedAt: new Date() })
      .where(eq(shopProductVariantsTable.id, newVariantId));

    // Create a replacement order record for the exchanged item
    let replacementOrderId: number | null = null;
    if (originalOrder) {
      const replacementTotal = (newUnitPrice * totalReturnedQty).toFixed(2);
      const [replacementOrder] = await tx.insert(shopOrdersTable).values({
        organizationId: orgId,
        productId: newVariant.productId,
        variantId: newVariantId,
        userId: originalOrder.userId ?? undefined,
        customerName: originalOrder.customerName,
        customerEmail: originalOrder.customerEmail,
        quantity: totalReturnedQty,
        unitPrice: String(newUnitPrice.toFixed(2)),
        totalAmount: replacementTotal,
        currency: originalOrder.currency,
        shippingAddress: originalOrder.shippingAddress ?? undefined,
        paymentMode: "exchange",
        status: "paid",
      }).returning({ id: shopOrdersTable.id });
      replacementOrderId = replacementOrder?.id ?? null;
    }

    // Apply member account adjustments for the price difference
    let hasMemberAccount = false;
    if (originalOrder?.userId && (creditNoteAmount > 0 || priceDifferenceOwed > 0)) {
      const [member] = await tx.select({ id: clubMembersTable.id })
        .from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, orgId),
          eq(clubMembersTable.userId, originalOrder.userId),
        ));
      if (member) {
        hasMemberAccount = true;
        if (creditNoteAmount > 0) {
          // Credit to member account (negative charge = customer receives store credit)
          await tx.insert(memberAccountChargesTable).values({
            organizationId: orgId,
            clubMemberId: member.id,
            amount: String((-creditNoteAmount).toFixed(2)),
            currency: ret.currency,
            description: `Exchange credit note — Return #${returnId} (value difference ${ret.currency} ${creditNoteAmount.toFixed(2)} credited to account)`,
          });
        }
        if (priceDifferenceOwed > 0) {
          // Charge to member account (positive charge = customer owes additional amount)
          await tx.insert(memberAccountChargesTable).values({
            organizationId: orgId,
            clubMemberId: member.id,
            amount: String(priceDifferenceOwed.toFixed(2)),
            currency: ret.currency,
            description: `Exchange surcharge — Return #${returnId} (replacement item ${ret.currency} ${priceDifferenceOwed.toFixed(2)} more than original; charged to account)`,
          });
        }
      }
    }

    // For non-members with a price difference owed, create a pending shop order so the obligation is tracked in-system
    if (!hasMemberAccount && priceDifferenceOwed > 0 && originalOrder) {
      await tx.insert(shopOrdersTable).values({
        organizationId: orgId,
        productId: newVariant.productId,
        variantId: newVariantId,
        userId: originalOrder.userId ?? undefined,
        customerName: originalOrder.customerName,
        customerEmail: originalOrder.customerEmail,
        quantity: 1,
        unitPrice: String(priceDifferenceOwed.toFixed(2)),
        totalAmount: String(priceDifferenceOwed.toFixed(2)),
        currency: originalOrder.currency,
        paymentMode: "exchange_balance_due",
        status: "pending",
      });
    }

    // Update return record
    const rows = await tx.update(shopReturnsTable)
      .set({
        status: "exchanged",
        returnType: "exchange",
        exchangeVariantId: newVariantId,
        creditNoteAmount: String(creditNoteAmount),
        resolvedByUserId: adminUser.id,
        resolvedAt: new Date(),
        adminNotes: adminNotes ?? ret.adminNotes,
        updatedAt: new Date(),
      })
      .where(eq(shopReturnsTable.id, returnId))
      .returning();

    // Mark original order as exchanged
    if (ret.orderId) {
      await tx.update(shopOrdersTable).set({ status: "exchanged", updatedAt: new Date() }).where(eq(shopOrdersTable.id, ret.orderId));
    }

    return { updated: rows, replacementOrderId };
  });

  logOrderEvent({
    organizationId: orgId,
    orderId: ret.orderId,
    returnId,
    eventType: "return_exchanged",
    description: `Exchange processed: ${totalReturnedQty} unit(s) replaced with variant #${newVariantId}${creditNoteAmount > 0 ? `; credit note ${ret.currency} ${creditNoteAmount.toFixed(2)}` : ""}${priceDifferenceOwed > 0 ? `; customer owes ${ret.currency} ${priceDifferenceOwed.toFixed(2)} extra (collect manually)` : ""}`,
    userId: adminUser.id,
    metadata: { newVariantId, totalReturnedQty, creditNoteAmount, priceDifferenceOwed, replacementOrderId },
  });

  const [updatedReturn] = updated;
  res.json({ ...updatedReturn, newVariant, creditNoteAmount, priceDifferenceOwed, replacementOrderId });
});

// POST /organizations/:orgId/shop/blacklist — admin blacklists a customer
router.post("/blacklist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const adminUser = req.user as { id: number };
  const { userId, reason } = req.body;
  if (!userId) { { res.status(400).json({ error: "userId is required" }); return; } }

  try {
    const [entry] = await db.insert(shopReturnBlacklistTable).values({
      organizationId: orgId,
      userId,
      reason: reason ?? null,
      blacklistedByUserId: adminUser.id,
    }).returning();
    res.status(201).json(entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to blacklist";
    if (msg.includes("unique")) { res.status(409).json({ error: "User is already blacklisted" }); }
    else { res.status(500).json({ error: msg }); }
  }
});

// DELETE /organizations/:orgId/shop/blacklist/:userId — admin removes from blacklist
router.delete("/blacklist/:userId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const targetUserId = parseInt(String((req.params as Record<string, string>).userId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(shopReturnBlacklistTable)
    .where(and(eq(shopReturnBlacklistTable.organizationId, orgId), eq(shopReturnBlacklistTable.userId, targetUserId)));
  res.json({ ok: true });
});

// GET /organizations/:orgId/shop/blacklist — admin views blacklist
router.get("/blacklist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const entries = await db.select({
    id: shopReturnBlacklistTable.id,
    userId: shopReturnBlacklistTable.userId,
    reason: shopReturnBlacklistTable.reason,
    createdAt: shopReturnBlacklistTable.createdAt,
    userName: appUsersTable.displayName,
    userEmail: appUsersTable.email,
  })
  .from(shopReturnBlacklistTable)
  .leftJoin(appUsersTable, eq(shopReturnBlacklistTable.userId, appUsersTable.id))
  .where(eq(shopReturnBlacklistTable.organizationId, orgId))
  .orderBy(desc(shopReturnBlacklistTable.createdAt));

  res.json(entries);
});

// GET /organizations/:orgId/shop/returns-analytics — admin returns report
router.get("/returns-analytics", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = req.query;
  const conditions = [eq(shopReturnsTable.organizationId, orgId)];
  if (from) conditions.push(gte(shopReturnsTable.createdAt, new Date(String(from))));
  if (to) conditions.push(lt(shopReturnsTable.createdAt, new Date(String(to))));

  const [totalsRow] = await db.select({
    totalReturns: count(),
    refundedCount: count(sql`CASE WHEN ${shopReturnsTable.status} IN ('refunded', 'approved') THEN 1 END`),
    totalRefundAmount: sql<string>`COALESCE(SUM(CASE WHEN ${shopReturnsTable.status} IN ('refunded', 'approved') THEN ${shopReturnsTable.refundAmount}::numeric ELSE 0 END), 0)`,
    fraudFlagCount: count(sql`CASE WHEN ${shopReturnsTable.fraudFlag} = true THEN 1 END`),
  })
  .from(shopReturnsTable)
  .where(and(...conditions));

  // Reason breakdown
  const reasonBreakdown = await db.select({
    reason: shopReturnsTable.reason,
    cnt: count(),
  })
  .from(shopReturnsTable)
  .where(and(...conditions))
  .groupBy(shopReturnsTable.reason)
  .orderBy(desc(count()));

  // Restocked items count — respects the same from/to date filter as other analytics
  const [restockRow] = await db.select({
    restockedUnits: sql<string>`COALESCE(SUM(${shopReturnItemsTable.quantity}), 0)`,
  })
  .from(shopReturnItemsTable)
  .innerJoin(shopReturnsTable, eq(shopReturnItemsTable.returnId, shopReturnsTable.id))
  .where(and(...conditions, eq(shopReturnItemsTable.restocked, true)));

  // Total orders (for overall return rate calculation)
  const [ordersRow] = await db.select({ totalOrders: count() })
    .from(shopOrdersTable)
    .where(eq(shopOrdersTable.organizationId, orgId));

  // Product-level return rate: returns and orders per product
  const productReturnCounts = await db.select({
    productId: shopReturnItemsTable.productId,
    productName: shopReturnItemsTable.productName,
    returnCount: count(),
  })
    .from(shopReturnItemsTable)
    .innerJoin(shopReturnsTable, eq(shopReturnItemsTable.returnId, shopReturnsTable.id))
    .where(and(...conditions))
    .groupBy(shopReturnItemsTable.productId, shopReturnItemsTable.productName)
    .orderBy(desc(count()))
    .limit(20);

  const productOrderCounts = await db.select({
    productId: shopOrdersTable.productId,
    orderCount: count(),
  })
    .from(shopOrdersTable)
    .where(eq(shopOrdersTable.organizationId, orgId))
    .groupBy(shopOrdersTable.productId);

  const productOrderMap = new Map(productOrderCounts.map(r => [r.productId, Number(r.orderCount)]));
  const productReturnRates = productReturnCounts.map(r => ({
    productId: r.productId,
    productName: r.productName,
    returnCount: Number(r.returnCount),
    orderCount: productOrderMap.get(r.productId!) ?? 0,
    returnRate: productOrderMap.get(r.productId!) && productOrderMap.get(r.productId!)! > 0
      ? `${((Number(r.returnCount) / productOrderMap.get(r.productId!)!) * 100).toFixed(1)}%`
      : "n/a",
  }));

  // Monthly trend: group returns by month
  const monthlyTrend = await db.select({
    month: sql<string>`TO_CHAR(DATE_TRUNC('month', ${shopReturnsTable.createdAt}), 'YYYY-MM')`,
    returnCount: count(),
    totalRefundAmount: sql<string>`COALESCE(SUM(${shopReturnsTable.refundAmount}::numeric), 0)`,
  })
    .from(shopReturnsTable)
    .where(and(...conditions))
    .groupBy(sql`DATE_TRUNC('month', ${shopReturnsTable.createdAt})`)
    .orderBy(asc(sql`DATE_TRUNC('month', ${shopReturnsTable.createdAt})`))
    .limit(24);

  const totalReturns = Number(totalsRow?.totalReturns ?? 0);
  const totalOrders = Number(ordersRow?.totalOrders ?? 1);
  const returnRate = totalOrders > 0 ? ((totalReturns / totalOrders) * 100).toFixed(1) : "0.0";

  res.json({
    totalReturns,
    returnRate: `${returnRate}%`,
    refundedCount: Number(totalsRow?.refundedCount ?? 0),
    totalRefundAmount: parseFloat(String(totalsRow?.totalRefundAmount ?? "0")),
    fraudFlagCount: Number(totalsRow?.fraudFlagCount ?? 0),
    restockedUnits: Number(restockRow?.restockedUnits ?? 0),
    reasonBreakdown,
    productReturnRates,
    monthlyTrend: monthlyTrend.map(m => ({
      month: m.month,
      returnCount: Number(m.returnCount),
      totalRefundAmount: parseFloat(String(m.totalRefundAmount)),
    })),
  });
});

// ─── TOURNAMENT MERCHANDISE ───────────────────────────────────────────────────
// GET /organizations/:orgId/shop/tournaments/:tournamentId/merchandise
// Scoped to org via join on tournamentsTable — prevents cross-tenant IDOR.
router.get("/tournaments/:tournamentId/merchandise", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  // Verify the tournament belongs to this org before exposing its merchandise
  const [tournament] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const items = await db
    .select({
      id: tournamentMerchandiseTable.id,
      tournamentId: tournamentMerchandiseTable.tournamentId,
      displayOrder: tournamentMerchandiseTable.displayOrder,
      note: tournamentMerchandiseTable.note,
      createdAt: tournamentMerchandiseTable.createdAt,
      product: {
        id: shopProductsTable.id,
        name: shopProductsTable.name,
        category: shopProductsTable.category,
        imageUrl: shopProductsTable.imageUrl,
        basePrice: shopProductsTable.basePrice,
        currency: shopProductsTable.currency,
      },
    })
    .from(tournamentMerchandiseTable)
    .innerJoin(shopProductsTable, eq(shopProductsTable.id, tournamentMerchandiseTable.productId))
    .where(eq(tournamentMerchandiseTable.tournamentId, tournamentId))
    .orderBy(asc(tournamentMerchandiseTable.displayOrder));

  res.json(items);
});

// POST /organizations/:orgId/shop/tournaments/:tournamentId/merchandise
router.post("/tournaments/:tournamentId/merchandise", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify tournament belongs to this org
  const [tournament] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(403).json({ error: "Tournament does not belong to this organisation" }); return; } }

  const { productId, displayOrder, note } = req.body;
  if (!productId) { { res.status(400).json({ error: "productId required" }); return; } }

  // Verify product belongs to this org
  const [product] = await db.select({ id: shopProductsTable.id })
    .from(shopProductsTable)
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
  if (!product) { { res.status(403).json({ error: "Product does not belong to this organisation" }); return; } }

  const [row] = await db.insert(tournamentMerchandiseTable).values({
    tournamentId,
    productId,
    displayOrder: displayOrder ?? 0,
    note: note ?? null,
  }).returning();

  res.status(201).json(row);
});

// DELETE /organizations/:orgId/shop/tournaments/:tournamentId/merchandise/:merchandiseId
router.delete("/tournaments/:tournamentId/merchandise/:merchandiseId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const merchandiseId = parseInt(String((req.params as Record<string, string>).merchandiseId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify tournament belongs to this org (IDOR protection: scope delete to org-owned tournament)
  const [tournament] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(403).json({ error: "Tournament does not belong to this organisation" }); return; } }

  // Only delete the merchandise if it belongs to this tournament
  await db.delete(tournamentMerchandiseTable).where(
    and(eq(tournamentMerchandiseTable.id, merchandiseId), eq(tournamentMerchandiseTable.tournamentId, tournamentId))
  );
  res.json({ success: true });
});

// ─── PRODUCT WAITLIST ("NOTIFY ME") ──────────────────────────────────────────
// POST /organizations/:orgId/shop/products/:productId/waitlist
router.post("/products/:productId/waitlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  const { variantId, email, name } = req.body;

  if (!email) { { res.status(400).json({ error: "email required" }); return; } }

  // Verify product belongs to this org
  const [product] = await db.select({ id: shopProductsTable.id })
    .from(shopProductsTable)
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }

  // If variantId provided, verify it belongs to this product
  if (variantId) {
    const [variant] = await db.select({ id: shopProductVariantsTable.id })
      .from(shopProductVariantsTable)
      .where(and(eq(shopProductVariantsTable.id, variantId), eq(shopProductVariantsTable.productId, productId)));
    if (!variant) { { res.status(404).json({ error: "Variant not found" }); return; } }
  }

  const userId = req.isAuthenticated() ? (req.user as { id: number }).id : null;

  try {
    const [row] = await db.insert(productWaitlistTable).values({
      organizationId: orgId,
      productId,
      variantId: variantId ?? null,
      userId,
      email,
      name: name ?? null,
    })
    .onConflictDoNothing()
    .returning();

    res.status(201).json(row ?? { message: "Already on waitlist" });
  } catch (err) {
    res.status(409).json({ error: "Already on waitlist" });
  }
});

// GET /organizations/:orgId/shop/products/:productId/waitlist (admin)
router.get("/products/:productId/waitlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const items = await db
    .select()
    .from(productWaitlistTable)
    .where(and(
      eq(productWaitlistTable.organizationId, orgId),
      eq(productWaitlistTable.productId, productId),
    ))
    .orderBy(asc(productWaitlistTable.createdAt));

  res.json(items);
});

// GET /organizations/:orgId/shop/waitlist (admin — all products)
router.get("/waitlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const items = await db
    .select({
      id: productWaitlistTable.id,
      email: productWaitlistTable.email,
      name: productWaitlistTable.name,
      notifiedAt: productWaitlistTable.notifiedAt,
      createdAt: productWaitlistTable.createdAt,
      productId: productWaitlistTable.productId,
      variantId: productWaitlistTable.variantId,
      productName: shopProductsTable.name,
    })
    .from(productWaitlistTable)
    .innerJoin(shopProductsTable, eq(shopProductsTable.id, productWaitlistTable.productId))
    .where(eq(productWaitlistTable.organizationId, orgId))
    .orderBy(desc(productWaitlistTable.createdAt))
    .limit(500);

  res.json(items);
});

// POST /organizations/:orgId/shop/products/:productId/notify-waitlist (admin triggers notify)
router.post("/products/:productId/notify-waitlist", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { variantId } = req.body;
  const conditions = [
    eq(productWaitlistTable.organizationId, orgId),
    eq(productWaitlistTable.productId, productId),
    isNull(productWaitlistTable.notifiedAt),
  ];
  if (variantId) conditions.push(eq(productWaitlistTable.variantId, variantId));

  const waiters = await db.select().from(productWaitlistTable).where(and(...conditions));
  const now = new Date();

  if (waiters.length > 0) {
    // Fetch product name for the notification email
    const [product] = await db.select({ name: shopProductsTable.name })
      .from(shopProductsTable)
      .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
    const productName = product?.name ?? "An item you were waiting for";

    // Mark as notified
    await db.update(productWaitlistTable)
      .set({ notifiedAt: now })
      .where(and(...conditions));

    // Build recipients list and send restock notification emails (fire-and-forget)
    const recipients = waiters
      .filter(w => !!w.email)
      .map(w => {
        const parts = (w.name ?? "").split(" ");
        return {
          email: w.email,
          firstName: parts[0] ?? "there",
          lastName: parts.slice(1).join(" ") || "—",
        };
      });

    if (recipients.length > 0) {
      sendBroadcast(recipients, {
        subject: `${productName} is back in stock!`,
        body: `Great news! **${productName}** is back in stock at the Pro Shop. Head over now to place your order before it sells out again.`,
        channels: ["email"],
        eventName: "product_restock",
        // Task #1566 — tag waitlist restock-notification emails with the
        // originating club so the Postmark bounce webhook (Task #981) can
        // attribute hard bounces back to this org instantly.
        organizationId: orgId,
      }).catch(err => console.warn("[waitlist-notify] email error:", err instanceof Error ? err.message : err));
    }
  }

  res.json({ notified: waiters.length, emails: waiters.map(w => w.email) });
});

// ─── PRODUCT BUNDLES ──────────────────────────────────────────────────────────
// GET /organizations/:orgId/shop/bundles
router.get("/bundles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const bundles = await db
    .select()
    .from(shopBundlesTable)
    .where(eq(shopBundlesTable.organizationId, orgId))
    .orderBy(desc(shopBundlesTable.createdAt));

  const bundleIds = bundles.map(b => b.id);
  const components = bundleIds.length > 0
    ? await db
        .select({
          id: shopBundleComponentsTable.id,
          bundleId: shopBundleComponentsTable.bundleId,
          productId: shopBundleComponentsTable.productId,
          variantId: shopBundleComponentsTable.variantId,
          quantity: shopBundleComponentsTable.quantity,
          productName: shopProductsTable.name,
        })
        .from(shopBundleComponentsTable)
        .innerJoin(shopProductsTable, eq(shopProductsTable.id, shopBundleComponentsTable.productId))
        .where(inArray(shopBundleComponentsTable.bundleId, bundleIds))
    : [];

  const result = bundles.map(b => ({
    ...b,
    components: components.filter(c => c.bundleId === b.id),
  }));

  res.json(result);
});

// GET /organizations/:orgId/shop/bundles/:bundleId
router.get("/bundles/:bundleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const [bundle] = await db.select().from(shopBundlesTable)
    .where(and(eq(shopBundlesTable.id, bundleId), eq(shopBundlesTable.organizationId, orgId)));
  if (!bundle) { { res.status(404).json({ error: "Bundle not found" }); return; } }

  const components = await db
    .select({
      id: shopBundleComponentsTable.id,
      bundleId: shopBundleComponentsTable.bundleId,
      productId: shopBundleComponentsTable.productId,
      variantId: shopBundleComponentsTable.variantId,
      quantity: shopBundleComponentsTable.quantity,
      productName: shopProductsTable.name,
    })
    .from(shopBundleComponentsTable)
    .innerJoin(shopProductsTable, eq(shopProductsTable.id, shopBundleComponentsTable.productId))
    .where(eq(shopBundleComponentsTable.bundleId, bundleId));

  res.json({ ...bundle, components });
});

// POST /organizations/:orgId/shop/bundles
router.post("/bundles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, sku, imageUrl, price, currency, isActive, components } = req.body;
  if (!name || price == null) { { res.status(400).json({ error: "name and price required" }); return; } }

  const [bundle] = await db.insert(shopBundlesTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    sku: sku ?? null,
    imageUrl: imageUrl ?? null,
    price: String(price),
    currency: currency ?? "INR",
    isActive: isActive !== false,
  }).returning();

  if (components && Array.isArray(components) && components.length > 0) {
    const validComponents: { bundleId: number; productId: number; variantId: number | null; quantity: number }[] = [];
    for (const c of components as { productId: number; variantId?: number; quantity?: number }[]) {
      const [product] = await db.select({ id: shopProductsTable.id })
        .from(shopProductsTable)
        .where(and(eq(shopProductsTable.id, c.productId), eq(shopProductsTable.organizationId, orgId)));
      if (!product) continue; // skip components not owned by this org
      if (c.variantId) {
        const [variant] = await db.select({ id: shopProductVariantsTable.id })
          .from(shopProductVariantsTable)
          .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
          .where(and(
            eq(shopProductVariantsTable.id, c.variantId),
            eq(shopProductVariantsTable.productId, c.productId),
            eq(shopProductsTable.organizationId, orgId),
          ));
        if (!variant) continue; // skip variants not owned by this org
      }
      validComponents.push({ bundleId: bundle.id, productId: c.productId, variantId: c.variantId ?? null, quantity: c.quantity ?? 1 });
    }
    if (validComponents.length > 0) {
      await db.insert(shopBundleComponentsTable).values(validComponents);
    }
  }

  res.status(201).json(bundle);
});

// PATCH /organizations/:orgId/shop/bundles/:bundleId
router.patch("/bundles/:bundleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, sku, imageUrl, price, currency, isActive } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (sku !== undefined) updates.sku = sku;
  if (imageUrl !== undefined) updates.imageUrl = imageUrl;
  if (price !== undefined) updates.price = String(price);
  if (currency !== undefined) updates.currency = currency;
  if (isActive !== undefined) updates.isActive = isActive;

  const [row] = await db.update(shopBundlesTable)
    .set(updates)
    .where(and(eq(shopBundlesTable.id, bundleId), eq(shopBundlesTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Bundle not found" }); return; } }
  res.json(row);
});

// DELETE /organizations/:orgId/shop/bundles/:bundleId
router.delete("/bundles/:bundleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(shopBundlesTable).where(and(eq(shopBundlesTable.id, bundleId), eq(shopBundlesTable.organizationId, orgId)));
  res.json({ success: true });
});

// POST /organizations/:orgId/shop/bundles/:bundleId/components
router.post("/bundles/:bundleId/components", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify bundle belongs to this org
  const [bundle] = await db.select({ id: shopBundlesTable.id })
    .from(shopBundlesTable)
    .where(and(eq(shopBundlesTable.id, bundleId), eq(shopBundlesTable.organizationId, orgId)));
  if (!bundle) { { res.status(404).json({ error: "Bundle not found" }); return; } }

  const { productId, variantId, quantity } = req.body;
  if (!productId) { { res.status(400).json({ error: "productId required" }); return; } }

  // Verify product belongs to this org
  const [product] = await db.select({ id: shopProductsTable.id })
    .from(shopProductsTable)
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)));
  if (!product) { { res.status(403).json({ error: "Product does not belong to this organisation" }); return; } }

  // Verify variantId (if supplied) belongs to this org and to the correct product
  if (variantId) {
    const [variant] = await db.select({ id: shopProductVariantsTable.id })
      .from(shopProductVariantsTable)
      .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
      .where(and(
        eq(shopProductVariantsTable.id, variantId),
        eq(shopProductVariantsTable.productId, productId),
        eq(shopProductsTable.organizationId, orgId),
      ));
    if (!variant) { { res.status(403).json({ error: "Variant does not belong to this product/organisation" }); return; } }
  }

  const [row] = await db.insert(shopBundleComponentsTable).values({
    bundleId,
    productId,
    variantId: variantId ?? null,
    quantity: quantity ?? 1,
  }).returning();

  res.status(201).json(row);
});

// DELETE /organizations/:orgId/shop/bundles/:bundleId/components/:componentId
router.delete("/bundles/:bundleId/components/:componentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  const componentId = parseInt(String((req.params as Record<string, string>).componentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Verify bundle belongs to this org (IDOR protection)
  const [bundle] = await db.select({ id: shopBundlesTable.id })
    .from(shopBundlesTable)
    .where(and(eq(shopBundlesTable.id, bundleId), eq(shopBundlesTable.organizationId, orgId)));
  if (!bundle) { { res.status(404).json({ error: "Bundle not found" }); return; } }

  // Only delete the component if it belongs to this bundle
  await db.delete(shopBundleComponentsTable).where(
    and(eq(shopBundleComponentsTable.id, componentId), eq(shopBundleComponentsTable.bundleId, bundleId))
  );
  res.json({ success: true });
});

// POST /organizations/:orgId/shop/bundles/:bundleId/sell — POS/shop bundle sale: decrement component stock
router.post("/bundles/:bundleId/sell", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  if (!await requireOrgAdminOrProShop(req, res, orgId)) return;

  const [bundle] = await db.select().from(shopBundlesTable)
    .where(and(eq(shopBundlesTable.id, bundleId), eq(shopBundlesTable.organizationId, orgId)));
  if (!bundle) { { res.status(404).json({ error: "Bundle not found" }); return; } }

  const components = await db.select().from(shopBundleComponentsTable)
    .where(eq(shopBundleComponentsTable.bundleId, bundleId));

  const lowStockWarnings: { variantId: number; remaining: number }[] = [];

  for (const comp of components) {
    if (comp.variantId) {
      const [variant] = await db.select({ stockQty: shopProductVariantsTable.stockQty })
        .from(shopProductVariantsTable).where(eq(shopProductVariantsTable.id, comp.variantId));

      const newQty = Math.max(0, (variant?.stockQty ?? 0) - comp.quantity);
      await db.update(shopProductVariantsTable)
        .set({ stockQty: newQty })
        .where(eq(shopProductVariantsTable.id, comp.variantId));

      await db.insert(shopStockAdjustmentsTable).values({
        organizationId: orgId,
        variantId: comp.variantId,
        type: "sale",
        qtyDelta: -comp.quantity,
        reason: `Bundle sale: ${bundle.name}`,
      });

      if (newQty <= 5) lowStockWarnings.push({ variantId: comp.variantId, remaining: newQty });
    }
  }

  res.json({ success: true, bundleId, lowStockWarnings });
});

export default router;
