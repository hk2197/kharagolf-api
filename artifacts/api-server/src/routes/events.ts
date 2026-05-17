/**
 * Event & Banquet / Function Management API — Task #109
 * Base: /organizations/:orgId/events
 *
 * Function Spaces (admin)
 * GET    /spaces                          List all function spaces
 * POST   /spaces                         Create a function space
 * PATCH  /spaces/:spaceId                Update a function space
 * DELETE /spaces/:spaceId                Delete (deactivate) a space
 * GET    /spaces/:spaceId/availability   Check availability for a date range
 *
 * Catering Packages (admin)
 * GET    /catering-packages              List catering packages
 * POST   /catering-packages              Create catering package
 * PATCH  /catering-packages/:pkgId       Update catering package
 * DELETE /catering-packages/:pkgId       Delete catering package
 *
 * Event Bookings / Enquiry Pipeline (admin)
 * GET    /bookings                       List bookings (filterable by status, date)
 * POST   /bookings                       Create booking (admin) or handle public enquiry
 * GET    /bookings/:bookingId            Get booking detail
 * PATCH  /bookings/:bookingId            Update booking details
 * PATCH  /bookings/:bookingId/status     Move booking through pipeline
 * DELETE /bookings/:bookingId            Cancel/delete booking
 *
 * Calendar
 * GET    /calendar                       Month/week overview of all bookings
 *
 * Invoices
 * GET    /bookings/:bookingId/invoice    Get invoice for a booking
 * POST   /bookings/:bookingId/invoice    Generate invoice
 * PATCH  /bookings/:bookingId/invoice    Update invoice (line items, tax, notes)
 * POST   /bookings/:bookingId/invoice/send  Email invoice to organiser
 * PATCH  /bookings/:bookingId/invoice/mark-paid  Mark invoice as paid
 *
 * Public enquiry (no auth)
 * POST   /public/events/enquiry          Submit public enquiry
 * GET    /public/events/spaces           List available spaces (public)
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  functionSpacesTable,
  eventCateringPackagesTable,
  eventBookingsTable,
  eventInvoicesTable,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
} from "@workspace/db";
import { eq, and, desc, asc, gte, lte, ne, sql, inArray, or, isNull, ilike } from "drizzle-orm";
import { sendEventEnquiryAck, sendEventQuote, sendEventConfirmation, sendEventInvoice, sendEventReminder } from "../lib/mailer";
import { resolveOrgBranding } from "../lib/clubTheming";

const router: IRouter = Router({ mergeParams: true });

interface SessionUser { id: number; role?: string; organizationId?: number | null; displayName?: string; email?: string }

function getUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
}

function parseOrgId(req: Request): number {
  return parseInt(String((req.params as Record<string, string>).orgId));
}

async function requireOrgAdminFn(req: Request, res: Response, orgId: number): Promise<boolean> {
  const user = getUser(req);
  if (!user) { res.status(401).json({ error: "Authentication required" }); return false; }
  if (user.role === "super_admin") return true;
  if (
    (user.role === "org_admin" || user.role === "tournament_director") &&
    Number(user.organizationId) === orgId
  ) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id })
    .from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "tournament_director"]),
    ));
  if (!m) { res.status(403).json({ error: "Organization admin access required" }); return false; }
  return true;
}

async function getOrgBranding(orgId: number) {
  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    contactEmail: organizationsTable.contactEmail,
  }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) return null;
  // Task #1758 — when the org has saved a custom theme via the
  // club-theming UI, use that logo / primary colour for transactional
  // event emails (quote, confirmation, invoice, reminder). Falls back to
  // the legacy `organizations.*` columns when no theme row exists.
  const branded = await resolveOrgBranding(orgId, org);
  return {
    name: org.name,
    logoUrl: branded.logoUrl ?? null,
    primaryColor: branded.primaryColor ?? null,
    contactEmail: org.contactEmail,
  };
}

function generateInvoiceNumber(orgId: number): string {
  const date = new Date();
  const yy = String(date.getFullYear()).slice(2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `EVT-${orgId}-${yy}${mm}-${rand}`;
}

// ─── FUNCTION SPACES ──────────────────────────────────────────────────────────

router.get("/spaces", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const { activeOnly } = req.query;
  const conditions = [eq(functionSpacesTable.organizationId, orgId)];
  if (activeOnly === "true") conditions.push(eq(functionSpacesTable.isActive, true));

  const spaces = await db.select().from(functionSpacesTable)
    .where(and(...conditions))
    .orderBy(asc(functionSpacesTable.sortOrder), asc(functionSpacesTable.name));

  res.json({ spaces });
});

router.post("/spaces", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const {
    name, description, capacitySeated, capacityStanding,
    facilities, avEquipment, basePricePerDay, currency,
    photoUrls, sortOrder,
  } = req.body;

  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [space] = await db.insert(functionSpacesTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    capacitySeated: capacitySeated ? parseInt(capacitySeated) : null,
    capacityStanding: capacityStanding ? parseInt(capacityStanding) : null,
    facilities: facilities ?? [],
    avEquipment: avEquipment ?? [],
    basePricePerDay: basePricePerDay ? String(basePricePerDay) : null,
    currency: currency ?? "INR",
    photoUrls: photoUrls ?? [],
    sortOrder: sortOrder ? parseInt(sortOrder) : 0,
  }).returning();

  res.status(201).json({ space });
});

router.patch("/spaces/:spaceId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const spaceId = parseInt(String((req.params as Record<string, string>).spaceId));
  const [existing] = await db.select({ id: functionSpacesTable.id }).from(functionSpacesTable)
    .where(and(eq(functionSpacesTable.id, spaceId), eq(functionSpacesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Space not found" }); return; } }

  const allowed = ["name","description","capacitySeated","capacityStanding","facilities","avEquipment","basePricePerDay","currency","photoUrls","isActive","sortOrder"] as const;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const [space] = await db.update(functionSpacesTable).set(updates).where(eq(functionSpacesTable.id, spaceId)).returning();
  res.json({ space });
});

router.delete("/spaces/:spaceId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const spaceId = parseInt(String((req.params as Record<string, string>).spaceId));
  await db.update(functionSpacesTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(functionSpacesTable.id, spaceId), eq(functionSpacesTable.organizationId, orgId)));
  res.json({ ok: true });
});

router.get("/spaces/:spaceId/availability", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const spaceId = parseInt(String((req.params as Record<string, string>).spaceId));
  const { from, to } = req.query;

  if (!from || !to) { { res.status(400).json({ error: "from and to dates are required" }); return; } }

  const fromDate = new Date(String(from));
  const toDate = new Date(String(to));

  const bookings = await db.select({
    id: eventBookingsTable.id,
    eventName: eventBookingsTable.eventName,
    eventDate: eventBookingsTable.eventDate,
    status: eventBookingsTable.status,
    organiserName: eventBookingsTable.organiserName,
  }).from(eventBookingsTable)
    .where(and(
      eq(eventBookingsTable.functionSpaceId, spaceId),
      gte(eventBookingsTable.eventDate, fromDate),
      lte(eventBookingsTable.eventDate, toDate),
      ne(eventBookingsTable.status, "cancelled"),
    ))
    .orderBy(asc(eventBookingsTable.eventDate));

  res.json({ bookings, available: bookings.length === 0 });
});

// ─── CATERING PACKAGES ────────────────────────────────────────────────────────

router.get("/catering-packages", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const { activeOnly } = req.query;
  const conditions = [eq(eventCateringPackagesTable.organizationId, orgId)];
  if (activeOnly === "true") conditions.push(eq(eventCateringPackagesTable.isActive, true));

  const packages = await db.select().from(eventCateringPackagesTable)
    .where(and(...conditions))
    .orderBy(asc(eventCateringPackagesTable.name));

  res.json({ packages });
});

router.post("/catering-packages", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const { name, description, pricePerHead, currency, menuItems, inclusions, minimumGuests } = req.body;
  if (!name || !pricePerHead) { { res.status(400).json({ error: "name and pricePerHead are required" }); return; } }

  const [pkg] = await db.insert(eventCateringPackagesTable).values({
    organizationId: orgId,
    name,
    description: description ?? null,
    pricePerHead: String(pricePerHead),
    currency: currency ?? "INR",
    menuItems: menuItems ?? [],
    inclusions: inclusions ?? [],
    minimumGuests: minimumGuests ? parseInt(minimumGuests) : null,
  }).returning();

  res.status(201).json({ package: pkg });
});

router.patch("/catering-packages/:pkgId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const pkgId = parseInt(String((req.params as Record<string, string>).pkgId));
  const [existing] = await db.select({ id: eventCateringPackagesTable.id })
    .from(eventCateringPackagesTable)
    .where(and(eq(eventCateringPackagesTable.id, pkgId), eq(eventCateringPackagesTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Catering package not found" }); return; } }

  const allowed = ["name","description","pricePerHead","currency","menuItems","inclusions","minimumGuests","isActive"] as const;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  const [pkg] = await db.update(eventCateringPackagesTable).set(updates)
    .where(eq(eventCateringPackagesTable.id, pkgId)).returning();
  res.json({ package: pkg });
});

router.delete("/catering-packages/:pkgId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const pkgId = parseInt(String((req.params as Record<string, string>).pkgId));
  await db.update(eventCateringPackagesTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(eventCateringPackagesTable.id, pkgId), eq(eventCateringPackagesTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── EVENT BOOKINGS ───────────────────────────────────────────────────────────

router.get("/bookings", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const { status, from, to, spaceId, search, limit: limitQ, offset: offsetQ } = req.query;

  const conditions = [eq(eventBookingsTable.organizationId, orgId)];
  if (status) conditions.push(eq(eventBookingsTable.status, String(status) as "enquiry" | "quote_sent" | "confirmed" | "invoiced" | "paid" | "cancelled"));
  if (spaceId) conditions.push(eq(eventBookingsTable.functionSpaceId, parseInt(String(spaceId))));
  if (from) conditions.push(gte(eventBookingsTable.eventDate, new Date(String(from))));
  if (to) conditions.push(lte(eventBookingsTable.eventDate, new Date(String(to))));
  if (search) {
    const q = `%${String(search)}%`;
    conditions.push(or(
      ilike(eventBookingsTable.eventName, q),
      ilike(eventBookingsTable.organiserName, q),
      ilike(eventBookingsTable.organiserEmail, q),
      ilike(eventBookingsTable.organiserCompany, q),
    )!);
  }

  const lim = Math.min(parseInt(String(limitQ ?? 50)), 200);
  const off = parseInt(String(offsetQ ?? 0));

  const bookings = await db.select({
    id: eventBookingsTable.id,
    status: eventBookingsTable.status,
    eventName: eventBookingsTable.eventName,
    eventType: eventBookingsTable.eventType,
    eventDate: eventBookingsTable.eventDate,
    startTime: eventBookingsTable.startTime,
    endTime: eventBookingsTable.endTime,
    organiserName: eventBookingsTable.organiserName,
    organiserEmail: eventBookingsTable.organiserEmail,
    organiserPhone: eventBookingsTable.organiserPhone,
    organiserCompany: eventBookingsTable.organiserCompany,
    expectedGuests: eventBookingsTable.expectedGuests,
    finalGuestCount: eventBookingsTable.finalGuestCount,
    layout: eventBookingsTable.layout,
    totalAmount: eventBookingsTable.totalAmount,
    currency: eventBookingsTable.currency,
    depositPaid: eventBookingsTable.depositPaid,
    functionSpaceId: eventBookingsTable.functionSpaceId,
    spaceName: functionSpacesTable.name,
    cateringPackageId: eventBookingsTable.cateringPackageId,
    packageName: eventCateringPackagesTable.name,
    assignedToUserId: eventBookingsTable.assignedToUserId,
    assignedToName: appUsersTable.displayName,
    createdAt: eventBookingsTable.createdAt,
  })
    .from(eventBookingsTable)
    .leftJoin(functionSpacesTable, eq(eventBookingsTable.functionSpaceId, functionSpacesTable.id))
    .leftJoin(eventCateringPackagesTable, eq(eventBookingsTable.cateringPackageId, eventCateringPackagesTable.id))
    .leftJoin(appUsersTable, eq(eventBookingsTable.assignedToUserId, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(asc(eventBookingsTable.eventDate))
    .limit(lim)
    .offset(off);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(eventBookingsTable)
    .where(and(...conditions));

  res.json({ bookings, total: count });
});

router.get("/bookings/:bookingId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const [booking] = await db.select()
    .from(eventBookingsTable)
    .where(and(eq(eventBookingsTable.id, bookingId), eq(eventBookingsTable.organizationId, orgId)));

  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const [space] = booking.functionSpaceId
    ? await db.select().from(functionSpacesTable).where(eq(functionSpacesTable.id, booking.functionSpaceId))
    : [null];

  const [catPkg] = booking.cateringPackageId
    ? await db.select().from(eventCateringPackagesTable).where(eq(eventCateringPackagesTable.id, booking.cateringPackageId))
    : [null];

  const [invoice] = await db.select().from(eventInvoicesTable)
    .where(eq(eventInvoicesTable.bookingId, bookingId))
    .orderBy(desc(eventInvoicesTable.createdAt))
    .limit(1);

  res.json({ booking, space: space ?? null, cateringPackage: catPkg ?? null, invoice: invoice ?? null });
});

router.post("/bookings", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const {
    functionSpaceId, cateringPackageId, status,
    organiserName, organiserEmail, organiserPhone, organiserCompany,
    eventName, eventType, eventDate, startTime, endTime,
    expectedGuests, layout, cateringNotes, avRequirements, specialRequirements,
    spaceHireAmount, cateringAmount, extras, totalAmount, depositAmount, depositPaid,
    currency, internalNotes, assignedToUserId,
  } = req.body;

  if (!organiserName || !organiserEmail || !eventName || !eventDate) {
    res.status(400).json({ error: "organiserName, organiserEmail, eventName, eventDate are required" });
    return;
  }

  const [booking] = await db.insert(eventBookingsTable).values({
    organizationId: orgId,
    functionSpaceId: functionSpaceId ? parseInt(functionSpaceId) : null,
    cateringPackageId: cateringPackageId ? parseInt(cateringPackageId) : null,
    status: status ?? "enquiry",
    organiserName,
    organiserEmail,
    organiserPhone: organiserPhone ?? null,
    organiserCompany: organiserCompany ?? null,
    eventName,
    eventType: eventType ?? null,
    eventDate: new Date(eventDate),
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    expectedGuests: expectedGuests ? parseInt(expectedGuests) : null,
    layout: layout ?? null,
    cateringNotes: cateringNotes ?? null,
    avRequirements: avRequirements ?? null,
    specialRequirements: specialRequirements ?? null,
    spaceHireAmount: spaceHireAmount ? String(spaceHireAmount) : null,
    cateringAmount: cateringAmount ? String(cateringAmount) : null,
    extras: extras ?? [],
    totalAmount: totalAmount ? String(totalAmount) : null,
    depositAmount: depositAmount ? String(depositAmount) : null,
    depositPaid: depositPaid ?? false,
    currency: currency ?? "INR",
    internalNotes: internalNotes ?? null,
    assignedToUserId: assignedToUserId ? parseInt(assignedToUserId) : null,
  }).returning();

  res.status(201).json({ booking });
});

router.patch("/bookings/:bookingId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const [existing] = await db.select({ id: eventBookingsTable.id })
    .from(eventBookingsTable)
    .where(and(eq(eventBookingsTable.id, bookingId), eq(eventBookingsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const allowed = [
    "functionSpaceId","cateringPackageId","organiserName","organiserEmail","organiserPhone",
    "organiserCompany","eventName","eventType","eventDate","startTime","endTime",
    "expectedGuests","finalGuestCount","layout","cateringNotes","avRequirements",
    "specialRequirements","spaceHireAmount","cateringAmount","extras","totalAmount",
    "depositAmount","depositPaid","currency","internalNotes","assignedToUserId",
  ] as const;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      if (key === "eventDate") updates[key] = new Date(req.body[key]);
      else updates[key] = req.body[key];
    }
  }

  const [booking] = await db.update(eventBookingsTable).set(updates)
    .where(eq(eventBookingsTable.id, bookingId)).returning();
  res.json({ booking });
});

router.patch("/bookings/:bookingId/status", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const { status } = req.body;

  const validStatuses = ["enquiry","quote_sent","confirmed","invoiced","paid","cancelled"];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: "Invalid status" }); return;
  }

  const [booking] = await db.select().from(eventBookingsTable)
    .where(and(eq(eventBookingsTable.id, bookingId), eq(eventBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const [updated] = await db.update(eventBookingsTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(eventBookingsTable.id, bookingId))
    .returning();

  const org = await getOrgBranding(orgId);
  const branding = org ? { orgName: org.name, logoUrl: org.logoUrl ?? undefined, primaryColor: org.primaryColor ?? undefined } : undefined;

  try {
    if (status === "quote_sent") {
      await sendEventQuote(booking.organiserEmail, booking.organiserName, booking.eventName, branding);
    } else if (status === "confirmed") {
      await sendEventConfirmation(booking.organiserEmail, booking.organiserName, booking.eventName, booking.eventDate, branding);
    }
  } catch {
    // Non-fatal: email failure doesn't block status update
  }

  res.json({ booking: updated });
});

router.delete("/bookings/:bookingId", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  await db.update(eventBookingsTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(eventBookingsTable.id, bookingId), eq(eventBookingsTable.organizationId, orgId)));
  res.json({ ok: true });
});

// ─── CALENDAR ─────────────────────────────────────────────────────────────────

router.get("/calendar", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const { year, month } = req.query;
  let from: Date, to: Date;

  if (year && month) {
    const y = parseInt(String(year));
    const m = parseInt(String(month)) - 1;
    from = new Date(y, m, 1);
    to = new Date(y, m + 1, 0, 23, 59, 59);
  } else {
    const now = new Date();
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  }

  const bookings = await db.select({
    id: eventBookingsTable.id,
    eventName: eventBookingsTable.eventName,
    eventType: eventBookingsTable.eventType,
    eventDate: eventBookingsTable.eventDate,
    startTime: eventBookingsTable.startTime,
    endTime: eventBookingsTable.endTime,
    status: eventBookingsTable.status,
    organiserName: eventBookingsTable.organiserName,
    expectedGuests: eventBookingsTable.expectedGuests,
    functionSpaceId: eventBookingsTable.functionSpaceId,
    spaceName: functionSpacesTable.name,
    totalAmount: eventBookingsTable.totalAmount,
    currency: eventBookingsTable.currency,
  })
    .from(eventBookingsTable)
    .leftJoin(functionSpacesTable, eq(eventBookingsTable.functionSpaceId, functionSpacesTable.id))
    .where(and(
      eq(eventBookingsTable.organizationId, orgId),
      gte(eventBookingsTable.eventDate, from),
      lte(eventBookingsTable.eventDate, to),
      ne(eventBookingsTable.status, "cancelled"),
    ))
    .orderBy(asc(eventBookingsTable.eventDate));

  res.json({ bookings, from, to });
});

// ─── INVOICES ─────────────────────────────────────────────────────────────────

router.get("/bookings/:bookingId/invoice", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const [invoice] = await db.select().from(eventInvoicesTable)
    .where(and(eq(eventInvoicesTable.bookingId, bookingId), eq(eventInvoicesTable.organizationId, orgId)))
    .orderBy(desc(eventInvoicesTable.createdAt))
    .limit(1);

  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }
  res.json({ invoice });
});

router.post("/bookings/:bookingId/invoice", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const [booking] = await db.select().from(eventBookingsTable)
    .where(and(eq(eventBookingsTable.id, bookingId), eq(eventBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const { lineItems, taxRate, notes, dueDate } = req.body;

  const items = lineItems ?? buildDefaultLineItems(booking);
  const subtotal = items.reduce((sum: number, li: { total: number }) => sum + (li.total ?? 0), 0);
  const taxRateVal = parseFloat(taxRate ?? "0");
  const taxAmount = subtotal * (taxRateVal / 100);
  const totalAmount = subtotal + taxAmount;

  const invoiceNumber = generateInvoiceNumber(orgId);

  const [invoice] = await db.insert(eventInvoicesTable).values({
    organizationId: orgId,
    bookingId,
    invoiceNumber,
    status: "draft",
    lineItems: items,
    subtotal: String(subtotal.toFixed(2)),
    taxRate: String(taxRateVal.toFixed(2)),
    taxAmount: String(taxAmount.toFixed(2)),
    totalAmount: String(totalAmount.toFixed(2)),
    currency: booking.currency ?? "INR",
    dueDate: dueDate ? new Date(dueDate) : null,
    notes: notes ?? null,
  }).returning();

  await db.update(eventBookingsTable)
    .set({ status: "invoiced", totalAmount: String(totalAmount.toFixed(2)), updatedAt: new Date() })
    .where(eq(eventBookingsTable.id, bookingId));

  res.status(201).json({ invoice });
});

router.patch("/bookings/:bookingId/invoice", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const [invoice] = await db.select({ id: eventInvoicesTable.id })
    .from(eventInvoicesTable)
    .where(and(eq(eventInvoicesTable.bookingId, bookingId), eq(eventInvoicesTable.organizationId, orgId)));
  if (!invoice) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  const { lineItems, taxRate, notes, dueDate, status } = req.body;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (lineItems !== undefined) {
    const subtotal = lineItems.reduce((s: number, li: { total: number }) => s + (li.total ?? 0), 0);
    const tr = parseFloat(taxRate ?? "0");
    const taxAmt = subtotal * (tr / 100);
    updates.lineItems = lineItems;
    updates.subtotal = String(subtotal.toFixed(2));
    updates.taxRate = String(tr.toFixed(2));
    updates.taxAmount = String(taxAmt.toFixed(2));
    updates.totalAmount = String((subtotal + taxAmt).toFixed(2));
  }
  if (notes !== undefined) updates.notes = notes;
  if (dueDate !== undefined) updates.dueDate = new Date(dueDate);
  if (status !== undefined) updates.status = status;

  const [updated] = await db.update(eventInvoicesTable).set(updates)
    .where(eq(eventInvoicesTable.id, invoice.id)).returning();
  res.json({ invoice: updated });
});

router.post("/bookings/:bookingId/invoice/send", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const [booking] = await db.select().from(eventBookingsTable)
    .where(and(eq(eventBookingsTable.id, bookingId), eq(eventBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const [inv] = await db.select().from(eventInvoicesTable)
    .where(and(eq(eventInvoicesTable.bookingId, bookingId), eq(eventInvoicesTable.organizationId, orgId)))
    .orderBy(desc(eventInvoicesTable.createdAt)).limit(1);
  if (!inv) { { res.status(404).json({ error: "Invoice not found — generate one first" }); return; } }

  const org = await getOrgBranding(orgId);
  const branding = org ? { orgName: org.name, logoUrl: org.logoUrl ?? undefined, primaryColor: org.primaryColor ?? undefined } : undefined;

  let emailDelivered = false;
  try {
    await sendEventInvoice(booking.organiserEmail, booking.organiserName, booking.eventName, inv.invoiceNumber, inv.totalAmount, inv.currency, inv.dueDate, branding);
    emailDelivered = true;
    await db.update(eventInvoicesTable)
      .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
      .where(eq(eventInvoicesTable.id, inv.id));
  } catch {
    // Email delivery failed
  }

  res.json({ ok: true, emailDelivered });
});

router.patch("/bookings/:bookingId/invoice/mark-paid", async (req: Request, res: Response) => {
  const orgId = parseOrgId(req);
  if (!await requireOrgAdminFn(req, res, orgId)) return;

  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  const [inv] = await db.select({ id: eventInvoicesTable.id })
    .from(eventInvoicesTable)
    .where(and(eq(eventInvoicesTable.bookingId, bookingId), eq(eventInvoicesTable.organizationId, orgId)));
  if (!inv) { { res.status(404).json({ error: "Invoice not found" }); return; } }

  await db.update(eventInvoicesTable)
    .set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
    .where(eq(eventInvoicesTable.id, inv.id));

  await db.update(eventBookingsTable)
    .set({ status: "paid", updatedAt: new Date() })
    .where(eq(eventBookingsTable.id, bookingId));

  res.json({ ok: true });
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function buildDefaultLineItems(booking: { eventName: string; spaceHireAmount?: string | null; cateringAmount?: string | null; extras?: { description: string; amount: number }[] | null }): { description: string; quantity: number; unitPrice: number; total: number }[] {
  const items: { description: string; quantity: number; unitPrice: number; total: number }[] = [];
  if (booking.spaceHireAmount) {
    const amt = parseFloat(booking.spaceHireAmount);
    items.push({ description: "Function Space Hire", quantity: 1, unitPrice: amt, total: amt });
  }
  if (booking.cateringAmount) {
    const amt = parseFloat(booking.cateringAmount);
    items.push({ description: "Catering & Beverages", quantity: 1, unitPrice: amt, total: amt });
  }
  for (const extra of (booking.extras ?? [])) {
    items.push({ description: extra.description, quantity: 1, unitPrice: extra.amount, total: extra.amount });
  }
  return items;
}

export default router;

// ─── PUBLIC ROUTES (no auth) ──────────────────────────────────────────────────

export const publicEventsRouter: IRouter = Router({ mergeParams: true });

publicEventsRouter.get("/spaces", async (req: Request, res: Response) => {
  const { orgId } = (req.params as Record<string, string>);
  if (!orgId) { { res.status(400).json({ error: "orgId required" }); return; } }

  const spaces = await db.select({
    id: functionSpacesTable.id,
    name: functionSpacesTable.name,
    description: functionSpacesTable.description,
    capacitySeated: functionSpacesTable.capacitySeated,
    capacityStanding: functionSpacesTable.capacityStanding,
    facilities: functionSpacesTable.facilities,
    avEquipment: functionSpacesTable.avEquipment,
    basePricePerDay: functionSpacesTable.basePricePerDay,
    currency: functionSpacesTable.currency,
    photoUrls: functionSpacesTable.photoUrls,
  }).from(functionSpacesTable)
    .where(and(
      eq(functionSpacesTable.organizationId, parseInt(orgId)),
      eq(functionSpacesTable.isActive, true),
    ))
    .orderBy(asc(functionSpacesTable.sortOrder), asc(functionSpacesTable.name));

  res.json({ spaces });
});

publicEventsRouter.post("/enquiry", async (req: Request, res: Response) => {
  const { orgId } = (req.params as Record<string, string>);
  if (!orgId) { { res.status(400).json({ error: "orgId required" }); return; } }

  const {
    organiserName, organiserEmail, organiserPhone, organiserCompany,
    eventName, eventType, eventDate, startTime, endTime,
    expectedGuests, functionSpaceId, cateringNotes, avRequirements, specialRequirements,
  } = req.body;

  if (!organiserName || !organiserEmail || !eventName || !eventDate) {
    res.status(400).json({ error: "organiserName, organiserEmail, eventName, eventDate are required" });
    return;
  }

  const parsedOrgId = parseInt(orgId);

  const [org] = await db.select({
    name: organizationsTable.name,
    logoUrl: organizationsTable.logoUrl,
    primaryColor: organizationsTable.primaryColor,
    isActive: organizationsTable.isActive,
  }).from(organizationsTable).where(eq(organizationsTable.id, parsedOrgId));

  if (!org || !org.isActive) { { res.status(404).json({ error: "Organisation not found" }); return; } }

  // Task #1758 — prefer the saved club_theming row over the legacy
  // organizations.* columns so the enquiry-ack email uses the same
  // branding the admin most recently picked in the club-theming UI.
  const brandedOrg = await resolveOrgBranding(parsedOrgId, org);

  const [booking] = await db.insert(eventBookingsTable).values({
    organizationId: parsedOrgId,
    functionSpaceId: functionSpaceId ? parseInt(functionSpaceId) : null,
    status: "enquiry",
    organiserName,
    organiserEmail,
    organiserPhone: organiserPhone ?? null,
    organiserCompany: organiserCompany ?? null,
    eventName,
    eventType: eventType ?? null,
    eventDate: new Date(eventDate),
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    expectedGuests: expectedGuests ? parseInt(expectedGuests) : null,
    cateringNotes: cateringNotes ?? null,
    avRequirements: avRequirements ?? null,
    specialRequirements: specialRequirements ?? null,
    currency: "INR",
  }).returning({ id: eventBookingsTable.id });

  const branding = {
    orgName: org.name,
    logoUrl: brandedOrg.logoUrl ?? undefined,
    primaryColor: brandedOrg.primaryColor ?? undefined,
  };
  try {
    await sendEventEnquiryAck(organiserEmail, organiserName, eventName, branding);
  } catch {
    // non-fatal
  }

  res.status(201).json({ bookingId: booking.id, message: "Enquiry submitted successfully. We'll be in touch shortly." });
});
