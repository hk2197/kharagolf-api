import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  promotionsTable, promotionRedemptionsTable,
  affiliateCodesTable, affiliateRedemptionsTable,
  bundleDealsTable, shopStoreSettingsTable,
  shopProductsTable, shopProductVariantsTable, shopOrdersTable,
  shopCategoryFlashSalesTable,
  orgMembershipsTable, membershipTiersTable, clubMembersTable,
  loyaltyAccountsTable, loyaltyTransactionsTable, loyaltyProgramTable,
  appUsersTable,
} from "@workspace/db";
import { eq, and, desc, sum, count, gte, lte, sql, inArray } from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "tournament_director") && Number(user.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

// ─── DISCOUNT EVALUATION ENGINE ─────────────────────────────────────────────

type DiscountEntry = {
  type: "member" | "promo" | "loyalty" | "bundle" | "affiliate" | "flash_sale";
  label: string;
  amount: number;
  pct?: number;
  commission?: number;
};

export type CartEvaluationInput = {
  orgId: number;
  userId?: number;
  items: Array<{ productId: number; variantId?: number; qty: number; unitPrice: number; category: string }>;
  cartTotal: number;
  promoCode?: string;
  affiliateCode?: string;
  loyaltyPointsToRedeem?: number;
};

export type CartEvaluationResult = {
  discounts: DiscountEntry[];
  discountTotal: number;
  finalTotal: number;
  loyaltyPointsRedeemed: number;
  loyaltyDeductionValue: number;
  stackingPolicy: string;
  promoId?: number;
  affiliateCodeId?: number;
  affiliateCommission?: number;
};

export async function evaluateCartDiscounts(input: CartEvaluationInput): Promise<CartEvaluationResult> {
  const { orgId, userId, items, cartTotal, promoCode, affiliateCode, loyaltyPointsToRedeem = 0 } = input;

  const now = new Date();
  const candidates: DiscountEntry[] = [];

  const [settings] = await db.select().from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));
  const policy = settings?.discountStackingPolicy ?? "promo_member";
  const pointsPerUnit = settings?.loyaltyPointsPerCurrencyUnit ?? 100;
  const maxLoyaltyPct = settings?.loyaltyMaxRedemptionPct ?? 20;

  let promoId: number | undefined;
  let affiliateCodeId: number | undefined;
  let affiliateCommission = 0;
  let memberDiscountPct = 0;

  // 1. Flash sale discount — exactly ONE flash source per item: variant > product > category
  //    If a variant or product flash sale applies, the category flash sale is skipped for that item.
  let flashSaveTotal = 0;
  const categoryFlashSales = await db.select()
    .from(shopCategoryFlashSalesTable)
    .where(and(
      eq(shopCategoryFlashSalesTable.organizationId, orgId),
      eq(shopCategoryFlashSalesTable.isActive, true),
      lte(shopCategoryFlashSalesTable.saleStart, now),
      gte(shopCategoryFlashSalesTable.saleEnd, now),
    ));

  for (const item of items) {
    let flashSaving = 0;

    // Priority 1: variant-level flash sale
    if (item.variantId) {
      const [variant] = await db.select({
        salePrice: shopProductVariantsTable.salePrice,
        saleStart: shopProductVariantsTable.saleStart,
        saleEnd: shopProductVariantsTable.saleEnd,
      }).from(shopProductVariantsTable).where(eq(shopProductVariantsTable.id, item.variantId));

      if (variant?.salePrice && variant.saleStart && variant.saleEnd) {
        const start = new Date(variant.saleStart);
        const end = new Date(variant.saleEnd);
        if (now >= start && now <= end) {
          const salePrice = parseFloat(String(variant.salePrice));
          flashSaving = (item.unitPrice - salePrice) * item.qty;
        }
      }
    }

    // Priority 2: product-level flash sale (only if no variant flash applies)
    if (flashSaving === 0) {
      const [product] = await db.select({
        salePrice: shopProductsTable.salePrice,
        saleStart: shopProductsTable.saleStart,
        saleEnd: shopProductsTable.saleEnd,
      }).from(shopProductsTable).where(eq(shopProductsTable.id, item.productId));

      if (product?.salePrice && product.saleStart && product.saleEnd) {
        const start = new Date(product.saleStart);
        const end = new Date(product.saleEnd);
        if (now >= start && now <= end) {
          const salePrice = parseFloat(String(product.salePrice));
          flashSaving = (item.unitPrice - salePrice) * item.qty;
        }
      }
    }

    // Priority 3: category-level flash sale (only if no variant or product flash applies)
    if (flashSaving === 0 && categoryFlashSales.length > 0) {
      const catSale = categoryFlashSales.find(s => s.category === item.category);
      if (catSale) {
        flashSaving = item.unitPrice * item.qty * parseFloat(String(catSale.discountPct)) / 100;
      }
    }

    if (flashSaving > 0) flashSaveTotal += flashSaving;
  }

  if (flashSaveTotal > 0) {
    candidates.push({ type: "flash_sale", label: "Flash Sale", amount: +flashSaveTotal.toFixed(2) });
  }

  // 2. Member tier discount (including per-product tier price overrides)
  if (userId) {
    const [member] = await db.select({ tierId: clubMembersTable.tierId })
      .from(clubMembersTable)
      .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.userId, userId)));

    if (member?.tierId) {
      const [tier] = await db.select({
        name: membershipTiersTable.name,
        shopDiscountPct: membershipTiersTable.shopDiscountPct,
        shopCategoryDiscounts: membershipTiersTable.shopCategoryDiscounts,
      }).from(membershipTiersTable).where(eq(membershipTiersTable.id, member.tierId));

      if (tier) {
        const categoryDiscounts = (tier.shopCategoryDiscounts ?? {}) as Record<string, number>;
        const tierIdStr = String(member.tierId);
        let memberSaving = 0;

        // Fetch per-product tier pricing for all items in the cart
        const productIds = [...new Set(items.filter(i => i.productId > 0).map(i => i.productId))];
        const productTierPricing: Record<number, Record<string, number>> = {};
        if (productIds.length > 0) {
          const productRows = await db.select({ id: shopProductsTable.id, tierPricing: shopProductsTable.tierPricing })
            .from(shopProductsTable)
            .where(inArray(shopProductsTable.id, productIds));
          for (const p of productRows) {
            if (p.tierPricing) productTierPricing[p.id] = p.tierPricing as Record<string, number>;
          }
        }

        // Fetch per-variant tier pricing for all variant items in the cart
        const variantIds = [...new Set(items.filter(i => i.variantId).map(i => i.variantId as number))];
        const variantTierPricing: Record<number, Record<string, number>> = {};
        if (variantIds.length > 0) {
          const variantRows = await db.select({ id: shopProductVariantsTable.id, tierPricing: shopProductVariantsTable.tierPricing })
            .from(shopProductVariantsTable)
            .where(inArray(shopProductVariantsTable.id, variantIds));
          for (const v of variantRows) {
            if (v.tierPricing) variantTierPricing[v.id] = v.tierPricing as Record<string, number>;
          }
        }

        for (const item of items) {
          // Variant-level tier price override takes highest precedence
          const variantOverridePrice = item.variantId ? variantTierPricing[item.variantId]?.[tierIdStr] : undefined;
          if (variantOverridePrice !== undefined && variantOverridePrice < item.unitPrice) {
            memberSaving += (item.unitPrice - variantOverridePrice) * item.qty;
          } else {
            // Check product-level tier price override
            const tierOverridePrice = productTierPricing[item.productId]?.[tierIdStr];
            if (tierOverridePrice !== undefined && tierOverridePrice < item.unitPrice) {
              // Per-product tier price override: discount = (markupPrice - tierPrice) * qty
              memberSaving += (item.unitPrice - tierOverridePrice) * item.qty;
            } else {
              // Fallback: tier-level percentage discount (global% or per-category%)
              const catPct = categoryDiscounts[item.category] ?? parseFloat(String(tier.shopDiscountPct ?? "0"));
              memberSaving += (item.unitPrice * item.qty) * (catPct / 100);
            }
          }
        }
        memberDiscountPct = parseFloat(String(tier.shopDiscountPct ?? "0"));
        if (memberSaving > 0) {
          candidates.push({
            type: "member",
            label: `${tier.name} Member Discount`,
            amount: +memberSaving.toFixed(2),
            pct: memberDiscountPct,
          });
        }
      }
    }
  }

  // 3. Promo code
  if (promoCode) {
    const [promo] = await db.select().from(promotionsTable)
      .where(and(
        eq(promotionsTable.organizationId, orgId),
        eq(promotionsTable.code, promoCode.toUpperCase()),
        eq(promotionsTable.isActive, true),
      ));

    if (promo) {
      const now2 = new Date();
      const valid = (!promo.validFrom || now2 >= new Date(promo.validFrom)) &&
                    (!promo.validTo || now2 <= new Date(promo.validTo)) &&
                    (!promo.usageLimit || promo.usedCount < promo.usageLimit);

      const minOrder = parseFloat(String(promo.minOrderValue ?? "0"));

      // Single-use per user enforcement
      let alreadyUsedByUser = false;
      if (promo.singleUsePerUser && userId) {
        const [existingRedemption] = await db.select({ id: promotionRedemptionsTable.id })
          .from(promotionRedemptionsTable)
          .where(and(
            eq(promotionRedemptionsTable.promotionId, promo.id),
            eq(promotionRedemptionsTable.userId, userId),
          ));
        alreadyUsedByUser = !!existingRedemption;
      }

      if (valid && !alreadyUsedByUser && cartTotal >= minOrder) {
        let promoDiscount = 0;
        // Both percentage and fixed discounts must respect scope.
        // getScopedTotal returns 0 when the cart has no qualifying items (scope miss).
        const scopedTotal = getScopedTotal(items, promo.scope, promo.scopeValues as string[] | null);
        if (scopedTotal > 0) {
          if (promo.discountType === "percentage") {
            promoDiscount = scopedTotal * (parseFloat(String(promo.discountValue)) / 100);
          } else {
            // Cap fixed discount to scoped subtotal so it cannot exceed qualifying items
            promoDiscount = Math.min(parseFloat(String(promo.discountValue)), scopedTotal);
          }
        }
        promoId = promo.id;
        candidates.push({
          type: "promo",
          label: `Promo: ${promo.code}`,
          amount: +Math.min(promoDiscount, cartTotal).toFixed(2),
          pct: promo.discountType === "percentage" ? parseFloat(String(promo.discountValue)) : undefined,
        });
      }
    }
  }

  // 4. Affiliate code buyer discount
  if (affiliateCode) {
    const [aff] = await db.select().from(affiliateCodesTable)
      .where(and(
        eq(affiliateCodesTable.organizationId, orgId),
        eq(affiliateCodesTable.code, affiliateCode.toUpperCase()),
        eq(affiliateCodesTable.isActive, true),
      ));

    if (aff) {
      const now3 = new Date();
      const valid = (!aff.validFrom || now3 >= new Date(aff.validFrom)) &&
                    (!aff.validTo || now3 <= new Date(aff.validTo));

      if (valid) {
        let affDiscount = 0;
        if (aff.buyerDiscountType === "percentage") {
          affDiscount = cartTotal * (parseFloat(String(aff.buyerDiscountValue)) / 100);
        } else {
          affDiscount = parseFloat(String(aff.buyerDiscountValue));
        }

        if (aff.commissionType === "percentage") {
          affiliateCommission = cartTotal * (parseFloat(String(aff.commissionValue)) / 100);
        } else {
          affiliateCommission = parseFloat(String(aff.commissionValue));
        }

        affiliateCodeId = aff.id;
        if (affDiscount > 0) {
          candidates.push({
            type: "affiliate",
            label: `Referral: ${aff.code}`,
            amount: +Math.min(affDiscount, cartTotal).toFixed(2),
            pct: aff.buyerDiscountType === "percentage" ? parseFloat(String(aff.buyerDiscountValue)) : undefined,
            commission: +affiliateCommission.toFixed(2),
          });
        }
      }
    }
  }

  // 5. Bundle deals
  const activeBundles = await db.select().from(bundleDealsTable)
    .where(and(eq(bundleDealsTable.organizationId, orgId), eq(bundleDealsTable.isActive, true)));

  for (const bundle of activeBundles) {
    if (bundle.validFrom && new Date(bundle.validFrom) > now) continue;
    if (bundle.validTo && new Date(bundle.validTo) < now) continue;

    let bundleDiscount = 0;
    const requiredIds = (bundle.requiredProductIds ?? []) as number[];
    const targetCategory = bundle.targetCategory;
    const minQty = bundle.minQuantity;

    if (bundle.dealType === "multi_product" && requiredIds.length > 0) {
      const cartProductIds = items.map(i => i.productId);
      const hasAll = requiredIds.every(id => cartProductIds.includes(id));
      if (hasAll) {
        if (bundle.cheapestItemFree) {
          const bundleItems = items.filter(i => requiredIds.includes(i.productId));
          const cheapest = Math.min(...bundleItems.map(i => i.unitPrice));
          bundleDiscount = cheapest;
        } else {
          const bundleTotal = items.filter(i => requiredIds.includes(i.productId)).reduce((s, i) => s + i.unitPrice * i.qty, 0);
          if (bundle.discountType === "percentage") {
            bundleDiscount = bundleTotal * (parseFloat(String(bundle.discountValue)) / 100);
          } else {
            bundleDiscount = parseFloat(String(bundle.discountValue));
          }
        }
      }
    } else if (bundle.dealType === "category_quantity" && targetCategory) {
      const catItems = items.filter(i => i.category === targetCategory);
      const totalQty = catItems.reduce((s, i) => s + i.qty, 0);
      if (totalQty >= minQty) {
        if (bundle.cheapestItemFree) {
          bundleDiscount = Math.min(...catItems.map(i => i.unitPrice));
        } else {
          const catTotal = catItems.reduce((s, i) => s + i.unitPrice * i.qty, 0);
          if (bundle.discountType === "percentage") {
            bundleDiscount = catTotal * (parseFloat(String(bundle.discountValue)) / 100);
          } else {
            bundleDiscount = parseFloat(String(bundle.discountValue));
          }
        }
      }
    }

    if (bundleDiscount > 0) {
      candidates.push({
        type: "bundle",
        label: bundle.name,
        amount: +bundleDiscount.toFixed(2),
      });
    }
  }

  // 6. Loyalty point redemption — treated as a first-class discount candidate
  //    subject to the same stacking policy as all other discount types.
  if (userId && loyaltyPointsToRedeem > 0) {
    const [loyaltyAccount] = await db.select({ pointsBalance: loyaltyAccountsTable.pointsBalance })
      .from(loyaltyAccountsTable)
      .where(and(eq(loyaltyAccountsTable.organizationId, orgId), eq(loyaltyAccountsTable.userId, userId)));

    if (loyaltyAccount && loyaltyAccount.pointsBalance >= loyaltyPointsToRedeem) {
      const pointsValue = loyaltyPointsToRedeem / pointsPerUnit;
      // Use the provisional pre-policy candidate sum to estimate the remaining-after-discounts cap.
      // Under "none" policy (one winner) provisional sum = all other candidates; under "all" = same.
      // This gives a conservative (correct) cap in all policy modes.
      const provisionalOtherDiscounts = candidates.reduce((s, d) => s + d.amount, 0);
      const maxLoyaltyDeduction = ((cartTotal - provisionalOtherDiscounts) * maxLoyaltyPct) / 100;
      const loyaltyDeductionValue = +Math.min(pointsValue, Math.max(0, maxLoyaltyDeduction)).toFixed(2);
      const loyaltyPointsCandidate = Math.round(loyaltyDeductionValue * pointsPerUnit);

      if (loyaltyDeductionValue > 0) {
        candidates.push({
          type: "loyalty",
          label: `${loyaltyPointsCandidate} Loyalty Points`,
          amount: loyaltyDeductionValue,
        });
      }
    }
  }

  // Apply stacking policy — loyalty is now a full candidate evaluated alongside other types
  const selectedDiscounts = applyStackingPolicy(candidates, policy, settings?.stackingPriority as string[] | null, settings?.stackingMaxLayers ?? null);

  // Derive final counts from what the policy actually selected
  if (promoId && !selectedDiscounts.some(d => d.type === "promo")) {
    promoId = undefined;
  }
  if (affiliateCodeId && !selectedDiscounts.some(d => d.type === "affiliate")) {
    affiliateCodeId = undefined;
    affiliateCommission = 0;
  }
  const selectedLoyalty = selectedDiscounts.find(d => d.type === "loyalty");
  const loyaltyPointsRedeemed = selectedLoyalty ? Math.round(selectedLoyalty.amount * pointsPerUnit) : 0;
  const loyaltyDeductionValue = selectedLoyalty?.amount ?? 0;

  const discountTotal = selectedDiscounts.reduce((s, d) => s + d.amount, 0);
  const finalTotal = Math.max(0, cartTotal - discountTotal);

  return {
    discounts: selectedDiscounts,
    discountTotal: +discountTotal.toFixed(2),
    finalTotal: +finalTotal.toFixed(2),
    loyaltyPointsRedeemed,
    loyaltyDeductionValue,
    stackingPolicy: policy,
    promoId,
    affiliateCodeId,
    affiliateCommission: +affiliateCommission.toFixed(2),
  };
}

