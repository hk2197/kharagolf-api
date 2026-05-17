import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  billingSchedulesTable, memberInvoicesTable, invoiceLineItemsTable, duesPaymentsTable,
  clubMembersTable, membershipTiersTable, organizationsTable, orgMembershipsTable, appUsersTable,
} from "@workspace/db";
import { eq, and, desc, asc, count, sum, sql, inArray, lt, lte, gte, or, isNull, ne } from "drizzle-orm";
import { getRazorpayClient, getRazorpayKeyId } from "../lib/razorpay";
import { logger } from "../lib/logger";
import { createCheckoutPaymentLink, resolveOrgTaxes, recordCheckoutSettlement, verifyCheckoutPayment } from "../lib/checkout";
import { sendBroadcast } from "../lib/comms";
import { sendDuesReceiptEmail } from "../lib/paymentReceipts";
import { notifyPaymentSettled } from "../lib/notifications";
import { gateFeature } from "../lib/featureGate";

const router: IRouter = Router({ mergeParams: true });
router.use(gateFeature("duesBilling"));

// ─── Auth helpers ────────────────────────────────────────────────────────────

interface SessionUser { id: number; role?: string; organizationId?: number }
function getUser(req: Request): SessionUser | undefined { return req.user as SessionUser | undefined; }

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const u = getUser(req);
  if (!u) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (u.role === "super_admin") return true;
  if ((u.role === "org_admin" || u.role === "tournament_director") && Number(u.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, u.id), inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"])));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

async function requireOrgMember(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const u = getUser(req);
  if (!u) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (u.role === "super_admin") return true;
  if (Number(u.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, u.id)));
  if (!m) { res.status(403).json({ error: "Organization membership required" }); return false; }
  return true;
}

// ─── Invoice number generator ─────────────────────────────────────────────────

async function generateInvoiceNumber(orgId: number): Promise<string> {
  const year = new Date().getFullYear();
  const [row] = await db
    .select({ cnt: count() })
    .from(memberInvoicesTable)
    .where(and(
      eq(memberInvoicesTable.organizationId, orgId),
      sql`EXTRACT(YEAR FROM ${memberInvoicesTable.createdAt}) = ${year}`,
    ));
  const seq = (Number(row?.cnt ?? 0) + 1).toString().padStart(4, "0");
  return `DUE-${year}-${seq}`;
}

// ─── BILLING SCHEDULES ────────────────────────────────────────────────────────

// GET /organizations/:orgId/dues-billing/schedules
router.get("/schedules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const schedules = await db
    .select({
      id: billingSchedulesTable.id,
      name: billingSchedulesTable.name,
      billingCycle: billingSchedulesTable.billingCycle,
      amount: billingSchedulesTable.amount,
      currency: billingSchedulesTable.currency,
      gracePeriodDays: billingSchedulesTable.gracePeriodDays,
      suspendAfterDays: billingSchedulesTable.suspendAfterDays,
      reminderDaysBefore: billingSchedulesTable.reminderDaysBefore,
      autoGenerate: billingSchedulesTable.autoGenerate,
      nextRunDate: billingSchedulesTable.nextRunDate,
      isActive: billingSchedulesTable.isActive,
      tierId: billingSchedulesTable.tierId,
      tierName: membershipTiersTable.name,
      createdAt: billingSchedulesTable.createdAt,
    })
    .from(billingSchedulesTable)
    .leftJoin(membershipTiersTable, eq(billingSchedulesTable.tierId, membershipTiersTable.id))
    .where(eq(billingSchedulesTable.organizationId, orgId))
    .orderBy(asc(billingSchedulesTable.name));

  res.json(schedules);
});

// POST /organizations/:orgId/dues-billing/schedules
router.post("/schedules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, billingCycle, amount, currency, gracePeriodDays, suspendAfterDays, reminderDaysBefore, autoGenerate, nextRunDate, tierId } = req.body;
  if (!name || !billingCycle || amount == null) { { res.status(400).json({ error: "name, billingCycle, amount are required" }); return; } }

  const [schedule] = await db.insert(billingSchedulesTable).values({
    organizationId: orgId,
    tierId: tierId ? parseInt(tierId) : null,
    name,
    billingCycle,
    amount: String(amount),
    currency: currency || "INR",
    gracePeriodDays: gracePeriodDays ?? 14,
    suspendAfterDays: suspendAfterDays ?? 30,
    reminderDaysBefore: reminderDaysBefore ?? [7, 1],
    autoGenerate: autoGenerate ?? true,
    nextRunDate: nextRunDate ? new Date(nextRunDate) : null,
  }).returning();

  res.status(201).json(schedule);
});

