import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  suppliersTable, purchaseOrdersTable, purchaseOrderLinesTable,
  deliveryReceiptsTable, deliveryReceiptLinesTable,
  shopProductsTable, shopProductVariantsTable, shopVariantStockTable, shopStockAdjustmentsTable,
  shopLocationsTable, orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import nodemailer from "nodemailer";

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
  if ((caller.role === "org_admin" || caller.role === "tournament_director" || caller.role === "pro_shop") && Number(caller.organizationId) === orgId) return true;
  const [m] = await db.select({ role: orgMembershipsTable.role }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, caller.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "pro_shop"])));
  if (!m) { res.status(403).json({ error: "Staff access required" }); return false; }
  return true;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function generatePoNumberInTx(orgId: number, tx: Tx): Promise<string> {
  // Advisory lock ensures sequential numbering under concurrent creates for this org
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${orgId}::bigint + 1000000000)`);
  const y = new Date().getFullYear();
  const prefix = `PO-${orgId}-${y}-`;
  const existing = await tx.select({ poNumber: purchaseOrdersTable.poNumber })
    .from(purchaseOrdersTable)
    .where(and(
      eq(purchaseOrdersTable.organizationId, orgId),
      sql`${purchaseOrdersTable.poNumber} LIKE ${prefix + "%"}`,
    ));
  const maxSeq = existing.reduce((m, r) => {
    const match = r.poNumber?.match(/-(\d+)$/);
    return match ? Math.max(m, parseInt(match[1])) : m;
  }, 0);
  return `${prefix}${String(maxSeq + 1).padStart(4, "0")}`;
}

// ─── SUPPLIERS ───────────────────────────────────────────────────────────────

// GET /organizations/:orgId/procurement/suppliers
router.get("/suppliers", async (req: Request, res: Response) => {
  const orgId = parseInt((req.params as Record<string, string>).orgId);
  if (!await requireOrgStaff(req, res, orgId)) return;

  const active = req.query["active"];
  const conditions = [eq(suppliersTable.organizationId, orgId)];
  if (active === "true") conditions.push(eq(suppliersTable.isActive, true));

  const suppliers = await db.select().from(suppliersTable).where(and(...conditions)).orderBy(suppliersTable.name);
  res.json({ suppliers });
});

// POST /organizations/:orgId/procurement/suppliers
router.post("/suppliers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, contactName, email, phone, address, paymentTerms, leadTimeDays, notes } = req.body;
  if (!name?.trim()) { { res.status(400).json({ error: "Supplier name is required" }); return; } }

  const [supplier] = await db.insert(suppliersTable).values({
    organizationId: orgId, name: name.trim(), contactName, email, phone, address,
    paymentTerms, leadTimeDays: leadTimeDays ? parseInt(leadTimeDays) : null, notes,
  }).returning();

  res.status(201).json({ supplier });
});

// PUT /organizations/:orgId/procurement/suppliers/:supplierId
router.put("/suppliers/:supplierId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const supplierId = parseInt(String((req.params as Record<string, string>).supplierId));
  const [existing] = await db.select().from(suppliersTable)
    .where(and(eq(suppliersTable.id, supplierId), eq(suppliersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Supplier not found" }); return; } }

  const { name, contactName, email, phone, address, paymentTerms, leadTimeDays, notes, isActive } = req.body;
  const [supplier] = await db.update(suppliersTable).set({
    name: name?.trim() ?? existing.name, contactName, email, phone, address,
    paymentTerms, leadTimeDays: leadTimeDays != null ? parseInt(leadTimeDays) : null,
    notes, isActive: isActive ?? existing.isActive, updatedAt: new Date(),
  }).where(eq(suppliersTable.id, supplierId)).returning();

  res.json({ supplier });
});

// DELETE /organizations/:orgId/procurement/suppliers/:supplierId
router.delete("/suppliers/:supplierId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const supplierId = parseInt(String((req.params as Record<string, string>).supplierId));
  const [existing] = await db.select().from(suppliersTable)
    .where(and(eq(suppliersTable.id, supplierId), eq(suppliersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Supplier not found" }); return; } }

  await db.update(suppliersTable).set({ isActive: false, updatedAt: new Date() })
    .where(eq(suppliersTable.id, supplierId));
  res.json({ ok: true });
});

// GET /organizations/:orgId/procurement/suppliers/:supplierId/stats
router.get("/suppliers/:supplierId/stats", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const supplierId = parseInt(String((req.params as Record<string, string>).supplierId));
  const [supplier] = await db.select().from(suppliersTable)
    .where(and(eq(suppliersTable.id, supplierId), eq(suppliersTable.organizationId, orgId)));
  if (!supplier) { { res.status(404).json({ error: "Supplier not found" }); return; } }

  const pos = await db.select({
    id: purchaseOrdersTable.id,
    poNumber: purchaseOrdersTable.poNumber,
    status: purchaseOrdersTable.status,
    totalAmount: purchaseOrdersTable.totalAmount,
    currency: purchaseOrdersTable.currency,
    createdAt: purchaseOrdersTable.createdAt,
  }).from(purchaseOrdersTable)
    .where(and(eq(purchaseOrdersTable.supplierId, supplierId), eq(purchaseOrdersTable.organizationId, orgId)))
    .orderBy(desc(purchaseOrdersTable.createdAt));

  const totalSpend = pos
    .filter(p => !["draft", "cancelled"].includes(p.status))
    .reduce((sum, p) => sum + parseFloat(p.totalAmount ?? "0"), 0);

  res.json({ supplier, purchaseOrders: pos, totalSpend });
});

// ─── PURCHASE ORDERS ─────────────────────────────────────────────────────────

// GET /organizations/:orgId/procurement/purchase-orders
router.get("/purchase-orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const { status, supplierId } = req.query;
  const conditions: ReturnType<typeof eq>[] = [eq(purchaseOrdersTable.organizationId, orgId)];
  if (status && typeof status === "string") conditions.push(eq(purchaseOrdersTable.status, status as never));
  if (supplierId) conditions.push(eq(purchaseOrdersTable.supplierId, parseInt(supplierId as string)));

  const pos = await db.select({
    id: purchaseOrdersTable.id,
    poNumber: purchaseOrdersTable.poNumber,
    status: purchaseOrdersTable.status,
    totalAmount: purchaseOrdersTable.totalAmount,
    currency: purchaseOrdersTable.currency,
    expectedDeliveryDate: purchaseOrdersTable.expectedDeliveryDate,
    sentAt: purchaseOrdersTable.sentAt,
    notes: purchaseOrdersTable.notes,
    createdAt: purchaseOrdersTable.createdAt,
    supplierId: purchaseOrdersTable.supplierId,
    supplierName: suppliersTable.name,
    supplierEmail: suppliersTable.email,
  }).from(purchaseOrdersTable)
    .leftJoin(suppliersTable, eq(purchaseOrdersTable.supplierId, suppliersTable.id))
    .where(and(...conditions))
    .orderBy(desc(purchaseOrdersTable.createdAt));

  res.json({ purchaseOrders: pos });
});

// POST /organizations/:orgId/procurement/purchase-orders
router.post("/purchase-orders", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const { supplierId, expectedDeliveryDate, notes, lines } = req.body;

  if (!supplierId) { { res.status(400).json({ error: "supplierId is required" }); return; } }
  if (!Array.isArray(lines) || lines.length === 0) { { res.status(400).json({ error: "At least one line item is required" }); return; } }

  const [supplier] = await db.select().from(suppliersTable)
    .where(and(eq(suppliersTable.id, parseInt(supplierId)), eq(suppliersTable.organizationId, orgId)));
  if (!supplier) { { res.status(404).json({ error: "Supplier not found" }); return; } }

  const totalAmount = lines.reduce((s: number, l: { quantity: number; unitCost: number }) =>
    s + (Number(l.quantity) * Number(l.unitCost)), 0);

  const { po, insertedLines } = await db.transaction(async (tx) => {
    const poNumber = await generatePoNumberInTx(orgId, tx);
    const [po] = await tx.insert(purchaseOrdersTable).values({
      organizationId: orgId,
      supplierId: parseInt(supplierId),
      poNumber,
      status: "draft",
      expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
      notes,
      totalAmount: String(totalAmount.toFixed(2)),
      createdByUserId: caller.id,
    }).returning();

    const lineValues = lines.map((l: {
      productId?: number; variantId?: number; productName: string; sku?: string;
      quantity: number; unitCost: number;
    }) => ({
      purchaseOrderId: po.id,
      productId: l.productId ? parseInt(String(l.productId)) : null,
      variantId: l.variantId ? parseInt(String(l.variantId)) : null,
      productName: l.productName,
      sku: l.sku,
      quantity: parseInt(String(l.quantity)),
      unitCost: String(Number(l.unitCost).toFixed(2)),
      lineTotal: String((Number(l.quantity) * Number(l.unitCost)).toFixed(2)),
    }));
    const insertedLines = await tx.insert(purchaseOrderLinesTable).values(lineValues).returning();
    return { po, insertedLines };
  });

  res.status(201).json({ purchaseOrder: po, lines: insertedLines });
});

// GET /organizations/:orgId/procurement/purchase-orders/:poId
router.get("/purchase-orders/:poId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const poId = parseInt(String((req.params as Record<string, string>).poId));
  const [po] = await db.select({
    id: purchaseOrdersTable.id,
    poNumber: purchaseOrdersTable.poNumber,
    status: purchaseOrdersTable.status,
    totalAmount: purchaseOrdersTable.totalAmount,
    currency: purchaseOrdersTable.currency,
    expectedDeliveryDate: purchaseOrdersTable.expectedDeliveryDate,
    sentAt: purchaseOrdersTable.sentAt,
    notes: purchaseOrdersTable.notes,
    createdAt: purchaseOrdersTable.createdAt,
    updatedAt: purchaseOrdersTable.updatedAt,
    supplierId: suppliersTable.id,
    supplierName: suppliersTable.name,
    supplierEmail: suppliersTable.email,
    supplierPhone: suppliersTable.phone,
    supplierAddress: suppliersTable.address,
    supplierContactName: suppliersTable.contactName,
    supplierPaymentTerms: suppliersTable.paymentTerms,
  }).from(purchaseOrdersTable)
    .leftJoin(suppliersTable, eq(purchaseOrdersTable.supplierId, suppliersTable.id))
    .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.organizationId, orgId)));

  if (!po) { { res.status(404).json({ error: "Purchase order not found" }); return; } }

  const lines = await db.select().from(purchaseOrderLinesTable)
    .where(eq(purchaseOrderLinesTable.purchaseOrderId, poId))
    .orderBy(purchaseOrderLinesTable.id);

  const receipts = await db.select().from(deliveryReceiptsTable)
    .where(eq(deliveryReceiptsTable.purchaseOrderId, poId))
    .orderBy(desc(deliveryReceiptsTable.receivedAt));

  const receiptIds = receipts.map(r => r.id);
  const receiptLines = receiptIds.length > 0
    ? await db.select().from(deliveryReceiptLinesTable)
      .where(inArray(deliveryReceiptLinesTable.deliveryReceiptId, receiptIds))
    : [];

  res.json({ purchaseOrder: po, lines, receipts, receiptLines });
});

// PUT /organizations/:orgId/procurement/purchase-orders/:poId
router.put("/purchase-orders/:poId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const poId = parseInt(String((req.params as Record<string, string>).poId));
  const [existing] = await db.select().from(purchaseOrdersTable)
    .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Purchase order not found" }); return; } }

  if (!["draft", "sent"].includes(existing.status)) {
    res.status(400).json({ error: "Only draft or sent POs can be edited" }); return;
  }

  const { supplierId, expectedDeliveryDate, notes, lines, status } = req.body;

  let totalAmount = existing.totalAmount;
  if (Array.isArray(lines)) {
    await db.delete(purchaseOrderLinesTable).where(eq(purchaseOrderLinesTable.purchaseOrderId, poId));
    const lineValues = lines.map((l: {
      productId?: number; variantId?: number; productName: string; sku?: string;
      quantity: number; unitCost: number;
    }) => ({
      purchaseOrderId: poId,
      productId: l.productId ? parseInt(String(l.productId)) : null,
      variantId: l.variantId ? parseInt(String(l.variantId)) : null,
      productName: l.productName,
      sku: l.sku,
      quantity: parseInt(String(l.quantity)),
      unitCost: String(Number(l.unitCost).toFixed(2)),
      lineTotal: String((Number(l.quantity) * Number(l.unitCost)).toFixed(2)),
    }));
    await db.insert(purchaseOrderLinesTable).values(lineValues);
    totalAmount = String(lines.reduce((s: number, l: { quantity: number; unitCost: number }) =>
      s + Number(l.quantity) * Number(l.unitCost), 0).toFixed(2));
  }

  const allowedStatuses = ["draft", "sent", "cancelled"];
  const newStatus = status && allowedStatuses.includes(status) ? status : existing.status;

  const [updated] = await db.update(purchaseOrdersTable).set({
    supplierId: supplierId ? parseInt(supplierId) : existing.supplierId,
    expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : existing.expectedDeliveryDate,
    notes: notes ?? existing.notes,
    totalAmount,
    status: newStatus,
    updatedAt: new Date(),
  }).where(eq(purchaseOrdersTable.id, poId)).returning();

  res.json({ purchaseOrder: updated });
});

// POST /organizations/:orgId/procurement/purchase-orders/:poId/send
// Marks PO as "sent" and optionally emails a PDF-style HTML to the supplier
router.post("/purchase-orders/:poId/send", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const poId = parseInt(String((req.params as Record<string, string>).poId));
  const [po] = await db.select({
    id: purchaseOrdersTable.id,
    poNumber: purchaseOrdersTable.poNumber,
    status: purchaseOrdersTable.status,
    totalAmount: purchaseOrdersTable.totalAmount,
    currency: purchaseOrdersTable.currency,
    expectedDeliveryDate: purchaseOrdersTable.expectedDeliveryDate,
    notes: purchaseOrdersTable.notes,
    supplierId: suppliersTable.id,
    supplierName: suppliersTable.name,
    supplierEmail: suppliersTable.email,
    supplierContactName: suppliersTable.contactName,
    supplierPhone: suppliersTable.phone,
    supplierAddress: suppliersTable.address,
    supplierPaymentTerms: suppliersTable.paymentTerms,
  }).from(purchaseOrdersTable)
    .leftJoin(suppliersTable, eq(purchaseOrdersTable.supplierId, suppliersTable.id))
    .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.organizationId, orgId)));

  if (!po) { { res.status(404).json({ error: "Purchase order not found" }); return; } }
  if (po.status === "cancelled") { { res.status(400).json({ error: "Cannot send a cancelled PO" }); return; } }
  if (po.status === "fully_received") { { res.status(400).json({ error: "PO is already fully received" }); return; } }

  const lines = await db.select().from(purchaseOrderLinesTable)
    .where(eq(purchaseOrderLinesTable.purchaseOrderId, poId));

  // Build email HTML
  const linesHtml = lines.map(l => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${l.productName}${l.sku ? ` (${l.sku})` : ""}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${l.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">₹${Number(l.unitCost).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">₹${Number(l.lineTotal).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
    </tr>
  `).join("");

  const deliveryDateStr = po.expectedDeliveryDate
    ? new Date(po.expectedDeliveryDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
    : "Not specified";

  const emailHtml = `
    <!DOCTYPE html><html><body style="font-family:sans-serif;color:#111;max-width:700px;margin:0 auto;padding:24px;">
      <div style="background:#1e4d2b;color:#fff;padding:24px 32px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:22px;letter-spacing:2px;">KHARAGOLF</h1>
        <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Purchase Order</p>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:0;padding:24px 32px;border-radius:0 0 8px 8px;">
        <table style="width:100%;margin-bottom:24px;">
          <tr>
            <td><strong>PO Number:</strong> ${po.poNumber}</td>
            <td style="text-align:right;"><strong>Date:</strong> ${new Date().toLocaleDateString("en-IN")}</td>
          </tr>
          <tr>
            <td><strong>To:</strong> ${po.supplierName ?? ""}${po.supplierContactName ? ` — Attn: ${po.supplierContactName}` : ""}</td>
            <td style="text-align:right;"><strong>Expected Delivery:</strong> ${deliveryDateStr}</td>
          </tr>
          ${po.supplierAddress ? `<tr><td><strong>Address:</strong> ${po.supplierAddress}</td><td></td></tr>` : ""}
          ${po.supplierPaymentTerms ? `<tr><td><strong>Payment Terms:</strong> ${po.supplierPaymentTerms}</td><td></td></tr>` : ""}
        </table>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
          <thead>
            <tr style="background:#f9fafb;">
              <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e5e7eb;">Product</th>
              <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #e5e7eb;">Qty</th>
              <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e5e7eb;">Unit Cost</th>
              <th style="padding:10px 12px;text-align:right;border-bottom:2px solid #e5e7eb;">Line Total</th>
            </tr>
          </thead>
          <tbody>${linesHtml}</tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="padding:12px;text-align:right;font-weight:700;font-size:16px;">Total</td>
              <td style="padding:12px;text-align:right;font-weight:700;font-size:16px;">₹${Number(po.totalAmount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
            </tr>
          </tfoot>
        </table>
        ${po.notes ? `<p style="background:#f9fafb;padding:12px 16px;border-radius:6px;"><strong>Notes:</strong> ${po.notes}</p>` : ""}
        <p style="color:#6b7280;font-size:12px;margin-top:24px;">This is an official Purchase Order from KHARAGOLF. Please acknowledge receipt and confirm delivery timeline.</p>
      </div>
    </body></html>
  `;

  let emailSent = false;
  const supplierEmail = po.supplierEmail;
  const GMAIL_USER = process.env.GMAIL_USER ?? "";
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD ?? "";

  if (supplierEmail && GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      });
      await transporter.sendMail({
        from: `"KHARAGOLF Procurement" <${GMAIL_USER}>`,
        to: supplierEmail,
        subject: `Purchase Order ${po.poNumber} — KHARAGOLF`,
        html: emailHtml,
      });
      emailSent = true;
    } catch {
      // Non-fatal — still mark as sent
    }
  }

  const [updated] = await db.update(purchaseOrdersTable).set({
    status: "sent",
    sentAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(purchaseOrdersTable.id, poId)).returning();

  res.json({ purchaseOrder: updated, emailSent });
});

