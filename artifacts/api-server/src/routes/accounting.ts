/**
 * Accounting & Finance Integration API — Task #114
 * Base: /organizations/:orgId/accounting
 *
 * Accounting Connections (Xero / QuickBooks OAuth)
 * GET    /connections                    List accounting connections
 * POST   /connections                    Create / save connection (simulated OAuth)
 * PATCH  /connections/:platform          Update connection settings
 * DELETE /connections/:platform          Disconnect platform
 * POST   /connections/:platform/sync     Trigger on-demand sync
 *
 * Chart of Accounts Mapping
 * GET    /coa-map                        Get all COA mappings for the org
 * PUT    /coa-map                        Upsert COA mappings (bulk)
 *
 * Financial Ledger
 * GET    /ledger                         List ledger entries (filterable by date, type, sync status)
 * POST   /ledger                         Manually add a ledger entry
 * POST   /ledger/ingest                  Ingest revenue events from all modules (background)
 *
 * Finance Dashboard
 * GET    /dashboard                      Aggregated revenue by department + period
 *
 * Reconciliation Report
 * GET    /reconciliation                 Un-synced / mismatched transactions
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  accountingConnectionsTable,
  accountingCoaMapTable,
  financialLedgerTable,
  orgMembershipsTable,
  posTransactionsTable,
  shopOrdersTable,
} from "@workspace/db";
import {
  eq, and, desc, asc, gte, lte, sum, count, sql, ne,
} from "drizzle-orm";

const router: IRouter = Router({ mergeParams: true });

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if (
    (user.role === "org_admin" || user.role === "tournament_director") &&
    Number(user.organizationId) === orgId
  ) return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));

  if (!membership || !["org_admin", "tournament_director"].includes(membership.role)) {
    res.status(403).json({ error: "Admin access required." });
    return false;
  }
  return true;
}

// ─── Accounting Connections ────────────────────────────────────────────────────

/** GET /connections */
router.get("/connections", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const connections = await db
      .select({
        id: accountingConnectionsTable.id,
        platform: accountingConnectionsTable.platform,
        tenantId: accountingConnectionsTable.tenantId,
        tenantName: accountingConnectionsTable.tenantName,
        isActive: accountingConnectionsTable.isActive,
        lastSyncAt: accountingConnectionsTable.lastSyncAt,
        lastSyncStatus: accountingConnectionsTable.lastSyncStatus,
        tokenExpiresAt: accountingConnectionsTable.tokenExpiresAt,
        createdAt: accountingConnectionsTable.createdAt,
      })
      .from(accountingConnectionsTable)
      .where(eq(accountingConnectionsTable.organizationId, orgId))
      .orderBy(asc(accountingConnectionsTable.platform));
    res.json(connections);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch connections." });
  }
});

/** POST /connections — save OAuth tokens (the OAuth dance itself happens in the browser/provider) */
router.post("/connections", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { platform, tenantId, tenantName, accessToken, refreshToken, tokenExpiresAt } = req.body;
  if (!platform || !["xero", "quickbooks"].includes(platform)) {
    res.status(400).json({ error: "platform must be 'xero' or 'quickbooks'." });
    return;
  }
  try {
    const [conn] = await db
      .insert(accountingConnectionsTable)
      .values({
        organizationId: orgId,
        platform,
        tenantId: tenantId || null,
        tenantName: tenantName || null,
        accessToken: accessToken || null,
        refreshToken: refreshToken || null,
        tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [accountingConnectionsTable.organizationId, accountingConnectionsTable.platform],
        set: {
          tenantId: tenantId || null,
          tenantName: tenantName || null,
          accessToken: accessToken || null,
          refreshToken: refreshToken || null,
          tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt) : null,
          isActive: true,
          updatedAt: new Date(),
        },
      })
      .returning();
    res.status(201).json(conn);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save connection." });
  }
});

/** PATCH /connections/:platform */
router.patch("/connections/:platform", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { platform } = (req.params as Record<string, string>);
  const { tenantId, tenantName, isActive } = req.body;
  try {
    await db
      .update(accountingConnectionsTable)
      .set({
        ...(tenantId !== undefined && { tenantId }),
        ...(tenantName !== undefined && { tenantName }),
        ...(isActive !== undefined && { isActive }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(accountingConnectionsTable.organizationId, orgId),
        eq(accountingConnectionsTable.platform, platform as "xero" | "quickbooks"),
      ));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update connection." });
  }
});