// PATCH /organizations/:orgId/dues-billing/schedules/:id
router.patch("/schedules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [existing] = await db.select({ id: billingSchedulesTable.id }).from(billingSchedulesTable)
    .where(and(eq(billingSchedulesTable.id, id), eq(billingSchedulesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Schedule not found" }); return; } }

  const { name, billingCycle, amount, currency, gracePeriodDays, suspendAfterDays, reminderDaysBefore, autoGenerate, nextRunDate, isActive, tierId } = req.body;
  const [updated] = await db.update(billingSchedulesTable).set({
    ...(name != null && { name }),
    ...(billingCycle != null && { billingCycle }),
    ...(amount != null && { amount: String(amount) }),
    ...(currency != null && { currency }),
    ...(gracePeriodDays != null && { gracePeriodDays }),
    ...(suspendAfterDays != null && { suspendAfterDays }),
    ...(reminderDaysBefore != null && { reminderDaysBefore }),
    ...(autoGenerate != null && { autoGenerate }),
    ...(nextRunDate !== undefined && { nextRunDate: nextRunDate ? new Date(nextRunDate) : null }),
    ...(isActive != null && { isActive }),
    ...(tierId !== undefined && { tierId: tierId ? parseInt(tierId) : null }),
    updatedAt: new Date(),
  }).where(eq(billingSchedulesTable.id, id)).returning();

  res.json(updated);
});

// DELETE /organizations/:orgId/dues-billing/schedules/:id
router.delete("/schedules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  await db.delete(billingSchedulesTable).where(and(eq(billingSchedulesTable.id, id), eq(billingSchedulesTable.organizationId, orgId)));
  res.json({ success: true });
});

// ─── INVOICES ─────────────────────────────────────────────────────────────────

// GET /organizations/:orgId/dues-billing/invoices
router.get("/invoices", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { status, memberId, page = "1", limit = "50" } = req.query;
  const offset = (parseInt(String(page)) - 1) * parseInt(String(limit));

  const conditions = [eq(memberInvoicesTable.organizationId, orgId)];
  if (status) conditions.push(eq(memberInvoicesTable.status, status as any));
  if (memberId) conditions.push(eq(memberInvoicesTable.clubMemberId, parseInt(String(memberId))));

  const invoices = await db
    .select({
      id: memberInvoicesTable.id,
      invoiceNumber: memberInvoicesTable.invoiceNumber,
      status: memberInvoicesTable.status,
      totalAmount: memberInvoicesTable.totalAmount,
      paidAmount: memberInvoicesTable.paidAmount,
      currency: memberInvoicesTable.currency,
      dueDate: memberInvoicesTable.dueDate,
      paidAt: memberInvoicesTable.paidAt,
      paymentMethod: memberInvoicesTable.paymentMethod,
      razorpayPaymentLinkUrl: memberInvoicesTable.razorpayPaymentLinkUrl,
      sentAt: memberInvoicesTable.sentAt,
      notes: memberInvoicesTable.notes,
      createdAt: memberInvoicesTable.createdAt,
      clubMemberId: memberInvoicesTable.clubMemberId,
      memberFirstName: clubMembersTable.firstName,
      memberLastName: clubMembersTable.lastName,
      memberEmail: clubMembersTable.email,
      memberNumber: clubMembersTable.memberNumber,
      scheduleId: memberInvoicesTable.scheduleId,
      scheduleName: billingSchedulesTable.name,
    })
    .from(memberInvoicesTable)
    .leftJoin(clubMembersTable, eq(memberInvoicesTable.clubMemberId, clubMembersTable.id))
    .leftJoin(billingSchedulesTable, eq(memberInvoicesTable.scheduleId, billingSchedulesTable.id))
    .where(and(...conditions))
    .orderBy(desc(memberInvoicesTable.createdAt))
    .limit(parseInt(String(limit)))
    .offset(offset);

  res.json(invoices);
});

// GET /organizations/:orgId/dues-billing/invoices/:id
router.get("/invoices/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [invoice] = await db
    .select({
      id: memberInvoicesTable.id,
      invoiceNumber: memberInvoicesTable.invoiceNumber,
      status: memberInvoicesTable.status,
      totalAmount: memberInvoicesTable.totalAmount,
      paidAmount: memberInvoicesTable.paidAmount,
      currency: memberInvoicesTable.currency,
      dueDate: memberInvoicesTable.dueDate,
      paidAt: memberInvoicesTable.paidAt,
      paymentMethod: memberInvoicesTable.paymentMethod,
      razorpayPaymentLinkId: memberInvoicesTable.razorpayPaymentLinkId,
      razorpayPaymentLinkUrl: memberInvoicesTable.razorpayPaymentLinkUrl,
      razorpayPaymentId: memberInvoicesTable.razorpayPaymentId,
      remindersSentAt: memberInvoicesTable.remindersSentAt,
      sentAt: memberInvoicesTable.sentAt,
      notes: memberInvoicesTable.notes,
      createdAt: memberInvoicesTable.createdAt,
      updatedAt: memberInvoicesTable.updatedAt,
      clubMemberId: memberInvoicesTable.clubMemberId,
      memberFirstName: clubMembersTable.firstName,
      memberLastName: clubMembersTable.lastName,
      memberEmail: clubMembersTable.email,
      memberNumber: clubMembersTable.memberNumber,
      scheduleId: memberInvoicesTable.scheduleId,
    })
    .from(memberInvoicesTable)
    .leftJoin(clubMembersTable, eq(memberInvoicesTable.clubMemberId, clubMembersTable.id))
    .where(and(eq(memberInvoicesTable.id, id), eq(memberInvoicesTable.organizationId, orgId)));

  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  const lineItems = await db.select().from(invoiceLineItemsTable).where(eq(invoiceLineItemsTable.invoiceId, id)).orderBy(asc(invoiceLineItemsTable.id));
  const payments = await db.select().from(duesPaymentsTable).where(eq(duesPaymentsTable.invoiceId, id)).orderBy(desc(duesPaymentsTable.paidAt));

  res.json({ ...invoice, lineItems, payments });
});