// POST /organizations/:orgId/procurement/purchase-orders/:poId/cancel
router.post("/purchase-orders/:poId/cancel", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const poId = parseInt(String((req.params as Record<string, string>).poId));
  const [existing] = await db.select().from(purchaseOrdersTable)
    .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Purchase order not found" }); return; } }
  if (["fully_received", "cancelled"].includes(existing.status)) {
    res.status(400).json({ error: "Cannot cancel this PO" }); return;
  }

  const [updated] = await db.update(purchaseOrdersTable).set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(purchaseOrdersTable.id, poId)).returning();

  res.json({ purchaseOrder: updated });
});

// ─── DELIVERY RECEIPTS ───────────────────────────────────────────────────────

// POST /organizations/:orgId/procurement/purchase-orders/:poId/receipts
// Records a delivery, updates received quantities, and syncs POS/shop inventory
router.post("/purchase-orders/:poId/receipts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const caller = getUser(req)!;
  const poId = parseInt(String((req.params as Record<string, string>).poId));

  const [existing] = await db.select().from(purchaseOrdersTable)
    .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Purchase order not found" }); return; } }
  if (["draft", "cancelled"].includes(existing.status)) {
    res.status(400).json({ error: "Cannot record delivery for a draft or cancelled PO" }); return;
  }

  const { notes, receivedAt, lines } = req.body;
  if (!Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: "At least one received line is required" }); return;
  }

  // ── PHASE 1: All reads / validations before any write ────────────────────

  // Validate lines against existing PO lines
  const poLines = await db.select().from(purchaseOrderLinesTable)
    .where(eq(purchaseOrderLinesTable.purchaseOrderId, poId));
  const poLineMap = new Map(poLines.map(l => [l.id, l]));

  for (const rl of lines as Array<{ purchaseOrderLineId: number; receivedQty: number }>) {
    const poLine = poLineMap.get(rl.purchaseOrderLineId);
    if (!poLine) { { res.status(400).json({ error: `Line ${rl.purchaseOrderLineId} not found on this PO` }); return; } }
    if (rl.receivedQty < 0) { { res.status(400).json({ error: "receivedQty cannot be negative" }); return; } }
  }

  // Resolve location (reads only here — auto-creation happens inside transaction if needed)
  const suppliedLocationId: number | null = req.body.locationId ? parseInt(String(req.body.locationId)) : null;
  let preResolvedLocationId: number | null = null; // null = needs auto-create inside tx

  if (suppliedLocationId) {
    const [locCheck] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.id, suppliedLocationId), eq(shopLocationsTable.organizationId, orgId)));
    if (!locCheck) { { res.status(400).json({ error: "locationId not found for this organisation" }); return; } }
    preResolvedLocationId = locCheck.id;
  } else {
    const [defaultLoc] = await db.select({ id: shopLocationsTable.id })
      .from(shopLocationsTable)
      .where(and(eq(shopLocationsTable.organizationId, orgId), eq(shopLocationsTable.isDefault, true)));
    if (defaultLoc) preResolvedLocationId = defaultLoc.id;
    // else null → auto-create inside transaction
  }

  // Pre-validate all variantIds — each must belong to its PO line's product/variant.
  // Collect ALL mismatches before returning so the client can show a complete list.
  const mismatches: Array<{ purchaseOrderLineId: number; expectedProductId: number | null; expectedVariantId: number | null; scannedVariantId: number }> = [];
  for (const rl of lines as Array<{ purchaseOrderLineId: number; receivedQty: number; variantId?: number }>) {
    if (rl.variantId) {
      const poLine = poLineMap.get(rl.purchaseOrderLineId)!;
      // If PO line has an explicit variantId, the scan must match it exactly
      if (poLine.variantId && rl.variantId !== poLine.variantId) {
        mismatches.push({ purchaseOrderLineId: rl.purchaseOrderLineId, expectedProductId: poLine.productId, expectedVariantId: poLine.variantId, scannedVariantId: rl.variantId });
        continue;
      }
      // Otherwise validate scan belongs to the PO line's product
      if (!poLine.variantId && poLine.productId) {
        const [v] = await db.select({ id: shopProductVariantsTable.id })
          .from(shopProductVariantsTable)
          .where(and(
            eq(shopProductVariantsTable.id, rl.variantId),
            eq(shopProductVariantsTable.productId, poLine.productId),
          ));
        if (!v) {
          mismatches.push({ purchaseOrderLineId: rl.purchaseOrderLineId, expectedProductId: poLine.productId, expectedVariantId: null, scannedVariantId: rl.variantId });
        }
      }
    }
  }
  if (mismatches.length > 0) {
    res.status(400).json({
      error: `Barcode scan mismatch: ${mismatches.length} scanned item(s) do not match their PO lines`,
      mismatches,
    });
    return;
  }

  // ── PHASE 2: All writes inside a single atomic transaction ────────────────
  const { receipt, insertedLines, updatedPo } = await db.transaction(async (tx) => {
    // Auto-create a default location if none exists
    let resolvedLocationId: number;
    if (preResolvedLocationId !== null) {
      resolvedLocationId = preResolvedLocationId;
    } else {
      const [created] = await tx.insert(shopLocationsTable).values({
        organizationId: orgId,
        name: "Main Warehouse",
        isDefault: true,
        isActive: true,
      }).returning({ id: shopLocationsTable.id });
      resolvedLocationId = created.id;
    }

    // Insert delivery receipt header
    const [receipt] = await tx.insert(deliveryReceiptsTable).values({
      purchaseOrderId: poId,
      organizationId: orgId,
      receivedByUserId: caller.id,
      notes,
      receivedAt: receivedAt ? new Date(receivedAt) : new Date(),
    }).returning();

    // Insert delivery receipt lines
    const receiptLineValues = (lines as Array<{ purchaseOrderLineId: number; receivedQty: number; notes?: string }>)
      .map(rl => ({
        deliveryReceiptId: receipt.id,
        purchaseOrderLineId: rl.purchaseOrderLineId,
        receivedQty: parseInt(String(rl.receivedQty)),
        notes: rl.notes,
      }));
    const insertedLines = await tx.insert(deliveryReceiptLinesTable).values(receiptLineValues).returning();

    // Update received quantities on PO lines & sync inventory
    for (const rl of lines as Array<{ purchaseOrderLineId: number; receivedQty: number; variantId?: number }>) {
      const poLine = poLineMap.get(rl.purchaseOrderLineId)!;
      const newReceivedQty = poLine.receivedQty + parseInt(String(rl.receivedQty));
      await tx.update(purchaseOrderLinesTable).set({ receivedQty: newReceivedQty, updatedAt: new Date() })
        .where(eq(purchaseOrderLinesTable.id, rl.purchaseOrderLineId));

      const qty = parseInt(String(rl.receivedQty));

      // Sync shop_products stock count (global counter — backward compatibility)
      if (poLine.productId && qty > 0) {
        await tx.update(shopProductsTable)
          .set({ stockCount: sql`COALESCE(${shopProductsTable.stockCount}, 0) + ${qty}`, updatedAt: new Date() })
          .where(eq(shopProductsTable.id, poLine.productId));
      }

      // Sync per-location variant stock.
      // Priority: scanned barcode variantId → PO line's stored variantId → skip (no auto-resolve)
      if (qty > 0) {
        const variantId: number | null = rl.variantId ?? (poLine.variantId ?? null);
        if (variantId) {
          // Unconditional org ownership check — covers cases where poLine.productId is null
          // (Phase 1 only checks ownership when productId is available)
          const [variantOwnCheck] = await tx.select({ id: shopProductVariantsTable.id })
            .from(shopProductVariantsTable)
            .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
            .where(and(
              eq(shopProductVariantsTable.id, variantId),
              eq(shopProductsTable.organizationId, orgId),
            )).limit(1);
          if (!variantOwnCheck) continue; // variant doesn't belong to this org — skip stock mutation

          const [existingStock] = await tx.select({ id: shopVariantStockTable.variantId }).from(shopVariantStockTable)
            .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, resolvedLocationId)));
          if (existingStock) {
            await tx.update(shopVariantStockTable)
              .set({ quantity: sql`${shopVariantStockTable.quantity} + ${qty}`, updatedAt: new Date() })
              .where(and(eq(shopVariantStockTable.variantId, variantId), eq(shopVariantStockTable.locationId, resolvedLocationId)));
          } else {
            await tx.insert(shopVariantStockTable).values({ variantId, locationId: resolvedLocationId, quantity: qty });
          }
          await tx.insert(shopStockAdjustmentsTable).values({
            organizationId: orgId,
            variantId,
            locationId: resolvedLocationId,
            qtyDelta: qty,
            type: "goods_receipt",
            reason: `Goods receipt against PO #${poId}`,
            referenceId: String(poId),
            createdByUserId: caller.id,
          });
        }
      }
    }

    // Recompute and update PO status
    const updatedPoLines = await tx.select().from(purchaseOrderLinesTable)
      .where(eq(purchaseOrderLinesTable.purchaseOrderId, poId));
    const allFullyReceived = updatedPoLines.every(l => l.receivedQty >= l.quantity);
    const anyReceived = updatedPoLines.some(l => l.receivedQty > 0);
    const newStatus = allFullyReceived ? "fully_received"
      : anyReceived ? "partially_received"
      : existing.status;
    const [updatedPo] = await tx.update(purchaseOrdersTable).set({ status: newStatus as never, updatedAt: new Date() })
      .where(eq(purchaseOrdersTable.id, poId)).returning();

    return { receipt, insertedLines, updatedPo };
  });

  res.status(201).json({ receipt, receiptLines: insertedLines, purchaseOrder: updatedPo });
});

// GET /organizations/:orgId/procurement/purchase-orders/:poId/receipts
router.get("/purchase-orders/:poId/receipts", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgStaff(req, res, orgId)) return;

  const poId = parseInt(String((req.params as Record<string, string>).poId));
  const [existing] = await db.select({ id: purchaseOrdersTable.id })
    .from(purchaseOrdersTable)
    .where(and(eq(purchaseOrdersTable.id, poId), eq(purchaseOrdersTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Purchase order not found" }); return; } }

  const receipts = await db.select().from(deliveryReceiptsTable)
    .where(eq(deliveryReceiptsTable.purchaseOrderId, poId))
    .orderBy(desc(deliveryReceiptsTable.receivedAt));

  const receiptIds = receipts.map(r => r.id);
  const receiptLines = receiptIds.length > 0
    ? await db.select().from(deliveryReceiptLinesTable)
      .where(inArray(deliveryReceiptLinesTable.deliveryReceiptId, receiptIds))
    : [];

  res.json({ receipts, receiptLines });
});

export default router;