function getScopedTotal(
  items: Array<{ productId: number; qty: number; unitPrice: number; category: string }>,
  scope: string,
  scopeValues: string[] | null,
): number {
  if (scope === "all" || !scopeValues || scopeValues.length === 0) {
    return items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
  }
  if (scope === "category") {
    return items.filter(i => scopeValues.includes(i.category)).reduce((s, i) => s + i.unitPrice * i.qty, 0);
  }
  if (scope === "product") {
    const ids = scopeValues.map(Number);
    return items.filter(i => ids.includes(i.productId)).reduce((s, i) => s + i.unitPrice * i.qty, 0);
  }
  return items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
}

function applyStackingPolicy(
  candidates: DiscountEntry[],
  policy: string,
  priority: string[] | null,
  maxLayers: number | null,
): DiscountEntry[] {
  if (candidates.length === 0) return [];

  if (policy === "none") {
    const best = candidates.reduce((a, b) => a.amount >= b.amount ? a : b);
    return [best];
  }

  if (policy === "promo_member") {
    return candidates.filter(d => d.type === "promo" || d.type === "member" || d.type === "flash_sale");
  }

  if (policy === "all") {
    return candidates;
  }

  if (policy === "custom" && priority && priority.length > 0) {
    const sorted = [...candidates].sort((a, b) => {
      const ai = priority.indexOf(a.type);
      const bi = priority.indexOf(b.type);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    const limit = maxLayers ?? sorted.length;
    return sorted.slice(0, limit);
  }

  return candidates;
}

// ─── PROMOTIONS CRUD ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/promotions
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const promos = await db.select().from(promotionsTable)
    .where(eq(promotionsTable.organizationId, orgId))
    .orderBy(desc(promotionsTable.createdAt));

  res.json(promos);
});