// POST /organizations/:orgId/dues-billing/invoices — create ad-hoc or manual invoice
router.post("/invoices", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { clubMemberId, scheduleId, dueDate, notes, lineItems } = req.body;
  if (!clubMemberId) { { res.status(400).json({ error: "clubMemberId is required" }); return; } }
  if (!lineItems || !Array.isArray(lineItems) || lineItems.length === 0) { { res.status(400).json({ error: "At least one line item is required" }); return; } }

  const [member] = await db.select({ id: clubMembersTable.id, currency: membershipTiersTable.currency })
    .from(clubMembersTable)
    .leftJoin(membershipTiersTable, eq(clubMembersTable.tierId, membershipTiersTable.id))
    .where(and(eq(clubMembersTable.id, parseInt(String(clubMemberId))), eq(clubMembersTable.organizationId, orgId)));
  if (!member) { { res.status(404).json({ error: "Club member not found" }); return; } }

  const invoiceNumber = await generateInvoiceNumber(orgId);
  const totalAmount = lineItems.reduce((s: number, li: any) => s + parseFloat(String(li.unitAmount)) * parseFloat(String(li.quantity ?? 1)), 0);

  const [invoice] = await db.insert(memberInvoicesTable).values({
    organizationId: orgId,
    clubMemberId: parseInt(String(clubMemberId)),
    scheduleId: scheduleId ? parseInt(String(scheduleId)) : null,
    invoiceNumber,
    status: "draft",
    totalAmount: String(totalAmount),
    currency: lineItems[0]?.currency || member.currency || "INR",
    dueDate: dueDate ? new Date(dueDate) : null,
    notes,
  }).returning();

  await db.insert(invoiceLineItemsTable).values(
    lineItems.map((li: any) => ({
      invoiceId: invoice.id,
      description: li.description,
      quantity: String(li.quantity ?? 1),
      unitAmount: String(li.unitAmount),
      totalAmount: String(parseFloat(String(li.unitAmount)) * parseFloat(String(li.quantity ?? 1))),
      lineType: li.lineType || "dues",
    }))
  );

  res.status(201).json(invoice);
});

