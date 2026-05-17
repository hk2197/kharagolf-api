/**
 * Vendor Operator Pro Shop Management API — Task #119
 * Base: /organizations/:orgId/vendor-operators
 *
 * Vendor Operators (entity management)
 * GET    /                              List all vendor operators
 * POST   /                              Create a vendor operator
 * GET    /:vendorId                     Get vendor operator detail
 * PATCH  /:vendorId                     Update vendor operator
 * DELETE /:vendorId                     Deactivate vendor operator
 *
 * Facility Assignments
 * GET    /:vendorId/assignments          List facility assignments
 * POST   /:vendorId/assignments          Assign vendor to a facility
 * PATCH  /:vendorId/assignments/:id      Update assignment
 * DELETE /:vendorId/assignments/:id      Unassign (soft-deactivate)
 *
 * Contracts
 * GET    /:vendorId/contracts            List contracts
 * POST   /:vendorId/contracts            Create contract
 * PATCH  /:vendorId/contracts/:contractId   Update contract
 * POST   /:vendorId/contracts/:contractId/terminate  Terminate contract
 * POST   /:vendorId/contracts/:contractId/renew      Renew contract (creates new)
 *
 * Billing Cycles
 * GET    /:vendorId/billing-cycles       List billing cycles
 * POST   /:vendorId/billing-cycles       Generate a billing cycle
 *
 * Invoices
 * GET    /:vendorId/invoices             List invoices
 * GET    /:vendorId/invoices/:invoiceId  Get invoice detail
 * POST   /:vendorId/invoices             Create invoice (links billing cycle)
 * PATCH  /:vendorId/invoices/:invoiceId  Update invoice (mark paid, send link)
 * POST   /:vendorId/invoices/:invoiceId/payment-link  Send Razorpay payment link
 *
 * Settlement Report
 * GET    /:vendorId/billing-cycles/:cycleId/settlement   Get settlement report
 *
 * Org-Level Alerts
 * GET    /renewal-alerts                 Contracts expiring within 90 days
 * POST   /renewal-alerts/dispatch        Trigger renewal alert dispatch (cron)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  vendorOperatorsTable,
  vendorFacilityAssignmentsTable,
  vendorContractsTable,
  vendorBillingCyclesTable,
  vendorInvoicesTable,
  vendorContractAlertsTable,
  posTransactionsTable,
  posTransactionItemsTable,
  memberAccountChargesTable,
  orgMembershipsTable,
  organizationsTable,
  appUsersTable,
} from "@workspace/db";
import { eq, and, or, desc, asc, gte, lte, sum, inArray } from "drizzle-orm";
import { getRazorpayClient } from "../lib/razorpay";
import nodemailer from "nodemailer";
import PDFDocument from "pdfkit";

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

/**
 * Read-only access guard for vendor-scoped staff.
 * Allows:
 *  - org_admin / tournament_director / super_admin — always permitted
 *  - pro_shop users whose orgMembership.vendorOperatorId === vendorId — read-only access to their own vendor
 *
 * Returns true if access is granted; false (and sends 401/403) otherwise.
 */
async function requireVendorStaffOrOrgAdmin(
  req: Request,
  res: Response,
  orgId: number,
  vendorId: number,
): Promise<boolean> {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;

  const [membership] = await db
    .select({ role: orgMembershipsTable.role, vendorOperatorId: orgMembershipsTable.vendorOperatorId })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));

  if (!membership) {
    res.status(403).json({ error: "Access denied." });
    return false;
  }

  // Full admin access
  if (["org_admin", "tournament_director"].includes(membership.role)) return true;

  // Vendor staff: must match vendorId AND be scoped to the same org
  if (membership.role === "pro_shop" && membership.vendorOperatorId === vendorId) return true;

  res.status(403).json({ error: "Access denied to this vendor's data." });
  return false;
}

/**
 * Validates that the given vendorId belongs to orgId.
 * Returns the vendor row on success, or sends 404 and returns null.
 * Use at the top of every mutation handler that accepts :vendorId.
 */
async function resolveVendorForOrg(
  res: Response,
  vendorId: number,
  orgId: number,
): Promise<typeof vendorOperatorsTable.$inferSelect | null> {
  const [vendor] = await db
    .select()
    .from(vendorOperatorsTable)
    .where(and(eq(vendorOperatorsTable.id, vendorId), eq(vendorOperatorsTable.organizationId, orgId)));
  if (!vendor) {
    res.status(404).json({ error: "Vendor operator not found for this organization." });
    return null;
  }
  return vendor;
}

/**
 * Fetch org admin email addresses for notification dispatch.
 */
async function getOrgAdminEmails(orgId: number): Promise<string[]> {
  const admins = await db
    .select({ email: appUsersTable.email })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      or(
        eq(orgMembershipsTable.role, "org_admin"),
        eq(orgMembershipsTable.role, "tournament_director"),
      ),
    ));
  return admins.map(a => a.email).filter(Boolean) as string[];
}

// ─── Invoice number generator ─────────────────────────────────────────────────

async function nextInvoiceNumber(orgId: number): Promise<string> {
  const [last] = await db
    .select({ invoiceNumber: vendorInvoicesTable.invoiceNumber })
    .from(vendorInvoicesTable)
    .where(eq(vendorInvoicesTable.organizationId, orgId))
    .orderBy(desc(vendorInvoicesTable.createdAt))
    .limit(1);
  const n = last ? parseInt(last.invoiceNumber.replace(/\D/g, "") || "0") + 1 : 1;
  return `VND-${String(orgId).padStart(3, "0")}-${String(n).padStart(4, "0")}`;
}

// ─── Billing calculation helper ───────────────────────────────────────────────

/**
 * Billing calculation for vendor operators.
 *
 * Revenue share base = grossSales only (POS transaction totals).
 * memberChargesTotal is tracked for reporting purposes but is NOT included in
 * the revenue-share base — it represents dues already collected by the club on
 * behalf of the vendor and settled separately, so adding it again would double-count.
 *
 * Billing models:
 *   fixed         — vendor pays a flat fixedFeeAmount per billing period
 *   revenue_share — vendor pays revenueSharePct % of grossSales
 *   hybrid        — flat fee + rev-share % on grossSales above revenueShareThreshold
 */