// POST /organizations/:orgId/shop/promotions
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    code, description, discountType, discountValue, minOrderValue,
    usageLimit, scope, scopeValues, validFrom, validTo, singleUsePerUser,
  } = req.body;

  if (!code || !discountValue) {
    res.status(400).json({ error: "code and discountValue are required" }); return;
  }

  const user = req.user as { id: number };

  const [promo] = await db.insert(promotionsTable).values({
    organizationId: orgId,
    code: String(code).toUpperCase().trim(),
    description: description ?? null,
    discountType: discountType ?? "percentage",
    discountValue: String(discountValue),
    minOrderValue: String(minOrderValue ?? "0"),
    usageLimit: usageLimit ?? null,
    scope: scope ?? "all",
    scopeValues: scopeValues ?? null,
    validFrom: validFrom ? new Date(validFrom) : null,
    validTo: validTo ? new Date(validTo) : null,
    singleUsePerUser: singleUsePerUser ?? false,
    createdByUserId: user.id,
  }).returning();

  res.status(201).json(promo);
});

// PUT /organizations/:orgId/shop/promotions/:promoId
router.put("/:promoId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const promoId = parseInt(String((req.params as Record<string, string>).promoId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    code, description, discountType, discountValue, minOrderValue,
    usageLimit, scope, scopeValues, validFrom, validTo, isActive, singleUsePerUser,
  } = req.body;

  const [promo] = await db.update(promotionsTable)
    .set({
      code: code ? String(code).toUpperCase().trim() : undefined,
      description,
      discountType,
      discountValue: discountValue ? String(discountValue) : undefined,
      minOrderValue: minOrderValue !== undefined ? String(minOrderValue) : undefined,
      usageLimit,
      scope,
      scopeValues,
      validFrom: validFrom ? new Date(validFrom) : null,
      validTo: validTo ? new Date(validTo) : null,
      isActive,
      singleUsePerUser,
      updatedAt: new Date(),
    })
    .where(and(eq(promotionsTable.id, promoId), eq(promotionsTable.organizationId, orgId)))
    .returning();

  if (!promo) { { res.status(404).json({ error: "Promotion not found" }); return; } }
  res.json(promo);
});