// PATCH /organizations/:orgId/dues-billing/invoices/:id
router.patch("/invoices/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [existing] = await db.select().from(memberInvoicesTable)
    .where(and(eq(memberInvoicesTable.id, id), eq(memberInvoicesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  const { status, dueDate, notes, paidAmount, paymentMethod, paidAt } = req.body;
  const [updated] = await db.update(memberInvoicesTable).set({
    ...(status != null && { status }),
    ...(dueDate !== undefined && { dueDate: dueDate ? new Date(dueDate) : null }),
    ...(notes !== undefined && { notes }),
    ...(paidAmount != null && { paidAmount: String(paidAmount) }),
    ...(paymentMethod != null && { paymentMethod }),
    ...(paidAt !== undefined && { paidAt: paidAt ? new Date(paidAt) : null }),
    updatedAt: new Date(),
  }).where(eq(memberInvoicesTable.id, id)).returning();

  res.json(updated);
});

// POST /organizations/:orgId/dues-billing/invoices/:id/send
router.post("/invoices/:id/send", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [invoice] = await db
    .select({
      id: memberInvoicesTable.id,
      invoiceNumber: memberInvoicesTable.invoiceNumber,
      status: memberInvoicesTable.status,
      totalAmount: memberInvoicesTable.totalAmount,
      currency: memberInvoicesTable.currency,
      dueDate: memberInvoicesTable.dueDate,
      razorpayPaymentLinkUrl: memberInvoicesTable.razorpayPaymentLinkUrl,
      clubMemberId: memberInvoicesTable.clubMemberId,
      memberFirstName: clubMembersTable.firstName,
      memberLastName: clubMembersTable.lastName,
      memberEmail: clubMembersTable.email,
      userId: clubMembersTable.userId,
    })
    .from(memberInvoicesTable)
    .leftJoin(clubMembersTable, eq(memberInvoicesTable.clubMemberId, clubMembersTable.id))
    .where(and(eq(memberInvoicesTable.id, id), eq(memberInvoicesTable.organizationId, orgId)));

  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  // Create payment link if not already present — routes through the new
  // payment-processor abstraction so non-INR clubs get a Stripe Checkout
  // Session instead of a Razorpay Payment Link.
  let paymentLinkUrl = invoice.razorpayPaymentLinkUrl;
  if (!paymentLinkUrl) {
    try {
      // Pre-compute taxes so non-INR jurisdictions get a correct breakdown
      // surfaced to downstream reporting. INR/GST profiles are unchanged.
      await resolveOrgTaxes({
        organizationId: orgId,
        taxableAmount: parseFloat(invoice.totalAmount),
        currency: invoice.currency,
        productClass: "membership_dues",
      }).catch((err) => logger.warn({ err }, "[DUES] tax resolution skipped"));

      const link = await createCheckoutPaymentLink({
        organizationId: orgId,
        amount: parseFloat(invoice.totalAmount),
        currency: invoice.currency,
        description: `Membership Dues — ${invoice.invoiceNumber}`,
        customerName: `${invoice.memberFirstName ?? ""} ${invoice.memberLastName ?? ""}`.trim(),
        customerEmail: invoice.memberEmail ?? undefined,
        expireAtUnix: invoice.dueDate ? Math.floor(new Date(invoice.dueDate).getTime() / 1000) : undefined,
        notify: { email: false, sms: false },
        notes: { invoiceId: String(invoice.id), invoiceNumber: invoice.invoiceNumber, orgId: String(orgId) },
        sourceType: "dues_invoice",
        sourceId: invoice.id,
      });
      paymentLinkUrl = link.url;
      await db.update(memberInvoicesTable).set({
        razorpayPaymentLinkId: link.id,
        razorpayPaymentLinkUrl: link.url,
        updatedAt: new Date(),
      }).where(eq(memberInvoicesTable.id, id));
    } catch (err) {
      logger.warn({ err }, "[DUES] payment link creation failed — proceeding without link");
    }
  }

  // Send in-app notification to linked user
  if (invoice.userId) {
    try {
      await sendBroadcast(
        [{ userId: invoice.userId, email: invoice.memberEmail ?? undefined, firstName: invoice.memberFirstName ?? "", lastName: invoice.memberLastName ?? "" }],
        {
          subject: "Dues Invoice",
          body: `Your membership dues invoice ${invoice.invoiceNumber} for ${invoice.currency} ${invoice.totalAmount} is ready.${paymentLinkUrl ? ` Pay online: ${paymentLinkUrl}` : ""}`,
          channels: ["push", "email"],
          eventName: "dues_invoice",
          // Task #1566 — tag dues-invoice notification with the
          // originating club so the Postmark bounce webhook (Task #981)
          // can attribute hard bounces back to this org instantly when
          // the email channel is engaged.
          organizationId: orgId,
        }
      );
    } catch {}
  }

  const [updated] = await db.update(memberInvoicesTable).set({
    status: "sent",
    sentAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(memberInvoicesTable.id, id)).returning();

  res.json(updated);
});

// POST /organizations/:orgId/dues-billing/invoices/:id/mark-paid
router.post("/invoices/:id/mark-paid", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [invoice] = await db.select().from(memberInvoicesTable)
    .where(and(eq(memberInvoicesTable.id, id), eq(memberInvoicesTable.organizationId, orgId)));
  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  const { amount, method, reference, paidAt, notes } = req.body;
  const paymentAmount = amount ? parseFloat(String(amount)) : parseFloat(invoice.totalAmount);

  await db.insert(duesPaymentsTable).values({
    invoiceId: id,
    organizationId: orgId,
    amount: String(paymentAmount),
    currency: invoice.currency,
    method: method || "cash",
    reference,
    notes,
    paidAt: paidAt ? new Date(paidAt) : new Date(),
  });

  const newPaidAmount = parseFloat(invoice.paidAmount) + paymentAmount;
  const isPaid = newPaidAmount >= parseFloat(invoice.totalAmount);

  const [updated] = await db.update(memberInvoicesTable).set({
    paidAmount: String(newPaidAmount),
    paymentMethod: method || invoice.paymentMethod || "cash",
    status: isPaid ? "paid" : invoice.status,
    paidAt: isPaid ? (paidAt ? new Date(paidAt) : new Date()) : invoice.paidAt,
    updatedAt: new Date(),
  }).where(eq(memberInvoicesTable.id, id)).returning();

  // Reactivate member subscription if was past_due
  if (isPaid) {
    await db.update(clubMembersTable).set({
      subscriptionStatus: "active",
      updatedAt: new Date(),
    }).where(and(eq(clubMembersTable.id, invoice.clubMemberId), eq(clubMembersTable.subscriptionStatus, "past_due")));
  }

  res.json(updated);
});

// POST /organizations/:orgId/dues-billing/invoices/:id/void
router.post("/invoices/:id/void", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  const [invoice] = await db.select({ id: memberInvoicesTable.id }).from(memberInvoicesTable)
    .where(and(eq(memberInvoicesTable.id, id), eq(memberInvoicesTable.organizationId, orgId)));
  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  const [updated] = await db.update(memberInvoicesTable).set({ status: "void", updatedAt: new Date() }).where(eq(memberInvoicesTable.id, id)).returning();
  res.json(updated);
});

// ─── BULK INVOICE GENERATION (billing engine) ─────────────────────────────────