function calcBillingAmounts(
  grossSales: number,
  _memberChargesTotal: number, // retained as param for call-site compatibility; not used in formula
  billingModel: string,
  fixedFeeAmount: number,
  revenueSharePct: number,
  revenueShareThreshold: number | null,
): { revenueShareAmount: number; fixedFeeAmt: number; netAmountDue: number } {
  let revenueShareAmount = 0;
  let fixedFeeAmt = 0;
  // Revenue-share base is POS gross sales only — member charges are NOT added
  const revShareBase = grossSales;

  if (billingModel === "fixed") {
    fixedFeeAmt = fixedFeeAmount;
  } else if (billingModel === "revenue_share") {
    revenueShareAmount = (revShareBase * revenueSharePct) / 100;
  } else if (billingModel === "hybrid") {
    fixedFeeAmt = fixedFeeAmount;
    const threshold = revenueShareThreshold ?? 0;
    if (revShareBase > threshold) {
      revenueShareAmount = ((revShareBase - threshold) * revenueSharePct) / 100;
    }
  }

  const netAmountDue = fixedFeeAmt + revenueShareAmount;
  return { revenueShareAmount, fixedFeeAmt, netAmountDue };
}

// ─── Email helper ─────────────────────────────────────────────────────────────

async function sendVendorEmail(to: string | null | undefined, subject: string, html: string): Promise<void> {
  if (!to) return;
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) return;
  const transport = nodemailer.createTransport({ service: "gmail", auth: { user: gmailUser, pass: gmailPass } });
  await transport.sendMail({ from: `"KHARAGOLF" <${gmailUser}>`, to, subject, html });
}

// ─── PDF helper ───────────────────────────────────────────────────────────────

async function generateSettlementPDF(report: {
  organizationName?: string | null;
  vendor: { name: string; contactEmail: string | null };
  cycle: { periodStart: Date; periodEnd: Date };
  billing: { billingModel: string; fixedFeeAmount: number; revenueShareAmount: number; netAmountDue: number; currency: string };
  posSales: { count: number; total: number };
  memberCharges: { count: number; total: number };
  invoice?: { invoiceNumber: string; status: string } | null;
}): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fmt = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
    const fmtCur = (v: number) => `INR ${v.toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;

    // Header
    doc.rect(0, 0, doc.page.width, 70).fill("#0f2318");
    doc.fillColor("#ffffff").fontSize(18).font("Helvetica-Bold").text("KHARAGOLF ENTERPRISE", 50, 16);
    doc.fillColor("#C9A84C").fontSize(9).font("Helvetica").text("VENDOR SETTLEMENT REPORT", 50, 42);
    doc.fillColor("#9ca3af").fontSize(9).text(report.organizationName ?? "", doc.page.width - 200, 28, { width: 150, align: "right" });

    doc.moveDown(3);
    doc.fillColor("#111827").fontSize(15).font("Helvetica-Bold").text(`${report.vendor.name}`);
    doc.fillColor("#6b7280").fontSize(10).font("Helvetica").text(`Period: ${fmt(report.cycle.periodStart)} — ${fmt(report.cycle.periodEnd)}`);

    doc.moveDown(1);
    const boxTop = doc.y;
    doc.rect(50, boxTop, doc.page.width - 100, 150).lineWidth(1).stroke("#e5e7eb");
    const row = (label: string, value: string, y: number, bold = false) => {
      doc.fillColor("#6b7280").fontSize(10).font("Helvetica").text(label, 70, y);
      doc.fillColor(bold ? "#1e4d2b" : "#111827").fontSize(bold ? 13 : 11)
        .font(bold ? "Helvetica-Bold" : "Helvetica").text(value, 50, y, { align: "right", width: doc.page.width - 100 });
    };
    row("POS Transactions", `${fmtCur(report.posSales.total)} (${report.posSales.count} txns)`, boxTop + 15);
    row("Member Account Charges", `${fmtCur(report.memberCharges.total)} (${report.memberCharges.count} charges)`, boxTop + 40);
    row("Fixed Fee", fmtCur(report.billing.fixedFeeAmount), boxTop + 65);
    row("Revenue Share", fmtCur(report.billing.revenueShareAmount), boxTop + 90);
    row("Net Amount Due", fmtCur(report.billing.netAmountDue), boxTop + 120, true);

    if (report.invoice) {
      doc.moveDown(4);
      doc.fillColor("#111827").fontSize(11).font("Helvetica").text(`Invoice: ${report.invoice.invoiceNumber}  ·  Status: ${report.invoice.status}`);
    }

    doc.moveDown(2);
    doc.fillColor("#9ca3af").fontSize(8).text("Generated by KHARAGOLF Enterprise. This is an auto-generated settlement document.", { align: "center" });

    doc.end();
  });
}

// ─── Vendor Operators CRUD ────────────────────────────────────────────────────

/** GET /organizations/:orgId/vendor-operators */
router.get("/", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const vendors = await db
      .select()
      .from(vendorOperatorsTable)
      .where(eq(vendorOperatorsTable.organizationId, orgId))
      .orderBy(asc(vendorOperatorsTable.name));

    const contracts = await db
      .select()
      .from(vendorContractsTable)
      .where(and(eq(vendorContractsTable.organizationId, orgId)));

    const vendorsWithStatus = vendors.map((v) => {
      const activeContract = contracts.find(
        (c) => c.vendorOperatorId === v.id && c.status === "active",
      );
      return { ...v, activeContract: activeContract ?? null };
    });

    res.json(vendorsWithStatus);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vendor operators." });
  }
});

/** POST /organizations/:orgId/vendor-operators */
router.post("/", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    name, contactName, contactEmail, contactPhone,
    address, gstin, bankAccountName, bankAccountNumber, bankIfsc, notes,
  } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required." });
    return;
  }
  try {
    const [vendor] = await db.insert(vendorOperatorsTable).values({
      organizationId: orgId,
      name,
      contactName: contactName ?? null,
      contactEmail: contactEmail ?? null,
      contactPhone: contactPhone ?? null,
      address: address ?? null,
      gstin: gstin ?? null,
      bankAccountName: bankAccountName ?? null,
      bankAccountNumber: bankAccountNumber ?? null,
      bankIfsc: bankIfsc ?? null,
      notes: notes ?? null,
    }).returning();
    res.status(201).json(vendor);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create vendor operator." });
  }
});

// ─── Renewal Alerts (static routes — must be before /:vendorId) ───────────────

/** GET /renewal-alerts — contracts expiring within 90 days */
router.get("/renewal-alerts", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const now = new Date();
    const ninety = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const contracts = await db
      .select({
        contract: vendorContractsTable,
        vendorName: vendorOperatorsTable.name,
        vendorId: vendorOperatorsTable.id,
      })
      .from(vendorContractsTable)
      .innerJoin(vendorOperatorsTable, eq(vendorContractsTable.vendorOperatorId, vendorOperatorsTable.id))
      .where(and(
        eq(vendorContractsTable.organizationId, orgId),
        eq(vendorContractsTable.status, "active"),
        lte(vendorContractsTable.contractEndDate, ninety),
        gte(vendorContractsTable.contractEndDate, now),
      ))
      .orderBy(asc(vendorContractsTable.contractEndDate));

    const result = contracts.map((row) => {
      const endDate = row.contract.contractEndDate;
      const daysLeft = endDate
        ? Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      return {
        contractId: row.contract.id,
        vendorId: row.vendorId,
        vendorName: row.vendorName,
        contractEndDate: endDate,
        daysLeft,
        autoRenewal: row.contract.autoRenewal,
        alertLevel: daysLeft != null && daysLeft <= 30 ? "critical" : daysLeft != null && daysLeft <= 60 ? "warning" : "info",
      };
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch renewal alerts." });
  }
});

/** POST /renewal-alerts/dispatch — check and log 90/60/30-day alerts (cron-triggered) */
router.post("/renewal-alerts/dispatch", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const now = new Date();
    const milestones = [90, 60, 30];
    const dispatched: Array<{ contractId: number; vendorName: string; daysLeft: number; alertType: string }> = [];

    for (const days of milestones) {
      const windowStart = new Date(now.getTime() + (days - 1) * 24 * 60 * 60 * 1000);
      const windowEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

      const contracts = await db
        .select({
          contract: vendorContractsTable,
          vendorName: vendorOperatorsTable.name,
        })
        .from(vendorContractsTable)
        .innerJoin(vendorOperatorsTable, eq(vendorContractsTable.vendorOperatorId, vendorOperatorsTable.id))
        .where(and(
          eq(vendorContractsTable.organizationId, orgId),
          eq(vendorContractsTable.status, "active"),
          gte(vendorContractsTable.contractEndDate, windowStart),
          lte(vendorContractsTable.contractEndDate, windowEnd),
        ));

      for (const row of contracts) {
        const alertType = `expiry_${days}d`;

        const [existing] = await db
          .select({ id: vendorContractAlertsTable.id })
          .from(vendorContractAlertsTable)
          .where(and(
            eq(vendorContractAlertsTable.vendorContractId, row.contract.id),
            eq(vendorContractAlertsTable.alertType, alertType),
          ));

        if (!existing) {
          await db.insert(vendorContractAlertsTable).values({
            organizationId: orgId,
            vendorContractId: row.contract.id,
            alertType,
            daysBeforeExpiry: days,
          });

          // Send email notifications to org admins (not vendor contact)
          const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
          const endDateStr = row.contract.contractEndDate
            ? new Date(row.contract.contractEndDate).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })
            : "open-ended";
          const adminEmails = await getOrgAdminEmails(orgId);
          for (const adminEmail of adminEmails) {
            sendVendorEmail(
              adminEmail,
              `[KHARAGOLF] Vendor Contract "${row.vendorName}" Expires in ${days} Days`,
              `<p>Dear Club Admin,</p>
              <p>This is an automated reminder from <strong>${org?.name ?? "KHARAGOLF"}</strong>.</p>
              <p>The vendor contract for <strong>${row.vendorName}</strong> is due to expire on <strong>${endDateStr}</strong> (in approximately <strong>${days} days</strong>).</p>
              <p>Please log in to the KHARAGOLF Enterprise portal to review and take appropriate action (renew or terminate).</p>
              <p style="color:#9ca3af;font-size:12px">KHARAGOLF Enterprise — Automated Vendor Alert</p>`,
            ).catch(() => {});
          }

          dispatched.push({
            contractId: row.contract.id,
            vendorName: row.vendorName,
            daysLeft: days,
            alertType,
          });
        }
      }
    }

    res.json({ dispatched, message: `${dispatched.length} new alert(s) logged.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to dispatch renewal alerts." });
  }
});