// DELETE /organizations/:orgId/shop/promotions/:promoId
router.delete("/:promoId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const promoId = parseInt(String((req.params as Record<string, string>).promoId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.update(promotionsTable).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(promotionsTable.id, promoId), eq(promotionsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// GET /organizations/:orgId/shop/promotions/stats — dashboard stats
router.get("/stats", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const now = new Date();

  const activePromos = await db.select({
    id: promotionsTable.id,
    code: promotionsTable.code,
    description: promotionsTable.description,
    discountType: promotionsTable.discountType,
    discountValue: promotionsTable.discountValue,
    usedCount: promotionsTable.usedCount,
    usageLimit: promotionsTable.usageLimit,
    validTo: promotionsTable.validTo,
    isActive: promotionsTable.isActive,
  }).from(promotionsTable)
    .where(and(eq(promotionsTable.organizationId, orgId), eq(promotionsTable.isActive, true)));

  const [redeemStats] = await db.select({
    totalRedemptions: count(promotionRedemptionsTable.id),
    totalDiscount: sum(promotionRedemptionsTable.discountAmount),
  }).from(promotionRedemptionsTable)
    .where(eq(promotionRedemptionsTable.organizationId, orgId));

  const affiliateStats = await db.select({
    id: affiliateCodesTable.id,
    code: affiliateCodesTable.code,
    ownerName: affiliateCodesTable.ownerName,
    totalOrders: affiliateCodesTable.totalOrders,
    totalDiscountGiven: affiliateCodesTable.totalDiscountGiven,
    totalCommissionEarned: affiliateCodesTable.totalCommissionEarned,
    isActive: affiliateCodesTable.isActive,
  }).from(affiliateCodesTable)
    .where(eq(affiliateCodesTable.organizationId, orgId))
    .orderBy(desc(affiliateCodesTable.totalCommissionEarned));

  // Revenue impact: gross (list price) vs net (after all discounts) for paid shop orders.
  // NOTE: Multi-item carts create multiple shop_orders rows sharing the same razorpay_order_id,
  //       each carrying the full cart discountTotal. We deduplicate per cart to avoid inflation.
  const revenueResult = await db.execute(sql`
    SELECT
      (
        SELECT COALESCE(SUM(total_amount), 0)
        FROM shop_orders
        WHERE organization_id = ${orgId} AND status = 'paid'
      ) AS net_revenue,
      (
        SELECT COALESCE(SUM(discount_total), 0)
        FROM (
          SELECT DISTINCT ON (COALESCE(razorpay_order_id::text, id::text))
            discount_total
          FROM shop_orders
          WHERE organization_id = ${orgId} AND status = 'paid'
          ORDER BY COALESCE(razorpay_order_id::text, id::text), id
        ) carts
      ) AS total_discount
  `);
  const rr = (revenueResult.rows as Record<string, unknown>[])[0] ?? {};
  const netRevenue = parseFloat(String(rr.net_revenue ?? "0"));
  const totalDiscountFromOrders = parseFloat(String(rr.total_discount ?? "0"));
  const grossRevenue = +(netRevenue + totalDiscountFromOrders).toFixed(2);

  res.json({
    activePromotions: activePromos,
    totalRedemptions: Number(redeemStats?.totalRedemptions ?? 0),
    totalDiscountGiven: parseFloat(String(redeemStats?.totalDiscount ?? "0")),
    affiliates: affiliateStats,
    revenueImpact: {
      grossRevenue,
      netRevenue: +netRevenue.toFixed(2),
      totalDiscountFromOrders: +totalDiscountFromOrders.toFixed(2),
    },
  });
});