// POST /organizations/:orgId/dues-billing/generate — trigger invoice generation for a schedule
router.post("/generate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { scheduleId, dueDate } = req.body;
  if (!scheduleId) { { res.status(400).json({ error: "scheduleId is required" }); return; } }

  const [schedule] = await db.select().from(billingSchedulesTable)
    .where(and(eq(billingSchedulesTable.id, parseInt(String(scheduleId))), eq(billingSchedulesTable.organizationId, orgId)));
  if (!schedule) { { res.status(404).json({ error: "Schedule not found" }); return; } }

  // Get all active members for this tier (or all members if no tier)
  const memberConditions = [eq(clubMembersTable.organizationId, orgId), ne(clubMembersTable.subscriptionStatus, "cancelled")];
  if (schedule.tierId) memberConditions.push(eq(clubMembersTable.tierId, schedule.tierId));

  const members = await db.select({
    id: clubMembersTable.id,
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    email: clubMembersTable.email,
  }).from(clubMembersTable).where(and(...memberConditions));

  const effectiveDueDate = dueDate ? new Date(dueDate) : (() => {
    const d = new Date();
    switch (schedule.billingCycle) {
      case "monthly": d.setMonth(d.getMonth() + 1); break;
      case "quarterly": d.setMonth(d.getMonth() + 3); break;
      case "semi_annual": d.setMonth(d.getMonth() + 6); break;
      default: d.setFullYear(d.getFullYear() + 1);
    }
    return d;
  })();

  const created: number[] = [];
  for (const member of members) {
    const invoiceNumber = await generateInvoiceNumber(orgId);
    const [invoice] = await db.insert(memberInvoicesTable).values({
      organizationId: orgId,
      clubMemberId: member.id,
      scheduleId: schedule.id,
      invoiceNumber,
      status: "draft",
      totalAmount: schedule.amount,
      currency: schedule.currency,
      dueDate: effectiveDueDate,
    }).returning();
    await db.insert(invoiceLineItemsTable).values({
      invoiceId: invoice.id,
      description: schedule.name,
      quantity: "1",
      unitAmount: schedule.amount,
      totalAmount: schedule.amount,
      lineType: "dues",
    });
    created.push(invoice.id);
  }

  // Update schedule next run date
  const nextRun = new Date(effectiveDueDate);
  switch (schedule.billingCycle) {
    case "monthly": nextRun.setMonth(nextRun.getMonth() + 1); break;
    case "quarterly": nextRun.setMonth(nextRun.getMonth() + 3); break;
    case "semi_annual": nextRun.setMonth(nextRun.getMonth() + 6); break;
    default: nextRun.setFullYear(nextRun.getFullYear() + 1);
  }
  await db.update(billingSchedulesTable).set({ nextRunDate: nextRun, updatedAt: new Date() }).where(eq(billingSchedulesTable.id, schedule.id));

  res.json({ created: created.length, invoiceIds: created });
});

// ─── OVERDUE PROCESSING ───────────────────────────────────────────────────────

// POST /organizations/:orgId/dues-billing/process-overdue — flag & suspend overdue accounts
router.post("/process-overdue", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const now = new Date();

  // Mark sent invoices past due date as overdue
  const overdueSent = await db
    .select({ id: memberInvoicesTable.id, clubMemberId: memberInvoicesTable.clubMemberId, scheduleId: memberInvoicesTable.scheduleId })
    .from(memberInvoicesTable)
    .where(and(
      eq(memberInvoicesTable.organizationId, orgId),
      eq(memberInvoicesTable.status, "sent"),
      lte(memberInvoicesTable.dueDate, now),
    ));

  let markedOverdue = 0;
  let suspended = 0;

  for (const inv of overdueSent) {
    await db.update(memberInvoicesTable).set({ status: "overdue", updatedAt: new Date() }).where(eq(memberInvoicesTable.id, inv.id));
    markedOverdue++;

    // Suspend member if they have a schedule with suspend logic
    if (inv.scheduleId) {
      const [sched] = await db.select({ suspendAfterDays: billingSchedulesTable.suspendAfterDays })
        .from(billingSchedulesTable).where(eq(billingSchedulesTable.id, inv.scheduleId));
      if (sched) {
        const [invoice] = await db.select({ dueDate: memberInvoicesTable.dueDate }).from(memberInvoicesTable).where(eq(memberInvoicesTable.id, inv.id));
        if (invoice?.dueDate) {
          const daysOverdue = Math.floor((now.getTime() - new Date(invoice.dueDate).getTime()) / (1000 * 60 * 60 * 24));
          if (daysOverdue >= sched.suspendAfterDays) {
            await db.update(clubMembersTable).set({ subscriptionStatus: "past_due", updatedAt: new Date() }).where(eq(clubMembersTable.id, inv.clubMemberId));
            suspended++;
          }
        }
      }
    }
  }

  res.json({ markedOverdue, suspended });
});

// ─── ADMIN BILLING DASHBOARD ──────────────────────────────────────────────────