// ─── Vendor Operators Detail / CRUD ───────────────────────────────────────────

/** GET /organizations/:orgId/vendor-operators/:vendorId */
router.get("/:vendorId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const [vendor] = await db
      .select()
      .from(vendorOperatorsTable)
      .where(and(eq(vendorOperatorsTable.id, vendorId), eq(vendorOperatorsTable.organizationId, orgId)));
    if (!vendor) {
      res.status(404).json({ error: "Vendor operator not found." });
      return;
    }

    const assignments = await db
      .select()
      .from(vendorFacilityAssignmentsTable)
      .where(eq(vendorFacilityAssignmentsTable.vendorOperatorId, vendorId))
      .orderBy(desc(vendorFacilityAssignmentsTable.assignedAt));

    const contracts = await db
      .select()
      .from(vendorContractsTable)
      .where(eq(vendorContractsTable.vendorOperatorId, vendorId))
      .orderBy(desc(vendorContractsTable.contractStartDate));

    res.json({ ...vendor, assignments, contracts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vendor operator." });
  }
});

/** PATCH /organizations/:orgId/vendor-operators/:vendorId */
router.patch("/:vendorId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    name, contactName, contactEmail, contactPhone,
    address, gstin, bankAccountName, bankAccountNumber, bankIfsc, notes, isActive,
  } = req.body;
  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name;
    if (contactName !== undefined) updates.contactName = contactName;
    if (contactEmail !== undefined) updates.contactEmail = contactEmail;
    if (contactPhone !== undefined) updates.contactPhone = contactPhone;
    if (address !== undefined) updates.address = address;
    if (gstin !== undefined) updates.gstin = gstin;
    if (bankAccountName !== undefined) updates.bankAccountName = bankAccountName;
    if (bankAccountNumber !== undefined) updates.bankAccountNumber = bankAccountNumber;
    if (bankIfsc !== undefined) updates.bankIfsc = bankIfsc;
    if (notes !== undefined) updates.notes = notes;
    if (isActive !== undefined) updates.isActive = isActive;

    const [updated] = await db
      .update(vendorOperatorsTable)
      .set(updates)
      .where(and(eq(vendorOperatorsTable.id, vendorId), eq(vendorOperatorsTable.organizationId, orgId)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Vendor operator not found." });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update vendor operator." });
  }
});