// ─── PROMO CODE VALIDATION ────────────────────────────────────────────────────

// POST /organizations/:orgId/shop/promotions/validate
router.post("/validate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const {
    code, cartTotal, items, loyaltyPointsToRedeem, affiliateCode,
  } = req.body as {
    code?: string;
    cartTotal: number;
    items: Array<{ productId: number; qty: number; unitPrice: number; category: string }>;
    loyaltyPointsToRedeem?: number;
    affiliateCode?: string;
  };

  const userId = (req.user as { id: number }).id;

  const result = await evaluateCartDiscounts({
    orgId,
    userId,
    items,
    cartTotal,
    promoCode: code,
    affiliateCode,
    loyaltyPointsToRedeem,
  });

  res.json(result);
});

// ─── AFFILIATE CODES CRUD ─────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/promotions/affiliates
router.get("/affiliates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const codes = await db.select().from(affiliateCodesTable)
    .where(eq(affiliateCodesTable.organizationId, orgId))
    .orderBy(desc(affiliateCodesTable.createdAt));

  res.json(codes);
});

// GET /organizations/:orgId/shop/promotions/affiliates/:codeId/performance
router.get("/affiliates/:codeId/performance", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const codeId = parseInt(String((req.params as Record<string, string>).codeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [code] = await db.select().from(affiliateCodesTable)
    .where(and(eq(affiliateCodesTable.id, codeId), eq(affiliateCodesTable.organizationId, orgId)));
  if (!code) { { res.status(404).json({ error: "Affiliate code not found" }); return; } }

  const redemptions = await db.select().from(affiliateRedemptionsTable)
    .where(eq(affiliateRedemptionsTable.affiliateCodeId, codeId))
    .orderBy(desc(affiliateRedemptionsTable.redeemedAt))
    .limit(100);

  res.json({ code, redemptions });
});

// POST /organizations/:orgId/shop/promotions/affiliates
router.post("/affiliates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    code, description, ownerUserId, ownerName, ownerEmail,
    commissionType, commissionValue,
    buyerDiscountType, buyerDiscountValue,
    validFrom, validTo,
  } = req.body;

  if (!code) { { res.status(400).json({ error: "code is required" }); return; } }

  const [aff] = await db.insert(affiliateCodesTable).values({
    organizationId: orgId,
    code: String(code).toUpperCase().trim(),
    description: description ?? null,
    ownerUserId: ownerUserId ?? null,
    ownerName: ownerName ?? null,
    ownerEmail: ownerEmail ?? null,
    commissionType: commissionType ?? "percentage",
    commissionValue: String(commissionValue ?? "0"),
    buyerDiscountType: buyerDiscountType ?? "percentage",
    buyerDiscountValue: String(buyerDiscountValue ?? "0"),
    validFrom: validFrom ? new Date(validFrom) : null,
    validTo: validTo ? new Date(validTo) : null,
  }).returning();

  res.status(201).json(aff);
});

