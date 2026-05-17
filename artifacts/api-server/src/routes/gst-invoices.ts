/**
 * GST Invoice Management API
 *
 * GET  /organizations/:orgId/gst-invoices            — list/filter invoices
 * GET  /organizations/:orgId/gst-invoices/summary    — GST summary for GSTR-1
 * GET  /organizations/:orgId/gst-invoices/:id        — get single invoice
 * GET  /organizations/:orgId/gst-invoices/:id/download — download PDF
 * POST /organizations/:orgId/gst-invoices/bulk-download — download multiple as zip
 * GET  /organizations/:orgId/gst-invoices/sequence-settings — get/update sequence prefixes
 * PUT  /organizations/:orgId/gst-invoices/sequence-settings — update sequence prefix
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  gstInvoicesTable,
  invoiceSequencesTable,
  orgMembershipsTable,
  shopOrdersTable,
} from "@workspace/db";
import { eq, and, or, desc, gte, lte, ilike, inArray, sum, count, sql } from "drizzle-orm";
import { getGstInvoicePdfBuffer } from "../lib/gstInvoice";
import archiver from "archiver";

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
  if (!m) { res.status(403).json({ error: "Admin access required" }); return false; }
  return true;
}

// GET /organizations/:orgId/gst-invoices
router.get("/", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to, channel, q, routing, stateOfSupply, hasPdf, status, page = "1", limit: limitStr = "50" } = req.query;
  const limit = Math.min(parseInt(String(limitStr)), 200);
  const offset = (parseInt(String(page)) - 1) * limit;

  const conditions = [eq(gstInvoicesTable.organizationId, orgId)];
  if (from) conditions.push(gte(gstInvoicesTable.invoiceDate, new Date(String(from))));
  if (to) conditions.push(lte(gstInvoicesTable.invoiceDate, new Date(String(to))));
  if (channel) conditions.push(eq(gstInvoicesTable.channel, channel as "shop" | "pos" | "tournament" | "league"));
  if (routing) conditions.push(eq(gstInvoicesTable.gstRouting, routing as "cgst_sgst" | "igst" | "zero_rated"));
  if (stateOfSupply) conditions.push(ilike(gstInvoicesTable.stateOfSupply, `%${String(stateOfSupply)}%`));
  if (hasPdf === "true") conditions.push(sql`${gstInvoicesTable.pdfPath} IS NOT NULL`);
  if (hasPdf === "false") conditions.push(sql`${gstInvoicesTable.pdfPath} IS NULL`);
  if (status) conditions.push(eq(gstInvoicesTable.status, String(status)));
  if (q) {
    const term = `%${String(q)}%`;
    conditions.push(or(
      ilike(gstInvoicesTable.invoiceNumber, term),
      ilike(gstInvoicesTable.buyerName, term),
      ilike(gstInvoicesTable.buyerEmail, term),
      ilike(gstInvoicesTable.buyerGstin, term),
    )!);
  }

  const invoices = await db.select().from(gstInvoicesTable)
    .where(and(...conditions))
    .orderBy(desc(gstInvoicesTable.invoiceDate))
    .limit(limit)
    .offset(offset);

  res.json(invoices);
});

// GET /organizations/:orgId/gst-invoices/summary
router.get("/summary", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = req.query;
  const conditions = [eq(gstInvoicesTable.organizationId, orgId)];
  if (from) conditions.push(gte(gstInvoicesTable.invoiceDate, new Date(String(from))));
  if (to) conditions.push(lte(gstInvoicesTable.invoiceDate, new Date(String(to))));

  const [summary] = await db.select({
    totalInvoices: count(),
    totalAmount: sum(gstInvoicesTable.totalAmount),
    totalTaxable: sum(gstInvoicesTable.taxableAmount),
    totalCgst: sum(gstInvoicesTable.cgstAmount),
    totalSgst: sum(gstInvoicesTable.sgstAmount),
    totalIgst: sum(gstInvoicesTable.igstAmount),
  }).from(gstInvoicesTable).where(and(...conditions));

  const byChannel = await db.select({
    channel: gstInvoicesTable.channel,
    invoiceCount: count(),
    totalAmount: sum(gstInvoicesTable.totalAmount),
    cgst: sum(gstInvoicesTable.cgstAmount),
    sgst: sum(gstInvoicesTable.sgstAmount),
    igst: sum(gstInvoicesTable.igstAmount),
  }).from(gstInvoicesTable).where(and(...conditions))
    .groupBy(gstInvoicesTable.channel);

  const byRouting = await db.select({
    routing: gstInvoicesTable.gstRouting,
    invoiceCount: count(),
    totalCgst: sum(gstInvoicesTable.cgstAmount),
    totalSgst: sum(gstInvoicesTable.sgstAmount),
    totalIgst: sum(gstInvoicesTable.igstAmount),
  }).from(gstInvoicesTable).where(and(...conditions))
    .groupBy(gstInvoicesTable.gstRouting);

  const byState = await db.select({
    stateOfSupply: gstInvoicesTable.stateOfSupply,
    invoiceCount: count(),
    totalAmount: sum(gstInvoicesTable.totalAmount),
    totalCgst: sum(gstInvoicesTable.cgstAmount),
    totalSgst: sum(gstInvoicesTable.sgstAmount),
    totalIgst: sum(gstInvoicesTable.igstAmount),
  }).from(gstInvoicesTable).where(and(...conditions))
    .groupBy(gstInvoicesTable.stateOfSupply);

  res.json({
    overall: summary,
    byChannel,
    byRouting,
    byStateOfSupply: byState.filter(r => r.stateOfSupply),
  });
});

// GET /organizations/:orgId/gst-invoices/sequence-settings
router.get("/sequence-settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const sequences = await db.select().from(invoiceSequencesTable)
    .where(eq(invoiceSequencesTable.organizationId, orgId));

  res.json(sequences);
});

// PUT /organizations/:orgId/gst-invoices/sequence-settings
router.put("/sequence-settings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { channel, prefix } = req.body as { channel: string; prefix: string };
  if (!channel || !prefix) { { res.status(400).json({ error: "channel and prefix are required" }); return; } }

  const safePrefx = prefix.replace(/[^A-Z0-9\-_]/gi, "").toUpperCase().slice(0, 20);

  const [existing] = await db.select({ id: invoiceSequencesTable.id })
    .from(invoiceSequencesTable)
    .where(and(eq(invoiceSequencesTable.organizationId, orgId), eq(invoiceSequencesTable.channel, channel)));

  if (existing) {
    await db.update(invoiceSequencesTable)
      .set({ prefix: safePrefx, updatedAt: new Date() })
      .where(eq(invoiceSequencesTable.id, existing.id));
  } else {
    await db.insert(invoiceSequencesTable).values({
      organizationId: orgId, channel, prefix: safePrefx, lastSeq: 0,
    });
  }

  res.json({ ok: true, prefix: safePrefx });
});

// GET /organizations/:orgId/gst-invoices/:id
router.get("/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [invoice] = await db.select().from(gstInvoicesTable)
    .where(and(eq(gstInvoicesTable.id, id), eq(gstInvoicesTable.organizationId, orgId)));
  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  res.json(invoice);
});

// GET /organizations/:orgId/gst-invoices/:id/download
router.get("/:id/download", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [invoice] = await db.select({
    id: gstInvoicesTable.id,
    invoiceNumber: gstInvoicesTable.invoiceNumber,
    pdfPath: gstInvoicesTable.pdfPath,
  }).from(gstInvoicesTable)
    .where(and(eq(gstInvoicesTable.id, id), eq(gstInvoicesTable.organizationId, orgId)));

  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  if (!invoice.pdfPath) {
    res.status(404).json({ error: "PDF not yet generated for this invoice" }); return;
  }

  try {
    const buffer = await getGstInvoicePdfBuffer(invoice.pdfPath);
    const safeNum = invoice.invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeNum}.pdf"`);
    res.send(buffer);
  } catch {
    res.status(404).json({ error: "PDF file not found in storage" });
  }
});

// POST /organizations/:orgId/gst-invoices/bulk-download
router.post("/bulk-download", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" }); return;
  }
  if (ids.length > 50) {
    res.status(400).json({ error: "Maximum 50 invoices per bulk download" }); return;
  }

  const invoices = await db.select({
    id: gstInvoicesTable.id,
    invoiceNumber: gstInvoicesTable.invoiceNumber,
    pdfPath: gstInvoicesTable.pdfPath,
  }).from(gstInvoicesTable)
    .where(and(
      eq(gstInvoicesTable.organizationId, orgId),
      inArray(gstInvoicesTable.id, ids),
    ));

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="invoices-${Date.now()}.zip"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(res);

  for (const inv of invoices) {
    if (!inv.pdfPath) continue;
    try {
      const buf = await getGstInvoicePdfBuffer(inv.pdfPath);
      const safeNum = inv.invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, "_");
      archive.append(buf, { name: `${safeNum}.pdf` });
    } catch {
      // skip unavailable PDFs
    }
  }

  await archive.finalize();
});

// ─── Admin: download GST invoice for a POS transaction ───────────────────────
// GET /organizations/:orgId/gst-invoices/by-transaction/:transactionId
router.get("/by-transaction/:transactionId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const txId = parseInt(String((req.params as Record<string, string>).transactionId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (isNaN(txId)) { { res.status(400).json({ error: "Invalid transaction ID" }); return; } }

  const [invoice] = await db.select({
    id: gstInvoicesTable.id,
    invoiceNumber: gstInvoicesTable.invoiceNumber,
    pdfPath: gstInvoicesTable.pdfPath,
  }).from(gstInvoicesTable)
    .where(and(
      eq(gstInvoicesTable.posTransactionId, txId),
      eq(gstInvoicesTable.organizationId, orgId),
    ))
    .orderBy(desc(gstInvoicesTable.invoiceDate))
    .limit(1);

  if (!invoice) { { res.status(404).json({ error: "GST invoice not yet generated for this transaction" }); return; } }
  if (!invoice.pdfPath) { { res.status(404).json({ error: "PDF not yet available — please try again shortly" }); return; } }

  try {
    const buffer = await getGstInvoicePdfBuffer(invoice.pdfPath);
    const safeNum = invoice.invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeNum}.pdf"`);
    res.send(buffer);
  } catch {
    res.status(404).json({ error: "PDF file not found in storage" });
  }
});

// ─── Customer-Facing: download GST invoice for an order (no admin required) ───
// GET /organizations/:orgId/gst-invoices/by-order/:orderId
router.get("/by-order/:orderId", async (req: Request, res: Response) => {
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const orderId = parseInt(String((req.params as Record<string, string>).orderId));
  if (isNaN(orgId) || isNaN(orderId)) { { res.status(400).json({ error: "Invalid params" }); return; } }

  // Verify the caller owns this order (or is an org admin)
  const authUser = req.user as { id: number; role?: string };
  const isAdmin = authUser.role === "super_admin" || !!await (async () => {
    const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        eq(orgMembershipsTable.userId, authUser.id),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
      ));
    return m;
  })();

  const [order] = await db.select({ userId: shopOrdersTable.userId })
    .from(shopOrdersTable)
    .where(and(eq(shopOrdersTable.id, orderId), eq(shopOrdersTable.organizationId, orgId)));

  if (!order) { { res.status(404).json({ error: "Order not found" }); return; } }
  if (!isAdmin && order.userId !== authUser.id) {
    res.status(403).json({ error: "Access denied" }); return;
  }

  const [invoice] = await db.select({
    id: gstInvoicesTable.id,
    invoiceNumber: gstInvoicesTable.invoiceNumber,
    pdfPath: gstInvoicesTable.pdfPath,
  }).from(gstInvoicesTable)
    .where(and(
      eq(gstInvoicesTable.shopOrderId, orderId),
      eq(gstInvoicesTable.organizationId, orgId),
    ))
    .orderBy(desc(gstInvoicesTable.invoiceDate))
    .limit(1);

  if (!invoice) { { res.status(404).json({ error: "GST invoice not yet generated for this order" }); return; } }
  if (!invoice.pdfPath) { { res.status(404).json({ error: "PDF not yet available — please try again shortly" }); return; } }

  try {
    const buffer = await getGstInvoicePdfBuffer(invoice.pdfPath);
    const safeNum = invoice.invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeNum}.pdf"`);
    res.send(buffer);
  } catch {
    res.status(404).json({ error: "PDF file not found in storage" });
  }
});

export default router;