/** DELETE /organizations/:orgId/vendor-operators/:vendorId — deactivate */
router.delete("/:vendorId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const [updated] = await db
      .update(vendorOperatorsTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(vendorOperatorsTable.id, vendorId), eq(vendorOperatorsTable.organizationId, orgId)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Vendor operator not found." });
      return;
    }
    res.json({ message: "Vendor operator deactivated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to deactivate vendor operator." });
  }
});

// ─── Facility Assignments ──────────────────────────────────────────────────────

/** GET /:vendorId/assignments */
router.get("/:vendorId/assignments", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const rows = await db
      .select()
      .from(vendorFacilityAssignmentsTable)
      .where(and(
        eq(vendorFacilityAssignmentsTable.vendorOperatorId, vendorId),
        eq(vendorFacilityAssignmentsTable.organizationId, orgId),
      ))
      .orderBy(desc(vendorFacilityAssignmentsTable.assignedAt));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch assignments." });
  }
});

/** POST /:vendorId/assignments */
router.post("/:vendorId/assignments", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { facilityType, facilityName } = req.body;
  if (!facilityType || !["pro_shop", "f_and_b", "driving_range", "other"].includes(facilityType)) {
    res.status(400).json({ error: "facilityType must be one of pro_shop, f_and_b, driving_range, other." });
    return;
  }
  try {
    if (!await resolveVendorForOrg(res, vendorId, orgId)) return;
    // Enforce: only one active assignment per org+facilityType at a time
    const [conflict] = await db
      .select({ id: vendorFacilityAssignmentsTable.id })
      .from(vendorFacilityAssignmentsTable)
      .where(and(
        eq(vendorFacilityAssignmentsTable.organizationId, orgId),
        eq(vendorFacilityAssignmentsTable.facilityType, facilityType),
        eq(vendorFacilityAssignmentsTable.isActive, true),
      ))
      .limit(1);
    if (conflict) {
      res.status(409).json({ error: `An active assignment for facilityType '${facilityType}' already exists. Deactivate it before assigning a new vendor.` });
      return;
    }
    const [row] = await db.insert(vendorFacilityAssignmentsTable).values({
      organizationId: orgId,
      vendorOperatorId: vendorId,
      facilityType,
      facilityName: facilityName ?? null,
      isActive: true,
    }).returning();
    res.status(201).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create assignment." });
  }
});

/** PATCH /:vendorId/assignments/:assignmentId */
router.patch("/:vendorId/assignments/:assignmentId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const assignmentId = Number((req.params as Record<string, string>).assignmentId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { facilityType, facilityName, isActive } = req.body;
  try {
    const updates: Record<string, unknown> = {};
    if (facilityType !== undefined) updates.facilityType = facilityType;
    if (facilityName !== undefined) updates.facilityName = facilityName;
    if (isActive !== undefined) {
      updates.isActive = isActive;
      if (!isActive) updates.unassignedAt = new Date();
    }
    const [updated] = await db
      .update(vendorFacilityAssignmentsTable)
      .set(updates)
      .where(and(
        eq(vendorFacilityAssignmentsTable.id, assignmentId),
        eq(vendorFacilityAssignmentsTable.vendorOperatorId, vendorId),
        eq(vendorFacilityAssignmentsTable.organizationId, orgId),
      ))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Assignment not found." });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update assignment." });
  }
});

/** DELETE /:vendorId/assignments/:assignmentId — soft unassign */
router.delete("/:vendorId/assignments/:assignmentId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const assignmentId = Number((req.params as Record<string, string>).assignmentId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const [updated] = await db
      .update(vendorFacilityAssignmentsTable)
      .set({ isActive: false, unassignedAt: new Date() })
      .where(and(
        eq(vendorFacilityAssignmentsTable.id, assignmentId),
        eq(vendorFacilityAssignmentsTable.vendorOperatorId, vendorId),
        eq(vendorFacilityAssignmentsTable.organizationId, orgId),
      ))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Assignment not found." });
      return;
    }
    res.json({ message: "Vendor unassigned from facility." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to unassign vendor." });
  }
});

// ─── Staff / Role Scoping ─────────────────────────────────────────────────────

/**
 * GET /:vendorId/staff
 * List all org_membership rows that are scoped to this vendor (vendor staff).
 */
router.get("/:vendorId/staff", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const rows = await db
      .select({
        membershipId: orgMembershipsTable.id,
        userId: orgMembershipsTable.userId,
        role: orgMembershipsTable.role,
        vendorOperatorId: orgMembershipsTable.vendorOperatorId,
        joinedAt: orgMembershipsTable.joinedAt,
        displayName: appUsersTable.displayName,
        email: appUsersTable.email,
      })
      .from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
      .where(and(
        eq(orgMembershipsTable.organizationId, orgId),
        eq(orgMembershipsTable.vendorOperatorId, vendorId),
      ));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vendor staff." });
  }
});

/**
 * POST /:vendorId/staff
 * Assign an existing org member (pro_shop role) to this vendor scope.
 * Body: { userId: number }
 */
router.post("/:vendorId/staff", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }
  try {
    // Verify vendor belongs to org (cross-tenant guard)
    if (!await resolveVendorForOrg(res, vendorId, orgId)) return;

    // Ensure the user has a membership in this org, upsert vendor scope
    const [existing] = await db.select({ id: orgMembershipsTable.id, role: orgMembershipsTable.role })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)));
    if (!existing) {
      res.status(404).json({ error: "User is not a member of this organization." });
      return;
    }
    const [updated] = await db
      .update(orgMembershipsTable)
      .set({ vendorOperatorId: vendorId, role: "pro_shop" })
      .where(and(eq(orgMembershipsTable.userId, userId), eq(orgMembershipsTable.organizationId, orgId)))
      .returning();
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to assign staff to vendor." });
  }
});

/**
 * DELETE /:vendorId/staff/:userId
 * Remove vendor scope from an org member (clears vendorOperatorId).
 */
router.delete("/:vendorId/staff/:userId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const userId = Number((req.params as Record<string, string>).userId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const [updated] = await db
      .update(orgMembershipsTable)
      .set({ vendorOperatorId: null })
      .where(and(
        eq(orgMembershipsTable.userId, userId),
        eq(orgMembershipsTable.organizationId, orgId),
        eq(orgMembershipsTable.vendorOperatorId, vendorId),
      ))
      .returning();
    if (!updated) { { res.status(404).json({ error: "Staff assignment not found." }); return; } }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to remove staff from vendor." });
  }
});

// ─── Contracts ────────────────────────────────────────────────────────────────