/** DELETE /connections/:platform */
router.delete("/connections/:platform", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { platform } = (req.params as Record<string, string>);
  try {
    await db
      .delete(accountingConnectionsTable)
      .where(and(
        eq(accountingConnectionsTable.organizationId, orgId),
        eq(accountingConnectionsTable.platform, platform as "xero" | "quickbooks"),
      ));
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to disconnect." });
  }
});

/** POST /connections/:platform/sync — trigger on-demand sync (marks pending → synced) */
router.post("/connections/:platform/sync", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { platform } = (req.params as Record<string, string>);
  try {
    const [conn] = await db
      .select()
      .from(accountingConnectionsTable)
      .where(and(
        eq(accountingConnectionsTable.organizationId, orgId),
        eq(accountingConnectionsTable.platform, platform as "xero" | "quickbooks"),
      ));
    if (!conn || !conn.isActive) {
      res.status(404).json({ error: "No active connection found for this platform." });
      return;
    }

    const coaMaps = await db
      .select()
      .from(accountingCoaMapTable)
      .where(eq(accountingCoaMapTable.organizationId, orgId));

    const coaByType = Object.fromEntries(coaMaps.map(m => [m.eventType, m]));

    const pendingRows = await db
      .select()
      .from(financialLedgerTable)
      .where(and(
        eq(financialLedgerTable.organizationId, orgId),
        eq(financialLedgerTable.syncStatus, "pending"),
      ));

    let synced = 0;
    let skipped = 0;

    for (const row of pendingRows) {
      const mapping = coaByType[row.eventType];
      if (!mapping) {
        await db
          .update(financialLedgerTable)
          .set({ syncStatus: "skipped", syncedAt: new Date(), syncError: "No COA mapping found", updatedAt: new Date() })
          .where(eq(financialLedgerTable.id, row.id));
        skipped++;
        continue;
      }

      // Real integration would call Xero/QuickBooks API here.
      // We simulate a successful sync:
      const externalRef = `${platform.toUpperCase()}-${Date.now()}-${row.id}`;
      await db
        .update(financialLedgerTable)
        .set({
          syncStatus: "synced",
          syncedAt: new Date(),
          externalRef,
          accountCode: mapping.accountCode,
          taxCode: mapping.taxCode || null,
          syncError: null,
          updatedAt: new Date(),
        })
        .where(eq(financialLedgerTable.id, row.id));
      synced++;
    }

    await db
      .update(accountingConnectionsTable)
      .set({ lastSyncAt: new Date(), lastSyncStatus: `Synced ${synced}, skipped ${skipped}`, updatedAt: new Date() })
      .where(and(
        eq(accountingConnectionsTable.organizationId, orgId),
        eq(accountingConnectionsTable.platform, platform as "xero" | "quickbooks"),
      ));

    res.json({ synced, skipped, total: pendingRows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sync failed." });
  }
});

// ─── Chart of Accounts Mapping ─────────────────────────────────────────────────

/** GET /coa-map */
router.get("/coa-map", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const maps = await db
      .select()
      .from(accountingCoaMapTable)
      .where(eq(accountingCoaMapTable.organizationId, orgId))
      .orderBy(asc(accountingCoaMapTable.eventType));
    res.json(maps);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch COA map." });
  }
});

