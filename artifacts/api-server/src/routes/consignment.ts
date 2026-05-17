import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { consignmentItemsTable, orgMembershipsTable, shopProductsTable } from "@workspace/db";
import { eq, and, desc, inArray, or } from "drizzle-orm";
import crypto from "crypto";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser { id: number; role?: string; organizationId?: number }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

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
  if (
    (caller.role === "org_admin" || caller.role === "tournament_director" || caller.role === "pro_shop") &&
    Number(caller.organizationId) === orgId
  ) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "pro_shop"])));
  if (!m) { res.status(403).json({ error: "Staff access required" }); return false; }
  return true;
}

function generateLookupToken(): string {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

function calculatePayout(salePrice: number, commissionRate: number) {
  const commission = (salePrice * commissionRate) / 100;
  const payout = salePrice - commission;
  return { commission: Math.round(commission * 100) / 100, payout: Math.round(payout * 100) / 100 };
}

// ─── LIST ALL ITEMS ───────────────────────────────────────────────────────────

// GET /organizations/:orgId/consignment
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const status = req.query["status"] as string | undefined;
  const conditions: Parameters<typeof and>[0][] = [eq(consignmentItemsTable.organizationId, orgId)];
  if (status && status !== "all") {
    conditions.push(eq(consignmentItemsTable.status, status as "unsold" | "sold" | "payout_pending" | "paid" | "returned"));
  }

  const items = await db.select().from(consignmentItemsTable)
    .where(and(...conditions))
    .orderBy(desc(consignmentItemsTable.createdAt));

  res.json({ items });
});

// ─── CREATE ITEM ──────────────────────────────────────────────────────────────

// POST /organizations/:orgId/consignment
router.post("/", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const {
    consignorName, consignorEmail, consignorPhone, consignorUserId,
    title, description, category, brand, condition,
    askingPrice, currency, commissionRate, imageUrls, notes,
  } = req.body;

  if (!consignorName?.trim()) { { res.status(400).json({ error: "Consignor name is required" }); return; } }
  if (!title?.trim()) { { res.status(400).json({ error: "Item title is required" }); return; } }
  if (!askingPrice || isNaN(parseFloat(askingPrice))) { { res.status(400).json({ error: "Valid asking price is required" }); return; } }

  const lookupToken = generateLookupToken();

  const [item] = await db.insert(consignmentItemsTable).values({
    organizationId: orgId,
    consignorUserId: consignorUserId ? parseInt(consignorUserId) : null,
    consignorName: consignorName.trim(),
    consignorEmail: consignorEmail ?? null,
    consignorPhone: consignorPhone ?? null,
    title: title.trim(),
    description: description ?? null,
    category: category ?? "equipment",
    brand: brand ?? null,
    condition: condition ?? "good",
    askingPrice: String(parseFloat(askingPrice).toFixed(2)),
    currency: currency ?? "INR",
    commissionRate: String(parseFloat(commissionRate ?? "20").toFixed(2)),
    imageUrls: imageUrls ?? [],
    notes: notes ?? null,
    lookupToken,
    createdByUserId: caller.id,
  }).returning();

  res.status(201).json({ item });
});

// ─── GET SINGLE ITEM ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/consignment/:itemId
router.get("/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const itemId = parseInt((req.params as Record<string, string>).itemId);
  const [item] = await db.select().from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  if (!item) { { res.status(404).json({ error: "Consignment item not found" }); return; } }
  res.json({ item });
});

// ─── UPDATE ITEM ──────────────────────────────────────────────────────────────