/** GET /:vendorId/contracts */
router.get("/:vendorId/contracts", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const rows = await db
      .select()
      .from(vendorContractsTable)
      .where(and(
        eq(vendorContractsTable.vendorOperatorId, vendorId),
        eq(vendorContractsTable.organizationId, orgId),
      ))
      .orderBy(desc(vendorContractsTable.contractStartDate));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch contracts." });
  }
});

/** POST /:vendorId/contracts */
router.post("/:vendorId/contracts", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    billingModel, fixedFeeAmount, revenueSharePct, revenueShareThreshold,
    billingFrequency, contractStartDate, contractEndDate,
    noticePeriodDays, autoRenewal, notes, previousContractId,
  } = req.body;

  if (!billingModel || !["fixed", "revenue_share", "hybrid"].includes(billingModel)) {
    res.status(400).json({ error: "billingModel must be fixed, revenue_share, or hybrid." });
    return;
  }
  if (!contractStartDate) {
    res.status(400).json({ error: "contractStartDate is required." });
    return;
  }
  try {
    if (!await resolveVendorForOrg(res, vendorId, orgId)) return;
    // Enforce: only one active contract per vendor at a time
    const [activeConflict] = await db
      .select({ id: vendorContractsTable.id })
      .from(vendorContractsTable)
      .where(and(
        eq(vendorContractsTable.vendorOperatorId, vendorId),
        eq(vendorContractsTable.organizationId, orgId),
        eq(vendorContractsTable.status, "active"),
      ))
      .limit(1);
    if (activeConflict) {
      res.status(409).json({ error: "This vendor already has an active contract. Terminate or renew the existing contract first." });
      return;
    }
    const [contract] = await db.insert(vendorContractsTable).values({
      organizationId: orgId,
      vendorOperatorId: vendorId,
      previousContractId: previousContractId ?? null,
      billingModel,
      fixedFeeAmount: String(fixedFeeAmount ?? 0),
      revenueSharePct: String(revenueSharePct ?? 0),
      revenueShareThreshold: revenueShareThreshold != null ? String(revenueShareThreshold) : null,
      billingFrequency: billingFrequency ?? "monthly",
      contractStartDate: new Date(contractStartDate),
      contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
      noticePeriodDays: noticePeriodDays ?? 30,
      autoRenewal: autoRenewal ?? false,
      status: "active",
      notes: notes ?? null,
    }).returning();
    res.status(201).json(contract);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create contract." });
  }
});

/** PATCH /:vendorId/contracts/:contractId */
router.patch("/:vendorId/contracts/:contractId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const contractId = Number((req.params as Record<string, string>).contractId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    billingModel, fixedFeeAmount, revenueSharePct, revenueShareThreshold,
    billingFrequency, contractStartDate, contractEndDate,
    noticePeriodDays, autoRenewal, notes, status,
  } = req.body;
  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (billingModel !== undefined) updates.billingModel = billingModel;
    if (fixedFeeAmount !== undefined) updates.fixedFeeAmount = String(fixedFeeAmount);
    if (revenueSharePct !== undefined) updates.revenueSharePct = String(revenueSharePct);
    if (revenueShareThreshold !== undefined) updates.revenueShareThreshold = revenueShareThreshold != null ? String(revenueShareThreshold) : null;
    if (billingFrequency !== undefined) updates.billingFrequency = billingFrequency;
    if (contractStartDate !== undefined) updates.contractStartDate = new Date(contractStartDate);
    if (contractEndDate !== undefined) updates.contractEndDate = contractEndDate ? new Date(contractEndDate) : null;
    if (noticePeriodDays !== undefined) updates.noticePeriodDays = noticePeriodDays;
    if (autoRenewal !== undefined) updates.autoRenewal = autoRenewal;
    if (notes !== undefined) updates.notes = notes;
    if (status !== undefined) updates.status = status;

    const [updated] = await db
      .update(vendorContractsTable)
      .set(updates)
      .where(and(
        eq(vendorContractsTable.id, contractId),
        eq(vendorContractsTable.vendorOperatorId, vendorId),
        eq(vendorContractsTable.organizationId, orgId),
      ))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Contract not found." });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update contract." });
  }
});

/** POST /:vendorId/contracts/:contractId/terminate */
router.post("/:vendorId/contracts/:contractId/terminate", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const contractId = Number((req.params as Record<string, string>).contractId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { terminationReason } = req.body;
  try {
    const [updated] = await db
      .update(vendorContractsTable)
      .set({
        status: "terminated",
        terminationReason: terminationReason ?? null,
        terminatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(vendorContractsTable.id, contractId),
        eq(vendorContractsTable.vendorOperatorId, vendorId),
        eq(vendorContractsTable.organizationId, orgId),
      ))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Contract not found." });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to terminate contract." });
  }
});

/** POST /:vendorId/contracts/:contractId/renew — creates a new contract linked to the old one */
router.post("/:vendorId/contracts/:contractId/renew", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const contractId = Number((req.params as Record<string, string>).contractId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    billingModel, fixedFeeAmount, revenueSharePct, revenueShareThreshold,
    billingFrequency, contractStartDate, contractEndDate,
    noticePeriodDays, autoRenewal, notes,
  } = req.body;

  try {
    const [prev] = await db
      .select()
      .from(vendorContractsTable)
      .where(and(
        eq(vendorContractsTable.id, contractId),
        eq(vendorContractsTable.vendorOperatorId, vendorId),
        eq(vendorContractsTable.organizationId, orgId),
      ));

    if (!prev) {
      res.status(404).json({ error: "Contract not found." });
      return;
    }

    await db.update(vendorContractsTable)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(vendorContractsTable.id, contractId));

    const [renewed] = await db.insert(vendorContractsTable).values({
      organizationId: orgId,
      vendorOperatorId: vendorId,
      previousContractId: contractId,
      billingModel: billingModel ?? prev.billingModel,
      fixedFeeAmount: String(fixedFeeAmount ?? prev.fixedFeeAmount),
      revenueSharePct: String(revenueSharePct ?? prev.revenueSharePct),
      revenueShareThreshold: revenueShareThreshold != null
        ? String(revenueShareThreshold)
        : prev.revenueShareThreshold,
      billingFrequency: billingFrequency ?? prev.billingFrequency,
      contractStartDate: contractStartDate ? new Date(contractStartDate) : new Date(),
      contractEndDate: contractEndDate ? new Date(contractEndDate) : null,
      noticePeriodDays: noticePeriodDays ?? prev.noticePeriodDays,
      autoRenewal: autoRenewal ?? prev.autoRenewal,
      status: "active",
      notes: notes ?? prev.notes,
    }).returning();

    res.status(201).json(renewed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to renew contract." });
  }
});