// GET /organizations/:orgId/dues-billing/dashboard
router.get("/dashboard", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [totals] = await db
    .select({
      totalBilled: sql<string>`COALESCE(SUM(${memberInvoicesTable.totalAmount}), 0)`,
      totalCollected: sql<string>`COALESCE(SUM(${memberInvoicesTable.paidAmount}), 0)`,
      totalOutstanding: sql<string>`COALESCE(SUM(CASE WHEN ${memberInvoicesTable.status} != 'paid' AND ${memberInvoicesTable.status} != 'void' AND ${memberInvoicesTable.status} != 'cancelled' THEN ${memberInvoicesTable.totalAmount} - ${memberInvoicesTable.paidAmount} ELSE 0 END), 0)`,
      countPaid: sql<string>`COUNT(CASE WHEN ${memberInvoicesTable.status} = 'paid' THEN 1 END)`,
      countOverdue: sql<string>`COUNT(CASE WHEN ${memberInvoicesTable.status} = 'overdue' THEN 1 END)`,
      countSent: sql<string>`COUNT(CASE WHEN ${memberInvoicesTable.status} = 'sent' THEN 1 END)`,
      countDraft: sql<string>`COUNT(CASE WHEN ${memberInvoicesTable.status} = 'draft' THEN 1 END)`,
    })
    .from(memberInvoicesTable)
    .where(and(
      eq(memberInvoicesTable.organizationId, orgId),
      ne(memberInvoicesTable.status, "void"),
    ));

  // Outstanding members (members with overdue invoices)
  const overdueMembers = await db
    .select({
      memberId: memberInvoicesTable.clubMemberId,
      memberFirstName: clubMembersTable.firstName,
      memberLastName: clubMembersTable.lastName,
      memberEmail: clubMembersTable.email,
      memberNumber: clubMembersTable.memberNumber,
      invoiceCount: count(memberInvoicesTable.id),
      totalOutstanding: sql<string>`SUM(${memberInvoicesTable.totalAmount} - ${memberInvoicesTable.paidAmount})`,
      oldestDueDate: sql<string>`MIN(${memberInvoicesTable.dueDate})`,
    })
    .from(memberInvoicesTable)
    .leftJoin(clubMembersTable, eq(memberInvoicesTable.clubMemberId, clubMembersTable.id))
    .where(and(eq(memberInvoicesTable.organizationId, orgId), eq(memberInvoicesTable.status, "overdue")))
    .groupBy(memberInvoicesTable.clubMemberId, clubMembersTable.firstName, clubMembersTable.lastName, clubMembersTable.email, clubMembersTable.memberNumber)
    .orderBy(sql`MIN(${memberInvoicesTable.dueDate})`);

  // Suspended members
  const suspendedCount = await db
    .select({ count: count() })
    .from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.subscriptionStatus, "past_due")));

  res.json({
    totalBilled: parseFloat(totals?.totalBilled ?? "0"),
    totalCollected: parseFloat(totals?.totalCollected ?? "0"),
    totalOutstanding: parseFloat(totals?.totalOutstanding ?? "0"),
    countPaid: parseInt(totals?.countPaid ?? "0"),
    countOverdue: parseInt(totals?.countOverdue ?? "0"),
    countSent: parseInt(totals?.countSent ?? "0"),
    countDraft: parseInt(totals?.countDraft ?? "0"),
    overdueMembers,
    suspendedMembersCount: Number(suspendedCount[0]?.count ?? 0),
  });
});