// PUT /organizations/:orgId/shop/promotions/affiliates/:codeId
router.put("/affiliates/:codeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const codeId = parseInt(String((req.params as Record<string, string>).codeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    code, description, ownerName, ownerEmail,
    commissionType, commissionValue,
    buyerDiscountType, buyerDiscountValue,
    validFrom, validTo, isActive,
  } = req.body;

  const [aff] = await db.update(affiliateCodesTable)
    .set({
      code: code ? String(code).toUpperCase().trim() : undefined,
      description,
      ownerName,
      ownerEmail,
      commissionType,
      commissionValue: commissionValue !== undefined ? String(commissionValue) : undefined,
      buyerDiscountType,
      buyerDiscountValue: buyerDiscountValue !== undefined ? String(buyerDiscountValue) : undefined,
      validFrom: validFrom ? new Date(validFrom) : undefined,
      validTo: validTo ? new Date(validTo) : undefined,
      isActive,
      updatedAt: new Date(),
    })
    .where(and(eq(affiliateCodesTable.id, codeId), eq(affiliateCodesTable.organizationId, orgId)))
    .returning();

  if (!aff) { { res.status(404).json({ error: "Affiliate code not found" }); return; } }
  res.json(aff);
});

// DELETE /organizations/:orgId/shop/promotions/affiliates/:codeId
router.delete("/affiliates/:codeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const codeId = parseInt(String((req.params as Record<string, string>).codeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.update(affiliateCodesTable).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(affiliateCodesTable.id, codeId), eq(affiliateCodesTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── BUNDLE DEALS CRUD ────────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/promotions/bundles
router.get("/bundles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const bundles = await db.select().from(bundleDealsTable)
    .where(eq(bundleDealsTable.organizationId, orgId))
    .orderBy(desc(bundleDealsTable.createdAt));

  res.json(bundles);
});