// PUT /organizations/:orgId/consignment/:itemId
router.put("/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const itemId = parseInt((req.params as Record<string, string>).itemId);
  const [existing] = await db.select({ id: consignmentItemsTable.id, status: consignmentItemsTable.status })
    .from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Consignment item not found" }); return; } }
  if (existing.status === "paid" || existing.status === "returned") {
    res.status(400).json({ error: "Cannot edit a paid-out or returned item" }); return;
  }

  const {
    consignorName, consignorEmail, consignorPhone,
    title, description, category, brand, condition,
    askingPrice, commissionRate, imageUrls, notes, listedInShop,
  } = req.body;

  const [updated] = await db.update(consignmentItemsTable).set({
    ...(consignorName !== undefined ? { consignorName: consignorName.trim() } : {}),
    ...(consignorEmail !== undefined ? { consignorEmail } : {}),
    ...(consignorPhone !== undefined ? { consignorPhone } : {}),
    ...(title !== undefined ? { title: title.trim() } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(brand !== undefined ? { brand } : {}),
    ...(condition !== undefined ? { condition } : {}),
    ...(askingPrice !== undefined ? { askingPrice: String(parseFloat(askingPrice).toFixed(2)) } : {}),
    ...(commissionRate !== undefined ? { commissionRate: String(parseFloat(commissionRate).toFixed(2)) } : {}),
    ...(imageUrls !== undefined ? { imageUrls } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(listedInShop !== undefined ? { listedInShop: Boolean(listedInShop) } : {}),
    updatedAt: new Date(),
  }).where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)))
    .returning();

  res.json({ item: updated });
});

// ─── RECORD SALE ─────────────────────────────────────────────────────────────

// POST /organizations/:orgId/consignment/:itemId/sell
router.post("/:itemId/sell", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const itemId = parseInt((req.params as Record<string, string>).itemId);
  const [existing] = await db.select().from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Consignment item not found" }); return; } }
  if (existing.status !== "unsold") { { res.status(400).json({ error: "Item is not available for sale" }); return; } }

  const { salePrice } = req.body;
  if (!salePrice || isNaN(parseFloat(salePrice))) { { res.status(400).json({ error: "Valid sale price is required" }); return; } }

  const salePriceNum = parseFloat(salePrice);
  const commissionRateNum = parseFloat(existing.commissionRate);
  const { commission, payout } = calculatePayout(salePriceNum, commissionRateNum);

  const [updated] = await db.update(consignmentItemsTable).set({
    status: "payout_pending",
    salePrice: String(salePriceNum.toFixed(2)),
    soldAt: new Date(),
    commissionAmount: String(commission.toFixed(2)),
    payoutAmount: String(payout.toFixed(2)),
    updatedAt: new Date(),
  }).where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)))
    .returning();

  res.json({ item: updated });
});

// ─── PAYOUT CALCULATION ───────────────────────────────────────────────────────

// GET /organizations/:orgId/consignment/:itemId/payout-calculation
router.get("/:itemId/payout-calculation", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const itemId = parseInt((req.params as Record<string, string>).itemId);
  const [item] = await db.select().from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  if (!item) { { res.status(404).json({ error: "Consignment item not found" }); return; } }

  const price = parseFloat(item.salePrice ?? item.askingPrice);
  const rate = parseFloat(item.commissionRate);
  const { commission, payout } = calculatePayout(price, rate);

  res.json({
    askingPrice: item.askingPrice,
    salePrice: item.salePrice,
    commissionRate: item.commissionRate,
    commissionAmount: commission.toFixed(2),
    payoutAmount: payout.toFixed(2),
    currency: item.currency,
  });
});

// ─── MARK PAYOUT COMPLETE ─────────────────────────────────────────────────────

// POST /organizations/:orgId/consignment/:itemId/pay
router.post("/:itemId/pay", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const itemId = parseInt((req.params as Record<string, string>).itemId);
  const caller = getUser(req)!;

  const [existing] = await db.select().from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Consignment item not found" }); return; } }
  if (existing.status !== "payout_pending") { { res.status(400).json({ error: "Item is not in payout pending state" }); return; } }

  const { payoutMethod, payoutReference } = req.body;
  if (!payoutMethod) { { res.status(400).json({ error: "Payout method is required" }); return; } }

  const [updated] = await db.update(consignmentItemsTable).set({
    status: "paid",
    payoutMethod,
    payoutReference: payoutReference ?? null,
    paidAt: new Date(),
    paidByUserId: caller.id,
    updatedAt: new Date(),
  }).where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)))
    .returning();

  res.json({ item: updated });
});