// ─── Billing Cycles ────────────────────────────────────────────────────────────

/** GET /:vendorId/billing-cycles */
router.get("/:vendorId/billing-cycles", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const rows = await db
      .select()
      .from(vendorBillingCyclesTable)
      .where(and(
        eq(vendorBillingCyclesTable.vendorOperatorId, vendorId),
        eq(vendorBillingCyclesTable.organizationId, orgId),
      ))
      .orderBy(desc(vendorBillingCyclesTable.periodStart));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch billing cycles." });
  }
});

/** POST /:vendorId/billing-cycles — generate a billing cycle for a period */
router.post("/:vendorId/billing-cycles", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { contractId, periodStart, periodEnd } = req.body;

  if (!contractId || !periodStart || !periodEnd) {
    res.status(400).json({ error: "contractId, periodStart, and periodEnd are required." });
    return;
  }

  try {
    const [contract] = await db
      .select()
      .from(vendorContractsTable)
      .where(and(
        eq(vendorContractsTable.id, Number(contractId)),
        eq(vendorContractsTable.vendorOperatorId, vendorId),
        eq(vendorContractsTable.organizationId, orgId),
      ));

    if (!contract) {
      res.status(404).json({ error: "Contract not found." });
      return;
    }

    const start = new Date(periodStart);
    const end = new Date(periodEnd);

    const grossSalesRows = await db
      .select({ total: sum(posTransactionsTable.totalAmount) })
      .from(posTransactionsTable)
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.vendorOperatorId, vendorId),
        gte(posTransactionsTable.transactedAt, start),
        lte(posTransactionsTable.transactedAt, end),
        eq(posTransactionsTable.status, "completed"),
      ));

    const memberChargesRows = await db
      .select({ total: sum(memberAccountChargesTable.amount) })
      .from(memberAccountChargesTable)
      .where(and(
        eq(memberAccountChargesTable.organizationId, orgId),
        eq(memberAccountChargesTable.vendorOperatorId, vendorId),
        gte(memberAccountChargesTable.createdAt, start),
        lte(memberAccountChargesTable.createdAt, end),
      ));

    const grossSales = parseFloat(String(grossSalesRows[0]?.total ?? "0")) || 0;
    const memberChargesTotal = parseFloat(String(memberChargesRows[0]?.total ?? "0")) || 0;

    const { revenueShareAmount, fixedFeeAmt, netAmountDue } = calcBillingAmounts(
      grossSales,
      memberChargesTotal,
      contract.billingModel,
      parseFloat(String(contract.fixedFeeAmount)),
      parseFloat(String(contract.revenueSharePct)),
      contract.revenueShareThreshold != null ? parseFloat(String(contract.revenueShareThreshold)) : null,
    );

    const [cycle] = await db.insert(vendorBillingCyclesTable).values({
      organizationId: orgId,
      vendorOperatorId: vendorId,
      vendorContractId: contract.id,
      periodStart: start,
      periodEnd: end,
      grossSales: String(grossSales),
      memberChargesTotal: String(memberChargesTotal),
      revenueShareAmount: String(revenueShareAmount),
      fixedFeeAmount: String(fixedFeeAmt),
      netAmountDue: String(netAmountDue),
    }).returning();

    // Auto-create a draft invoice for this billing cycle
    let autoInvoice: (typeof vendorInvoicesTable.$inferSelect) | null = null;
    try {
      const invoiceNumber = await nextInvoiceNumber(orgId);
      const [inv] = await db.insert(vendorInvoicesTable).values({
        organizationId: orgId,
        vendorOperatorId: vendorId,
        vendorBillingCycleId: cycle.id,
        invoiceNumber,
        totalAmount: String(netAmountDue),
        notes: `Auto-generated for billing cycle ${cycle.id} (${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)})`,
      }).returning();
      autoInvoice = inv;
    } catch (invoiceErr) {
      console.error("Auto-invoice creation failed (non-fatal):", invoiceErr);
    }

    res.status(201).json({ ...cycle, autoInvoice });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate billing cycle." });
  }
});

// ─── Settlement Report ─────────────────────────────────────────────────────────