// POST /organizations/:orgId/shop/promotions/bundles
router.post("/bundles", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    name, description, dealType, requiredProductIds, targetCategory,
    minQuantity, discountType, discountValue, cheapestItemFree, validFrom, validTo,
  } = req.body;

  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [bundle] = await db.insert(bundleDealsTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    dealType: dealType ?? "multi_product",
    requiredProductIds: requiredProductIds ?? null,
    targetCategory: targetCategory ?? null,
    minQuantity: minQuantity ?? 2,
    discountType: discountType ?? "percentage",
    discountValue: String(discountValue ?? "0"),
    cheapestItemFree: cheapestItemFree ?? false,
    validFrom: validFrom ? new Date(validFrom) : null,
    validTo: validTo ? new Date(validTo) : null,
  }).returning();

  res.status(201).json(bundle);
});

// PUT /organizations/:orgId/shop/promotions/bundles/:bundleId
router.put("/bundles/:bundleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    name, description, dealType, requiredProductIds, targetCategory,
    minQuantity, discountType, discountValue, cheapestItemFree, isActive, validFrom, validTo,
  } = req.body;

  const [bundle] = await db.update(bundleDealsTable)
    .set({
      name, description, dealType, requiredProductIds, targetCategory,
      minQuantity, discountType,
      discountValue: discountValue !== undefined ? String(discountValue) : undefined,
      cheapestItemFree, isActive,
      validFrom: validFrom ? new Date(validFrom) : undefined,
      validTo: validTo ? new Date(validTo) : undefined,
      updatedAt: new Date(),
    })
    .where(and(eq(bundleDealsTable.id, bundleId), eq(bundleDealsTable.organizationId, orgId)))
    .returning();

  if (!bundle) { { res.status(404).json({ error: "Bundle deal not found" }); return; } }
  res.json(bundle);
});

// DELETE /organizations/:orgId/shop/promotions/bundles/:bundleId
router.delete("/bundles/:bundleId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bundleId = parseInt(String((req.params as Record<string, string>).bundleId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.update(bundleDealsTable).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(bundleDealsTable.id, bundleId), eq(bundleDealsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── STACKING POLICY SETTINGS ─────────────────────────────────────────────────

// GET /organizations/:orgId/shop/promotions/stacking-policy
router.get("/stacking-policy", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [settings] = await db.select({
    discountStackingPolicy: shopStoreSettingsTable.discountStackingPolicy,
    stackingPriority: shopStoreSettingsTable.stackingPriority,
    stackingMaxLayers: shopStoreSettingsTable.stackingMaxLayers,
    loyaltyPointsPerCurrencyUnit: shopStoreSettingsTable.loyaltyPointsPerCurrencyUnit,
    loyaltyMaxRedemptionPct: shopStoreSettingsTable.loyaltyMaxRedemptionPct,
  }).from(shopStoreSettingsTable).where(eq(shopStoreSettingsTable.organizationId, orgId));

  res.json(settings ?? {
    discountStackingPolicy: "promo_member",
    stackingPriority: null,
    stackingMaxLayers: null,
    loyaltyPointsPerCurrencyUnit: 100,
    loyaltyMaxRedemptionPct: 20,
  });
});

// PUT /organizations/:orgId/shop/promotions/stacking-policy
router.put("/stacking-policy", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { discountStackingPolicy, stackingPriority, stackingMaxLayers, loyaltyPointsPerCurrencyUnit, loyaltyMaxRedemptionPct } = req.body;

  const existing = await db.select({ id: shopStoreSettingsTable.id }).from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, orgId));

  if (existing.length > 0) {
    await db.update(shopStoreSettingsTable)
      .set({
        discountStackingPolicy: discountStackingPolicy ?? "promo_member",
        stackingPriority: stackingPriority ?? null,
        stackingMaxLayers: stackingMaxLayers ?? null,
        loyaltyPointsPerCurrencyUnit: loyaltyPointsPerCurrencyUnit ?? 100,
        loyaltyMaxRedemptionPct: loyaltyMaxRedemptionPct ?? 20,
        updatedAt: new Date(),
      })
      .where(eq(shopStoreSettingsTable.organizationId, orgId));
  } else {
    await db.insert(shopStoreSettingsTable).values({
      organizationId: orgId,
      discountStackingPolicy: discountStackingPolicy ?? "promo_member",
      stackingPriority: stackingPriority ?? null,
      stackingMaxLayers: stackingMaxLayers ?? null,
      loyaltyPointsPerCurrencyUnit: loyaltyPointsPerCurrencyUnit ?? 100,
      loyaltyMaxRedemptionPct: loyaltyMaxRedemptionPct ?? 20,
    });
  }

  res.json({ ok: true });
});

// ─── FLASH SALE MANAGEMENT ────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/promotions/flash-sales
router.get("/flash-sales", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  // Return ALL active products so admins can create new flash sales from any product
  const products = await db.select({
    id: shopProductsTable.id,
    name: shopProductsTable.name,
    markupPrice: shopProductsTable.markupPrice,
    salePrice: shopProductsTable.salePrice,
    saleStart: shopProductsTable.saleStart,
    saleEnd: shopProductsTable.saleEnd,
    category: shopProductsTable.category,
    isActive: shopProductsTable.isActive,
  }).from(shopProductsTable)
    .where(eq(shopProductsTable.organizationId, orgId))
    .orderBy(desc(shopProductsTable.saleStart));

  res.json(products);
});