// GET /organizations/:orgId/dues-billing/invoices/export — CSV export
router.get("/export", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const invoices = await db
    .select({
      invoiceNumber: memberInvoicesTable.invoiceNumber,
      status: memberInvoicesTable.status,
      totalAmount: memberInvoicesTable.totalAmount,
      paidAmount: memberInvoicesTable.paidAmount,
      currency: memberInvoicesTable.currency,
      dueDate: memberInvoicesTable.dueDate,
      paidAt: memberInvoicesTable.paidAt,
      paymentMethod: memberInvoicesTable.paymentMethod,
      createdAt: memberInvoicesTable.createdAt,
      memberFirstName: clubMembersTable.firstName,
      memberLastName: clubMembersTable.lastName,
      memberEmail: clubMembersTable.email,
      memberNumber: clubMembersTable.memberNumber,
    })
    .from(memberInvoicesTable)
    .leftJoin(clubMembersTable, eq(memberInvoicesTable.clubMemberId, clubMembersTable.id))
    .where(eq(memberInvoicesTable.organizationId, orgId))
    .orderBy(desc(memberInvoicesTable.createdAt));

  const rows = [
    ["Invoice Number", "Member Number", "First Name", "Last Name", "Email", "Status", "Amount", "Paid Amount", "Currency", "Due Date", "Paid At", "Payment Method", "Created At"],
    ...invoices.map(r => [
      r.invoiceNumber, r.memberNumber ?? "", r.memberFirstName ?? "", r.memberLastName ?? "", r.memberEmail ?? "",
      r.status, r.totalAmount, r.paidAmount, r.currency,
      r.dueDate ? new Date(r.dueDate).toISOString().split("T")[0] : "",
      r.paidAt ? new Date(r.paidAt).toISOString().split("T")[0] : "",
      r.paymentMethod ?? "",
      r.createdAt ? new Date(r.createdAt).toISOString().split("T")[0] : "",
    ]),
  ];

  const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="dues-billing-export.csv"`);
  res.send(csv);
});

// ─── MEMBER PORTAL — own invoices ─────────────────────────────────────────────

// GET /organizations/:orgId/dues-billing/my-invoices — for logged-in member
router.get("/my-invoices", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const u = getUser(req);
  if (!u) { { res.status(401).json({ error: "Authentication required" }); return; } }

  // Find the club member record for this user
  const [member] = await db.select({ id: clubMembersTable.id }).from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.userId, u.id)));
  if (!member) { { res.json([]); return; } }

  const invoices = await db
    .select({
      id: memberInvoicesTable.id,
      invoiceNumber: memberInvoicesTable.invoiceNumber,
      status: memberInvoicesTable.status,
      totalAmount: memberInvoicesTable.totalAmount,
      paidAmount: memberInvoicesTable.paidAmount,
      currency: memberInvoicesTable.currency,
      dueDate: memberInvoicesTable.dueDate,
      paidAt: memberInvoicesTable.paidAt,
      paymentMethod: memberInvoicesTable.paymentMethod,
      razorpayPaymentLinkUrl: memberInvoicesTable.razorpayPaymentLinkUrl,
      sentAt: memberInvoicesTable.sentAt,
      notes: memberInvoicesTable.notes,
      createdAt: memberInvoicesTable.createdAt,
    })
    .from(memberInvoicesTable)
    .where(and(eq(memberInvoicesTable.organizationId, orgId), eq(memberInvoicesTable.clubMemberId, member.id)))
    .orderBy(desc(memberInvoicesTable.createdAt));

  res.json(invoices);
});

// GET /organizations/:orgId/dues-billing/members/:memberId/invoices — for admin
router.get("/members/:memberId/invoices", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  const invoices = await db
    .select({
      id: memberInvoicesTable.id,
      invoiceNumber: memberInvoicesTable.invoiceNumber,
      status: memberInvoicesTable.status,
      totalAmount: memberInvoicesTable.totalAmount,
      paidAmount: memberInvoicesTable.paidAmount,
      currency: memberInvoicesTable.currency,
      dueDate: memberInvoicesTable.dueDate,
      paidAt: memberInvoicesTable.paidAt,
      paymentMethod: memberInvoicesTable.paymentMethod,
      razorpayPaymentLinkUrl: memberInvoicesTable.razorpayPaymentLinkUrl,
      sentAt: memberInvoicesTable.sentAt,
      notes: memberInvoicesTable.notes,
      createdAt: memberInvoicesTable.createdAt,
    })
    .from(memberInvoicesTable)
    .where(and(eq(memberInvoicesTable.organizationId, orgId), eq(memberInvoicesTable.clubMemberId, memberId)))
    .orderBy(desc(memberInvoicesTable.createdAt));

  res.json(invoices);
});

// ─── PAYMENT VERIFY (Razorpay or Stripe) ──────────────────────────────────────
// Note: A complementary path exists in the global webhooks router; this endpoint
// is the in-app verification for payment-link confirmations.

// POST /organizations/:orgId/dues-billing/invoices/:id/verify-payment
router.post("/invoices/:id/verify-payment", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }

  const id = parseInt(String((req.params as Record<string, string>).id));
  const {
    razorpayPaymentId, razorpayPaymentLinkId, razorpaySignature,
    stripePaymentIntentId, stripeCheckoutSessionId,
  } = req.body;

  const [invoice] = await db.select().from(memberInvoicesTable)
    .where(and(eq(memberInvoicesTable.id, id), eq(memberInvoicesTable.organizationId, orgId)));
  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  let settledPaymentRef: string | undefined = razorpayPaymentId;
  let settledCurrencyFromProcessor = "";
  let settledAmountMinorFromProcessor = 0;
  let processorUsed: "razorpay" | "stripe" = "razorpay";

  if (stripePaymentIntentId || stripeCheckoutSessionId) {
    // STRICT BINDING: the Stripe object must be the one created for THIS
    // invoice (its id is stored on the invoice as `razorpayPaymentLinkId` —
    // the column is shared by both processors).
    if (!invoice.razorpayPaymentLinkId) {
      res.status(400).json({ error: "Invoice has no associated payment link to verify against" }); return;
    }
    // For Stripe we require the checkout-session id (that's what we stored at
    // creation). PaymentIntent-only verification is not accepted because we
    // would have to fetch the session to map PI → invoice, which adds latency
    // and another failure surface — callers should pass the session id.
    if (!stripeCheckoutSessionId) {
      res.status(400).json({ error: "stripeCheckoutSessionId is required for Stripe dues verification" }); return;
    }
    if (stripeCheckoutSessionId !== invoice.razorpayPaymentLinkId) {
      res.status(400).json({ error: "Stripe checkout session does not match this invoice's payment link" }); return;
    }
    const v = await verifyCheckoutPayment({
      processor: "stripe",
      stripeCheckoutSessionId,
    });
    if (!v.paid) { { res.status(400).json({ error: "Stripe payment not yet settled" }); return; } }
    // Defence-in-depth: confirm the processor returned the same object id we
    // requested (guards against a malformed/proxied response).
    if (v.objectId !== stripeCheckoutSessionId) {
      res.status(400).json({ error: "Stripe response object id mismatch" }); return;
    }
    // Validate metadata stamped at creation: invoiceId + orgId.
    const metaInvoiceId = v.metadata["invoiceId"];
    const metaOrgId = v.metadata["orgId"];
    if (metaInvoiceId !== String(id) || metaOrgId !== String(orgId)) {
      res.status(400).json({ error: "Stripe payment metadata does not match this invoice" }); return;
    }
    // Validate currency + amount match the invoice (defends against
    // partial-amount or wrong-currency settlement being applied).
    if (v.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
      res.status(400).json({ error: "Settlement currency does not match invoice currency" }); return;
    }
    const expectedMinor = Math.round(parseFloat(invoice.totalAmount) * 100);
    if (v.amountMinor !== expectedMinor) {
      res.status(400).json({ error: "Settlement amount does not match invoice total" }); return;
    }
    settledPaymentRef = v.paymentRef;
    settledCurrencyFromProcessor = v.currency;
    settledAmountMinorFromProcessor = v.amountMinor;
    processorUsed = "stripe";
  }
  // Note: Razorpay payment-link confirmations are signature-verified via the
  // /webhooks/razorpay handler; this endpoint relies on that prior verification
  // having occurred (existing behaviour preserved).

  // Mark paid
  await db.insert(duesPaymentsTable).values({
    invoiceId: id,
    organizationId: orgId,
    amount: invoice.totalAmount,
    currency: invoice.currency,
    method: "online",
    razorpayPaymentId: settledPaymentRef,
    paidAt: new Date(),
  });

  // Status-flip guard for Task #978: only the first verify call (or webhook
  // re-delivery) flips status from non-paid → paid; the in-app push below
  // fires only when this update returns a row.
  const updateRows = await db.update(memberInvoicesTable).set({
    status: "paid",
    paidAmount: invoice.totalAmount,
    paidAt: new Date(),
    paymentMethod: "online",
    razorpayPaymentId: settledPaymentRef,
    updatedAt: new Date(),
  }).where(and(eq(memberInvoicesTable.id, id), ne(memberInvoicesTable.status, "paid"))).returning();
  const wasFlipped = updateRows.length > 0;
  const [updated] = wasFlipped
    ? updateRows
    : await db.select().from(memberInvoicesTable).where(eq(memberInvoicesTable.id, id));

  // Reactivate member if was past_due
  await db.update(clubMembersTable).set({ subscriptionStatus: "active", updatedAt: new Date() })
    .where(and(eq(clubMembersTable.id, invoice.clubMemberId), eq(clubMembersTable.subscriptionStatus, "past_due")));

  // FX ledger entry on settlement.
  try {
    const settlementCurrency = settledCurrencyFromProcessor || invoice.currency;
    const settlementAmount = settledAmountMinorFromProcessor > 0
      ? settledAmountMinorFromProcessor / 100
      : parseFloat(invoice.totalAmount);
    await recordCheckoutSettlement({
      organizationId: orgId,
      processor: processorUsed,
      settledCurrency: settlementCurrency,
      settledAmount: settlementAmount,
      paymentRef: settledPaymentRef ?? `dues:${id}`,
      sourceType: "dues_invoice",
      sourceId: id,
    });
  } catch (e) {
    logger.warn({ err: e, invoiceId: id }, "[dues-billing] FX settlement recording failed");
  }

  // Receipt email + PDF (best-effort).
  try {
    const [member] = await db.select({
      firstName: clubMembersTable.firstName,
      lastName: clubMembersTable.lastName,
      email: clubMembersTable.email,
    }).from(clubMembersTable).where(eq(clubMembersTable.id, invoice.clubMemberId));
    const [org] = await db.select({
      name: organizationsTable.name,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    if (member?.email) {
      const totalSubunit = Math.round(parseFloat(String(invoice.totalAmount ?? "0")) * 100);
      await sendDuesReceiptEmail({
        email: member.email,
        memberName: `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim(),
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        lineItems: [{ description: `Membership dues — ${invoice.invoiceNumber}`, quantity: 1, totalAmountSubunit: totalSubunit }],
        totalSubunit,
        currency: invoice.currency || "INR",
        paymentId: settledPaymentRef ?? `dues:${id}`,
        paidAt: new Date(),
        branding: { orgName: org?.name ?? "Your Club", logoUrl: org?.logoUrl ?? undefined, primaryColor: org?.primaryColor ?? undefined },
      });
    }
  } catch (notifyErr) {
    logger.warn({ err: notifyErr, invoiceId: id }, "[dues-billing] verify-payment receipt email failed");
  }

  // In-app push to the paying member (Task #978 — Razorpay parity with the
  // Stripe push that already fires for dues from this same code path under
  // Task #832). The Stripe branch is intentionally excluded — Stripe dues
  // pushes are owned by the Stripe webhook handler in routes/webhooks.ts.
  if (processorUsed === "razorpay" && wasFlipped) {
    try {
      const [memberRow] = await db.select({ userId: clubMembersTable.userId })
        .from(clubMembersTable).where(eq(clubMembersTable.id, invoice.clubMemberId));
      const [orgRow] = await db.select({ name: organizationsTable.name })
        .from(organizationsTable).where(eq(organizationsTable.id, orgId));
      await notifyPaymentSettled({
        userId: memberRow?.userId ?? null,
        kind: "dues",
        eventName: orgRow?.name ?? "Your Club",
        amountMinor: Math.round(parseFloat(invoice.totalAmount) * 100),
        currency: invoice.currency || "INR",
        paymentRef: settledPaymentRef ?? `dues:${id}`,
        organizationId: orgId,
        entityId: id,
      });
    } catch (pushErr) {
      logger.warn({ err: pushErr, invoiceId: id }, "[dues-billing/verify-payment] push failed");
    }
  }

  res.json({ ...updated, processor: processorUsed });
});

export default router;