/** GET /:vendorId/billing-cycles/:cycleId/settlement */
router.get("/:vendorId/billing-cycles/:cycleId/settlement", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const cycleId = Number((req.params as Record<string, string>).cycleId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const [cycle] = await db
      .select()
      .from(vendorBillingCyclesTable)
      .where(and(
        eq(vendorBillingCyclesTable.id, cycleId),
        eq(vendorBillingCyclesTable.vendorOperatorId, vendorId),
        eq(vendorBillingCyclesTable.organizationId, orgId),
      ));
    if (!cycle) {
      res.status(404).json({ error: "Billing cycle not found." });
      return;
    }

    const [vendor] = await db.select().from(vendorOperatorsTable).where(eq(vendorOperatorsTable.id, vendorId));
    const [contract] = await db.select().from(vendorContractsTable).where(eq(vendorContractsTable.id, cycle.vendorContractId));
    const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

    const posTxns = await db
      .select({
        id: posTransactionsTable.id,
        receiptNumber: posTransactionsTable.receiptNumber,
        totalAmount: posTransactionsTable.totalAmount,
        paymentMethod: posTransactionsTable.paymentMethod,
        transactedAt: posTransactionsTable.transactedAt,
        customerName: posTransactionsTable.customerName,
        memberName: posTransactionsTable.memberName,
      })
      .from(posTransactionsTable)
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.vendorOperatorId, vendorId),
        gte(posTransactionsTable.transactedAt, cycle.periodStart),
        lte(posTransactionsTable.transactedAt, cycle.periodEnd),
        eq(posTransactionsTable.status, "completed"),
      ))
      .orderBy(asc(posTransactionsTable.transactedAt));

    const memberCharges = await db
      .select({
        id: memberAccountChargesTable.id,
        amount: memberAccountChargesTable.amount,
        description: memberAccountChargesTable.description,
        isSettled: memberAccountChargesTable.isSettled,
        createdAt: memberAccountChargesTable.createdAt,
      })
      .from(memberAccountChargesTable)
      .where(and(
        eq(memberAccountChargesTable.organizationId, orgId),
        eq(memberAccountChargesTable.vendorOperatorId, vendorId),
        gte(memberAccountChargesTable.createdAt, cycle.periodStart),
        lte(memberAccountChargesTable.createdAt, cycle.periodEnd),
      ))
      .orderBy(asc(memberAccountChargesTable.createdAt));

    const [linkedInvoice] = await db
      .select()
      .from(vendorInvoicesTable)
      .where(eq(vendorInvoicesTable.vendorBillingCycleId, cycleId));

    // Gross sales breakdown by category
    const txnIds = posTxns.map(t => t.id);
    let salesByCategory: Array<{ category: string | null; total: number; count: number }> = [];
    if (txnIds.length > 0) {
      const itemRows = await db
        .select({
          category: posTransactionItemsTable.category,
          lineTotal: posTransactionItemsTable.lineTotal,
        })
        .from(posTransactionItemsTable)
        .where(inArray(posTransactionItemsTable.transactionId, txnIds));

      const catMap = new Map<string, { total: number; count: number }>();
      for (const item of itemRows) {
        const cat = item.category ?? "Uncategorized";
        const cur = catMap.get(cat) ?? { total: 0, count: 0 };
        catMap.set(cat, { total: cur.total + parseFloat(String(item.lineTotal)), count: cur.count + 1 });
      }
      salesByCategory = Array.from(catMap.entries()).map(([category, data]) => ({ category, ...data }))
        .sort((a, b) => b.total - a.total);
    }

    // Outstanding balance from previous unsettled invoices for this vendor
    const previousInvoices = await db
      .select({ id: vendorInvoicesTable.id, totalAmount: vendorInvoicesTable.totalAmount, invoiceNumber: vendorInvoicesTable.invoiceNumber, dueDate: vendorInvoicesTable.dueDate })
      .from(vendorInvoicesTable)
      .where(and(
        eq(vendorInvoicesTable.vendorOperatorId, vendorId),
        eq(vendorInvoicesTable.organizationId, orgId),
        eq(vendorInvoicesTable.status, "unpaid"),
      ));
    const outstandingBalance = previousInvoices
      .filter(inv => !linkedInvoice || inv.id !== linkedInvoice.id)
      .reduce((acc, inv) => acc + parseFloat(String(inv.totalAmount)), 0);

    res.json({
      cycle,
      vendor,
      contract,
      organizationName: org?.name,
      posSales: {
        transactions: posTxns,
        count: posTxns.length,
        total: parseFloat(String(cycle.grossSales)),
        byCategory: salesByCategory,
      },
      memberCharges: {
        items: memberCharges,
        count: memberCharges.length,
        total: parseFloat(String(cycle.memberChargesTotal)),
      },
      billing: {
        billingModel: contract?.billingModel,
        fixedFeeAmount: parseFloat(String(cycle.fixedFeeAmount)),
        revenueShareAmount: parseFloat(String(cycle.revenueShareAmount)),
        netAmountDue: parseFloat(String(cycle.netAmountDue)),
        currency: cycle.currency,
        outstandingBalance,
        totalWithOutstanding: parseFloat(String(cycle.netAmountDue)) + outstandingBalance,
      },
      invoice: linkedInvoice ?? null,
      priorOutstandingInvoices: previousInvoices.filter(inv => !linkedInvoice || inv.id !== linkedInvoice.id),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate settlement report." });
  }
});