// PUT /organizations/:orgId/shop/promotions/flash-sales/:productId
router.put("/flash-sales/:productId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const productId = parseInt(String((req.params as Record<string, string>).productId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { salePrice, saleStart, saleEnd } = req.body;

  const [product] = await db.update(shopProductsTable)
    .set({
      salePrice: salePrice ? String(salePrice) : null,
      saleStart: saleStart ? new Date(saleStart) : null,
      saleEnd: saleEnd ? new Date(saleEnd) : null,
      updatedAt: new Date(),
    })
    .where(and(eq(shopProductsTable.id, productId), eq(shopProductsTable.organizationId, orgId)))
    .returning({ id: shopProductsTable.id, name: shopProductsTable.name, salePrice: shopProductsTable.salePrice, saleStart: shopProductsTable.saleStart, saleEnd: shopProductsTable.saleEnd });

  if (!product) { { res.status(404).json({ error: "Product not found" }); return; } }
  res.json(product);
});

// ─── CATEGORY FLASH SALES ─────────────────────────────────────────────────────

// GET /organizations/:orgId/shop/promotions/category-flash-sales
router.get("/category-flash-sales", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const sales = await db.select().from(shopCategoryFlashSalesTable)
    .where(eq(shopCategoryFlashSalesTable.organizationId, orgId))
    .orderBy(desc(shopCategoryFlashSalesTable.createdAt));
  res.json(sales);
});

// POST /organizations/:orgId/shop/promotions/category-flash-sales
router.post("/category-flash-sales", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { category, label, discountPct, saleStart, saleEnd, isActive } = req.body;
  if (!category || !discountPct || !saleStart || !saleEnd) {
    res.status(400).json({ error: "category, discountPct, saleStart, saleEnd are required" });
    return;
  }
  const [sale] = await db.insert(shopCategoryFlashSalesTable).values({
    organizationId: orgId,
    category,
    label: label || null,
    discountPct: String(discountPct),
    saleStart: new Date(saleStart),
    saleEnd: new Date(saleEnd),
    isActive: isActive !== false,
  }).returning();
  res.status(201).json(sale);
});

// PUT /organizations/:orgId/shop/promotions/category-flash-sales/:id
router.put("/category-flash-sales/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { category, label, discountPct, saleStart, saleEnd, isActive } = req.body;
  const [sale] = await db.update(shopCategoryFlashSalesTable)
    .set({
      category: category ?? undefined,
      label: label !== undefined ? (label || null) : undefined,
      discountPct: discountPct !== undefined ? String(discountPct) : undefined,
      saleStart: saleStart ? new Date(saleStart) : undefined,
      saleEnd: saleEnd ? new Date(saleEnd) : undefined,
      isActive: isActive !== undefined ? isActive : undefined,
      updatedAt: new Date(),
    })
    .where(and(eq(shopCategoryFlashSalesTable.id, id), eq(shopCategoryFlashSalesTable.organizationId, orgId)))
    .returning();
  if (!sale) { { res.status(404).json({ error: "Not found" }); return; } }
  res.json(sale);
});

// DELETE /organizations/:orgId/shop/promotions/category-flash-sales/:id
router.delete("/category-flash-sales/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(shopCategoryFlashSalesTable)
    .where(and(eq(shopCategoryFlashSalesTable.id, id), eq(shopCategoryFlashSalesTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── MEMBERSHIP TIER DISCOUNTS ────────────────────────────────────────────────

// GET /organizations/:orgId/shop/promotions/tier-discounts
router.get("/tier-discounts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const tiers = await db.select({
    id: membershipTiersTable.id,
    name: membershipTiersTable.name,
    shopDiscountPct: membershipTiersTable.shopDiscountPct,
    shopCategoryDiscounts: membershipTiersTable.shopCategoryDiscounts,
    isActive: membershipTiersTable.isActive,
  }).from(membershipTiersTable)
    .where(eq(membershipTiersTable.organizationId, orgId))
    .orderBy(membershipTiersTable.id);

  res.json(tiers);
});

// PUT /organizations/:orgId/shop/promotions/tier-discounts/:tierId
router.put("/tier-discounts/:tierId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tierId = parseInt(String((req.params as Record<string, string>).tierId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { shopDiscountPct, shopCategoryDiscounts } = req.body;

  const [tier] = await db.update(membershipTiersTable)
    .set({
      shopDiscountPct: String(shopDiscountPct ?? "0"),
      shopCategoryDiscounts: shopCategoryDiscounts ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(membershipTiersTable.id, tierId), eq(membershipTiersTable.organizationId, orgId)))
    .returning();

  if (!tier) { { res.status(404).json({ error: "Tier not found" }); return; } }
  res.json(tier);
});

export default router;