// ─── MARK FOR RETURN ──────────────────────────────────────────────────────────

// POST /organizations/:orgId/consignment/:itemId/return
router.post("/:itemId/return", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const itemId = parseInt((req.params as Record<string, string>).itemId);
  const [existing] = await db.select().from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Consignment item not found" }); return; } }
  if (!["unsold", "payout_pending"].includes(existing.status)) {
    res.status(400).json({ error: "Only unsold or payout-pending items can be returned" }); return;
  }

  const [updated] = await db.update(consignmentItemsTable).set({
    status: "returned",
    returnedAt: new Date(),
    listedInShop: false,
    updatedAt: new Date(),
  }).where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)))
    .returning();

  res.json({ item: updated });
});

// ─── DELETE ITEM ─────────────────────────────────────────────────────────────

// DELETE /organizations/:orgId/consignment/:itemId
router.delete("/:itemId", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const itemId = parseInt((req.params as Record<string, string>).itemId);
  const [existing] = await db.select({ id: consignmentItemsTable.id, status: consignmentItemsTable.status })
    .from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  if (!existing) { { res.status(404).json({ error: "Consignment item not found" }); return; } }
  if (existing.status === "paid") { { res.status(400).json({ error: "Cannot delete a paid-out item" }); return; } }

  await db.delete(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.id, itemId), eq(consignmentItemsTable.organizationId, orgId)));

  res.json({ success: true });
});

// ─── PUBLIC CONSIGNOR LOOKUP ──────────────────────────────────────────────────

// GET /organizations/:orgId/consignment/lookup/:token
router.get("/lookup/:token", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  const token = (req.params as Record<string, string>).token.toUpperCase();

  const [item] = await db.select({
    id: consignmentItemsTable.id,
    title: consignmentItemsTable.title,
    description: consignmentItemsTable.description,
    category: consignmentItemsTable.category,
    brand: consignmentItemsTable.brand,
    condition: consignmentItemsTable.condition,
    askingPrice: consignmentItemsTable.askingPrice,
    currency: consignmentItemsTable.currency,
    status: consignmentItemsTable.status,
    salePrice: consignmentItemsTable.salePrice,
    soldAt: consignmentItemsTable.soldAt,
    commissionRate: consignmentItemsTable.commissionRate,
    payoutAmount: consignmentItemsTable.payoutAmount,
    payoutMethod: consignmentItemsTable.payoutMethod,
    paidAt: consignmentItemsTable.paidAt,
    returnedAt: consignmentItemsTable.returnedAt,
    imageUrls: consignmentItemsTable.imageUrls,
    createdAt: consignmentItemsTable.createdAt,
  }).from(consignmentItemsTable)
    .where(and(eq(consignmentItemsTable.lookupToken, token), eq(consignmentItemsTable.organizationId, orgId)));

  if (!item) { { res.status(404).json({ error: "Item not found. Please check your tracking code." }); return; } }
  res.json({ item });
});

// ─── INVENTORY VIEW (for POS / shop listing) ─────────────────────────────────

// GET /organizations/:orgId/consignment/inventory
router.get("/inventory/available", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const items = await db.select({
    id: consignmentItemsTable.id,
    title: consignmentItemsTable.title,
    description: consignmentItemsTable.description,
    category: consignmentItemsTable.category,
    brand: consignmentItemsTable.brand,
    condition: consignmentItemsTable.condition,
    askingPrice: consignmentItemsTable.askingPrice,
    currency: consignmentItemsTable.currency,
    imageUrls: consignmentItemsTable.imageUrls,
    consignorName: consignmentItemsTable.consignorName,
    listedInShop: consignmentItemsTable.listedInShop,
    createdAt: consignmentItemsTable.createdAt,
  }).from(consignmentItemsTable)
    .where(and(
      eq(consignmentItemsTable.organizationId, orgId),
      eq(consignmentItemsTable.status, "unsold"),
    ))
    .orderBy(desc(consignmentItemsTable.createdAt));

  res.json({ items });
});

export default router;