/** GET /:vendorId/billing-cycles/:cycleId/settlement/pdf — download settlement report as PDF */
router.get("/:vendorId/billing-cycles/:cycleId/settlement/pdf", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const cycleId = Number((req.params as Record<string, string>).cycleId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const [cycle] = await db.select().from(vendorBillingCyclesTable).where(and(
      eq(vendorBillingCyclesTable.id, cycleId),
      eq(vendorBillingCyclesTable.vendorOperatorId, vendorId),
      eq(vendorBillingCyclesTable.organizationId, orgId),
    ));
    if (!cycle) { { res.status(404).json({ error: "Billing cycle not found." }); return; } }

    const [vendor] = await db.select().from(vendorOperatorsTable).where(eq(vendorOperatorsTable.id, vendorId));
    const [contract] = await db.select().from(vendorContractsTable).where(eq(vendorContractsTable.id, cycle.vendorContractId));
    const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

    // Fetch actual transaction counts for the PDF (completed POS txns only)
    const posTxns = await db.select({ id: posTransactionsTable.id })
      .from(posTransactionsTable)
      .where(and(
        eq(posTransactionsTable.organizationId, orgId),
        eq(posTransactionsTable.vendorOperatorId, vendorId),
        gte(posTransactionsTable.transactedAt, cycle.periodStart),
        lte(posTransactionsTable.transactedAt, cycle.periodEnd),
        eq(posTransactionsTable.status, "completed"),
      ));
    const memberCharges = await db.select({ id: memberAccountChargesTable.id })
      .from(memberAccountChargesTable)
      .where(and(
        eq(memberAccountChargesTable.organizationId, orgId),
        eq(memberAccountChargesTable.vendorOperatorId, vendorId),
        gte(memberAccountChargesTable.createdAt, cycle.periodStart),
        lte(memberAccountChargesTable.createdAt, cycle.periodEnd),
      ));

    const [linkedInvoice] = await db.select().from(vendorInvoicesTable).where(eq(vendorInvoicesTable.vendorBillingCycleId, cycleId));

    const pdfBuffer = await generateSettlementPDF({
      organizationName: org?.name,
      vendor: { name: vendor?.name ?? "Unknown Vendor", contactEmail: vendor?.contactEmail ?? null },
      cycle: { periodStart: cycle.periodStart, periodEnd: cycle.periodEnd },
      billing: {
        billingModel: contract?.billingModel ?? "fixed",
        fixedFeeAmount: parseFloat(String(cycle.fixedFeeAmount)),
        revenueShareAmount: parseFloat(String(cycle.revenueShareAmount)),
        netAmountDue: parseFloat(String(cycle.netAmountDue)),
        currency: cycle.currency,
      },
      posSales: { count: posTxns.length, total: parseFloat(String(cycle.grossSales)) },
      memberCharges: { count: memberCharges.length, total: parseFloat(String(cycle.memberChargesTotal)) },
      invoice: linkedInvoice ? { invoiceNumber: linkedInvoice.invoiceNumber, status: linkedInvoice.status } : null,
    });

    const filename = `settlement-${vendorId}-cycle-${cycleId}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.end(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate settlement PDF." });
  }
});

// ─── Invoices ─────────────────────────────────────────────────────────────────

/** GET /:vendorId/invoices */
router.get("/:vendorId/invoices", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const rows = await db
      .select()
      .from(vendorInvoicesTable)
      .where(and(
        eq(vendorInvoicesTable.vendorOperatorId, vendorId),
        eq(vendorInvoicesTable.organizationId, orgId),
      ))
      .orderBy(desc(vendorInvoicesTable.createdAt));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoices." });
  }
});

/** GET /:vendorId/invoices/:invoiceId */
router.get("/:vendorId/invoices/:invoiceId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const invoiceId = Number((req.params as Record<string, string>).invoiceId);
  if (!await requireVendorStaffOrOrgAdmin(req, res, orgId, vendorId)) return;
  try {
    const [row] = await db
      .select()
      .from(vendorInvoicesTable)
      .where(and(
        eq(vendorInvoicesTable.id, invoiceId),
        eq(vendorInvoicesTable.vendorOperatorId, vendorId),
        eq(vendorInvoicesTable.organizationId, orgId),
      ));
    if (!row) {
      res.status(404).json({ error: "Invoice not found." });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch invoice." });
  }
});

/** POST /:vendorId/invoices — create invoice */
router.post("/:vendorId/invoices", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    vendorBillingCycleId, totalAmount, dueDate, notes, lineItems, createPaymentLink,
  } = req.body;

  if (totalAmount == null) {
    res.status(400).json({ error: "totalAmount is required." });
    return;
  }

  try {
    if (!await resolveVendorForOrg(res, vendorId, orgId)) return;
    const invoiceNumber = await nextInvoiceNumber(orgId);

    let razorpayPaymentLinkId: string | undefined;
    let razorpayPaymentLinkUrl: string | undefined;

    if (createPaymentLink) {
      try {
        const [vendor] = await db
          .select({ name: vendorOperatorsTable.name, contactEmail: vendorOperatorsTable.contactEmail, contactPhone: vendorOperatorsTable.contactPhone })
          .from(vendorOperatorsTable)
          .where(eq(vendorOperatorsTable.id, vendorId));
        const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

        const rz = getRazorpayClient();
        const link = await rz.paymentLink.create({
          amount: Math.round(parseFloat(String(totalAmount)) * 100),
          currency: "INR",
          description: `Vendor invoice ${invoiceNumber} — ${org?.name ?? ""}`,
          customer: {
            name: vendor?.name,
            email: vendor?.contactEmail ?? undefined,
            contact: vendor?.contactPhone ?? undefined,
          },
          notify: { email: !!(vendor?.contactEmail), sms: false },
          reference_id: invoiceNumber,
          notes: { orgId: String(orgId), vendorId: String(vendorId), invoiceNumber },
        });
        razorpayPaymentLinkId = link.id;
        razorpayPaymentLinkUrl = link.short_url;
      } catch (_e) {
      }
    }

    const [invoice] = await db.insert(vendorInvoicesTable).values({
      organizationId: orgId,
      vendorOperatorId: vendorId,
      vendorBillingCycleId: vendorBillingCycleId ? Number(vendorBillingCycleId) : null,
      invoiceNumber,
      totalAmount: String(totalAmount),
      dueDate: dueDate ? new Date(dueDate) : null,
      notes: notes ?? null,
      lineItems: lineItems ?? null,
      razorpayPaymentLinkId,
      razorpayPaymentLinkUrl,
      sentAt: createPaymentLink ? new Date() : null,
    }).returning();

    res.status(201).json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create invoice." });
  }
});

/** PATCH /:vendorId/invoices/:invoiceId — mark paid, update status, etc. */
router.patch("/:vendorId/invoices/:invoiceId", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const invoiceId = Number((req.params as Record<string, string>).invoiceId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const {
    status, paidAt, paymentMethod, paymentReference, notes, dueDate,
  } = req.body;
  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status !== undefined) updates.status = status;
    if (paidAt !== undefined) updates.paidAt = paidAt ? new Date(paidAt) : null;
    if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
    if (paymentReference !== undefined) updates.paymentReference = paymentReference;
    if (notes !== undefined) updates.notes = notes;
    if (dueDate !== undefined) updates.dueDate = dueDate ? new Date(dueDate) : null;

    if (status === "paid" && !paidAt) updates.paidAt = new Date();

    const [updated] = await db
      .update(vendorInvoicesTable)
      .set(updates)
      .where(and(
        eq(vendorInvoicesTable.id, invoiceId),
        eq(vendorInvoicesTable.vendorOperatorId, vendorId),
        eq(vendorInvoicesTable.organizationId, orgId),
      ))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Invoice not found." });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update invoice." });
  }
});

/** POST /:vendorId/invoices/:invoiceId/payment-link — send/regenerate Razorpay payment link */
router.post("/:vendorId/invoices/:invoiceId/payment-link", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  const vendorId = Number((req.params as Record<string, string>).vendorId);
  const invoiceId = Number((req.params as Record<string, string>).invoiceId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const [invoice] = await db
      .select()
      .from(vendorInvoicesTable)
      .where(and(
        eq(vendorInvoicesTable.id, invoiceId),
        eq(vendorInvoicesTable.vendorOperatorId, vendorId),
        eq(vendorInvoicesTable.organizationId, orgId),
      ));
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found." });
      return;
    }

    const [vendor] = await db
      .select({ name: vendorOperatorsTable.name, contactEmail: vendorOperatorsTable.contactEmail, contactPhone: vendorOperatorsTable.contactPhone })
      .from(vendorOperatorsTable)
      .where(eq(vendorOperatorsTable.id, vendorId));
    const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

    const rz = getRazorpayClient();
    const link = await rz.paymentLink.create({
      amount: Math.round(parseFloat(String(invoice.totalAmount)) * 100),
      currency: invoice.currency.toUpperCase(),
      description: `Vendor invoice ${invoice.invoiceNumber} — ${org?.name ?? ""}`,
      customer: {
        name: vendor?.name,
        email: vendor?.contactEmail ?? undefined,
        contact: vendor?.contactPhone ?? undefined,
      },
      notify: { email: !!(vendor?.contactEmail), sms: false },
      reference_id: invoice.invoiceNumber,
      notes: { orgId: String(orgId), vendorId: String(vendorId), invoiceNumber: invoice.invoiceNumber },
    });

    const [updated] = await db
      .update(vendorInvoicesTable)
      .set({
        razorpayPaymentLinkId: link.id,
        razorpayPaymentLinkUrl: link.short_url,
        sentAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(vendorInvoicesTable.id, invoiceId))
      .returning();

    res.json({ paymentLinkUrl: link.short_url, invoice: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create payment link." });
  }
});

export default router;