/** PUT /coa-map — bulk upsert */
router.put("/coa-map", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { mappings } = req.body as {
    mappings: Array<{
      eventType: string;
      accountCode: string;
      accountName?: string;
      taxCode?: string;
      taxRate?: string;
      description?: string;
    }>;
  };
  if (!Array.isArray(mappings) || mappings.length === 0) {
    res.status(400).json({ error: "mappings array is required." });
    return;
  }
  const validEventTypes = [
    "pos_sale", "booking_fee", "membership_due", "lesson_fee", "fb_order",
    "event_fee", "rental_fee", "commission", "gift_card_sale", "gift_card_redemption",
    "refund", "other",
  ];
  for (const m of mappings) {
    if (!validEventTypes.includes(m.eventType)) {
      res.status(400).json({ error: `Invalid eventType: ${m.eventType}` });
      return;
    }
    if (!m.accountCode) {
      res.status(400).json({ error: `accountCode is required for eventType ${m.eventType}` });
      return;
    }
  }
  try {
    for (const m of mappings) {
      await db
        .insert(accountingCoaMapTable)
        .values({
          organizationId: orgId,
          eventType: m.eventType as any,
          accountCode: m.accountCode,
          accountName: m.accountName || null,
          taxCode: m.taxCode || null,
          taxRate: m.taxRate || "0",
          description: m.description || null,
        })
        .onConflictDoUpdate({
          target: [accountingCoaMapTable.organizationId, accountingCoaMapTable.eventType],
          set: {
            accountCode: m.accountCode,
            accountName: m.accountName || null,
            taxCode: m.taxCode || null,
            taxRate: m.taxRate || "0",
            description: m.description || null,
            updatedAt: new Date(),
          },
        });
    }
    res.json({ ok: true, count: mappings.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save COA mappings." });
  }
});

// ─── Financial Ledger ──────────────────────────────────────────────────────────

/** GET /ledger */
router.get("/ledger", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const {
    dateFrom, dateTo, eventType, syncStatus, page = "1", limit: limitStr = "50",
  } = req.query as Record<string, string>;

  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(200, parseInt(limitStr) || 50);
  const offset = (pageNum - 1) * pageSize;

  try {
    const conditions = [eq(financialLedgerTable.organizationId, orgId)];
    if (dateFrom) conditions.push(gte(financialLedgerTable.transactionDate, dateFrom));
    if (dateTo) conditions.push(lte(financialLedgerTable.transactionDate, dateTo));
    if (eventType) conditions.push(eq(financialLedgerTable.eventType, eventType as any));
    if (syncStatus) conditions.push(eq(financialLedgerTable.syncStatus, syncStatus as any));

    const [{ total }] = await db
      .select({ total: count() })
      .from(financialLedgerTable)
      .where(and(...conditions));

    const rows = await db
      .select()
      .from(financialLedgerTable)
      .where(and(...conditions))
      .orderBy(desc(financialLedgerTable.transactionDate), desc(financialLedgerTable.id))
      .limit(pageSize)
      .offset(offset);

    res.json({ data: rows, total, page: pageNum, pageSize });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch ledger." });
  }
});

/** POST /ledger — manually add a ledger entry */
router.post("/ledger", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    eventType, sourceModule, sourceId, sourceRef, memberId, memberName,
    description, amount, currency, taxAmount, taxCode, transactionDate,
  } = req.body;
  if (!eventType || !description || amount == null || !transactionDate || !sourceModule) {
    res.status(400).json({ error: "eventType, sourceModule, description, amount, transactionDate are required." });
    return;
  }
  try {
    const [entry] = await db
      .insert(financialLedgerTable)
      .values({
        organizationId: orgId,
        eventType,
        sourceModule,
        sourceId: sourceId || null,
        sourceRef: sourceRef || null,
        memberId: memberId || null,
        memberName: memberName || null,
        description,
        amount: String(amount),
        currency: currency || "USD",
        taxAmount: String(taxAmount || 0),
        taxCode: taxCode || null,
        transactionDate,
        syncStatus: "pending",
      })
      .returning();
    res.status(201).json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add ledger entry." });
  }
});

/** POST /ledger/ingest — pull revenue events from all modules into the ledger */
router.post("/ledger/ingest", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { dateFrom, dateTo } = req.body as { dateFrom?: string; dateTo?: string };
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = dateFrom || new Date(Date.now() - 86400000 * 30).toISOString().slice(0, 10);
  const toDate = dateTo || today;

  let ingested = 0;

  try {
    // ── POS sales ──────────────────────────────────────────────────────────────
    try {
      const posTxns = await db
        .select()
        .from(posTransactionsTable)
        .where(and(
          eq(posTransactionsTable.organizationId, orgId),
          gte(sql`DATE(${posTransactionsTable.transactedAt})`, fromDate),
          lte(sql`DATE(${posTransactionsTable.transactedAt})`, toDate),
        ));

      for (const txn of posTxns) {
        const existing = await db
          .select({ id: financialLedgerTable.id })
          .from(financialLedgerTable)
          .where(and(
            eq(financialLedgerTable.organizationId, orgId),
            eq(financialLedgerTable.sourceModule, "pos"),
            eq(financialLedgerTable.sourceId, txn.id),
          ));
        if (existing.length > 0) continue;

        await db.insert(financialLedgerTable).values({
          organizationId: orgId,
          eventType: "pos_sale",
          sourceModule: "pos",
          sourceId: txn.id,
          sourceRef: txn.receiptNumber || null,
          memberName: txn.memberName || txn.customerName || null,
          description: `POS Sale #${txn.receiptNumber}`,
          amount: String(txn.totalAmount || 0),
          currency: txn.currency || "USD",
          taxAmount: String(txn.taxAmount || 0),
          transactionDate: txn.transactedAt?.toISOString().slice(0, 10) || today,
          syncStatus: "pending",
        });
        ingested++;
      }
    } catch {
      // pos table may not have all columns — skip gracefully
    }

    // ── Shop orders ────────────────────────────────────────────────────────────
    try {
      const shopOrders = await db
        .select()
        .from(shopOrdersTable)
        .where(and(
          eq(shopOrdersTable.organizationId, orgId),
          gte(sql`DATE(${shopOrdersTable.createdAt})`, fromDate),
          lte(sql`DATE(${shopOrdersTable.createdAt})`, toDate),
        ));

      for (const order of shopOrders) {
        const existing = await db
          .select({ id: financialLedgerTable.id })
          .from(financialLedgerTable)
          .where(and(
            eq(financialLedgerTable.organizationId, orgId),
            eq(financialLedgerTable.sourceModule, "shop"),
            eq(financialLedgerTable.sourceId, order.id),
          ));
        if (existing.length > 0) continue;

        await db.insert(financialLedgerTable).values({
          organizationId: orgId,
          eventType: "pos_sale",
          sourceModule: "shop",
          sourceId: order.id,
          memberName: order.customerName || null,
          description: `Shop Order #${order.id} — ${order.customerName}`,
          amount: String(order.totalAmount || 0),
          currency: order.currency || "USD",
          transactionDate: order.createdAt?.toISOString().slice(0, 10) || today,
          syncStatus: "pending",
        });
        ingested++;
      }
    } catch {
      // skip
    }

    res.json({ ingested, dateFrom: fromDate, dateTo: toDate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ingest failed." });
  }
});

// ─── Finance Dashboard ─────────────────────────────────────────────────────────

/** GET /dashboard?period=monthly|weekly|daily&dateFrom=&dateTo= */
router.get("/dashboard", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { dateFrom, dateTo } = req.query as Record<string, string>;
  const today = new Date().toISOString().slice(0, 10);
  const from = dateFrom || new Date(Date.now() - 86400000 * 30).toISOString().slice(0, 10);
  const to = dateTo || today;

  try {
    const conditions = [
      eq(financialLedgerTable.organizationId, orgId),
      gte(financialLedgerTable.transactionDate, from),
      lte(financialLedgerTable.transactionDate, to),
    ];

    // Revenue by department (event type)
    const byDept = await db
      .select({
        eventType: financialLedgerTable.eventType,
        totalAmount: sum(financialLedgerTable.amount),
        totalTax: sum(financialLedgerTable.taxAmount),
        txCount: count(),
      })
      .from(financialLedgerTable)
      .where(and(...conditions, ne(financialLedgerTable.eventType, "refund")))
      .groupBy(financialLedgerTable.eventType)
      .orderBy(desc(sum(financialLedgerTable.amount)));

    // Refunds
    const [refundRow] = await db
      .select({ totalRefunds: sum(financialLedgerTable.amount) })
      .from(financialLedgerTable)
      .where(and(...conditions, eq(financialLedgerTable.eventType, "refund")));

    // Outstanding (pending sync)
    const [pendingRow] = await db
      .select({ pending: count() })
      .from(financialLedgerTable)
      .where(and(
        eq(financialLedgerTable.organizationId, orgId),
        eq(financialLedgerTable.syncStatus, "pending"),
      ));

    // Sync status breakdown
    const syncStatus = await db
      .select({
        syncStatus: financialLedgerTable.syncStatus,
        txCount: count(),
        totalAmount: sum(financialLedgerTable.amount),
      })
      .from(financialLedgerTable)
      .where(eq(financialLedgerTable.organizationId, orgId))
      .groupBy(financialLedgerTable.syncStatus);

    // Daily revenue series for the period
    const dailySeries = await db
      .select({
        date: financialLedgerTable.transactionDate,
        totalAmount: sum(financialLedgerTable.amount),
        txCount: count(),
      })
      .from(financialLedgerTable)
      .where(and(...conditions, ne(financialLedgerTable.eventType, "refund")))
      .groupBy(financialLedgerTable.transactionDate)
      .orderBy(asc(financialLedgerTable.transactionDate));

    // Grand totals
    const [totals] = await db
      .select({
        totalRevenue: sum(financialLedgerTable.amount),
        totalTax: sum(financialLedgerTable.taxAmount),
        txCount: count(),
      })
      .from(financialLedgerTable)
      .where(and(...conditions, ne(financialLedgerTable.eventType, "refund")));

    res.json({
      dateFrom: from,
      dateTo: to,
      totals: {
        revenue: totals.totalRevenue || "0",
        tax: totals.totalTax || "0",
        transactions: totals.txCount || 0,
        refunds: refundRow?.totalRefunds || "0",
        pendingSync: pendingRow?.pending || 0,
      },
      byDepartment: byDept,
      syncStatus,
      dailySeries,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build dashboard." });
  }
});

// ─── Reconciliation Report ─────────────────────────────────────────────────────

/** GET /reconciliation */
router.get("/reconciliation", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { dateFrom, dateTo } = req.query as Record<string, string>;

  try {
    const conditions = [eq(financialLedgerTable.organizationId, orgId)];
    if (dateFrom) conditions.push(gte(financialLedgerTable.transactionDate, dateFrom));
    if (dateTo) conditions.push(lte(financialLedgerTable.transactionDate, dateTo));

    const [summaryRow] = await db
      .select({
        totalEntries: count(),
        totalAmount: sum(financialLedgerTable.amount),
      })
      .from(financialLedgerTable)
      .where(and(...conditions));

    const pendingEntries = await db
      .select()
      .from(financialLedgerTable)
      .where(and(...conditions, eq(financialLedgerTable.syncStatus, "pending")))
      .orderBy(desc(financialLedgerTable.transactionDate))
      .limit(200);

    const failedEntries = await db
      .select()
      .from(financialLedgerTable)
      .where(and(...conditions, eq(financialLedgerTable.syncStatus, "failed")))
      .orderBy(desc(financialLedgerTable.transactionDate))
      .limit(200);

    const skippedEntries = await db
      .select()
      .from(financialLedgerTable)
      .where(and(...conditions, eq(financialLedgerTable.syncStatus, "skipped")))
      .orderBy(desc(financialLedgerTable.transactionDate))
      .limit(200);

    const [pendingAmt] = await db
      .select({ total: sum(financialLedgerTable.amount) })
      .from(financialLedgerTable)
      .where(and(...conditions, eq(financialLedgerTable.syncStatus, "pending")));

    const [failedAmt] = await db
      .select({ total: sum(financialLedgerTable.amount) })
      .from(financialLedgerTable)
      .where(and(...conditions, eq(financialLedgerTable.syncStatus, "failed")));

    res.json({
      summary: {
        totalEntries: summaryRow?.totalEntries || 0,
        totalAmount: summaryRow?.totalAmount || "0",
        pendingCount: pendingEntries.length,
        pendingAmount: pendingAmt?.total || "0",
        failedCount: failedEntries.length,
        failedAmount: failedAmt?.total || "0",
        skippedCount: skippedEntries.length,
      },
      pending: pendingEntries,
      failed: failedEntries,
      skipped: skippedEntries,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build reconciliation report." });
  }
});

export default router;
