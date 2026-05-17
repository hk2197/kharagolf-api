/**
 * Lesson & Coaching Booking API
 * Scoped to: /organizations/:orgId/lessons
 *
 * GET    /pros                                List teaching pros (public)
 * POST   /pros                               Create pro (admin)
 * PATCH  /pros/:proId                        Update pro (admin)
 * DELETE /pros/:proId                        Delete pro (admin)
 * GET    /pros/:proId/lesson-types           List lesson types for a pro
 * POST   /pros/:proId/lesson-types           Create lesson type (admin)
 * PATCH  /pros/:proId/lesson-types/:typeId   Update lesson type (admin)
 * DELETE /pros/:proId/lesson-types/:typeId   Delete lesson type (admin)
 * GET    /pros/:proId/availability           Get availability slots for a pro + week
 * POST   /pros/:proId/availability           Set recurring availability template (admin)
 * DELETE /pros/:proId/availability/:availId  Remove availability entry (admin)
 * GET    /pros/:proId/schedule               Pro's upcoming bookings (pro/admin)
 * POST   /pros/:proId/book                   Member books a lesson (auth)
 * POST   /bookings/:bookingId/payment/verify  Verify Razorpay payment
 * POST   /bookings/:bookingId/cancel          Cancel booking (member or admin)
 * POST   /bookings/:bookingId/complete        Mark completed + add coaching note (pro/admin)
 * GET    /bookings/:bookingId/note            Get coaching note (pro/admin/member-owner)
 * GET    /my-bookings                         Member's own bookings
 * GET    /admin/bookings                      Admin: all bookings
 * GET    /admin/revenue                       Admin: revenue summary
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  teachingProsTable,
  lessonTypesTable,
  proAvailabilityTable,
  lessonBookingsTable,
  coachingNotesTable,
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
} from "@workspace/db";
import { attributeLessonCommission } from "./commissions";
import { eq, and, gte, lte, desc, asc, sql, inArray, lt } from "drizzle-orm";
import { requireOrgAdmin } from "../lib/permissions";
import { getRazorpayClient, getRazorpayKeyId } from "../lib/razorpay";
import { logger } from "../lib/logger";
import crypto from "crypto";
import { sendBroadcastEmail } from "../lib/mailer";
import { awardPoints } from "./loyalty";
import { track } from "../lib/analytics";

const router: IRouter = Router({ mergeParams: true });

/* ─── Auth helpers ──────────────────────────────────────────────── */

interface SessionUser { id: number; role?: string; organizationId?: number | null; displayName?: string; email?: string }

function getUser(req: Request): SessionUser | undefined {
  return req.user as SessionUser | undefined;
}

async function isOrgAdmin(user: SessionUser, orgId: number): Promise<boolean> {
  if (user.role === "super_admin") return true;
  if (["org_admin", "tournament_director"].includes(user.role ?? "") && user.organizationId === orgId) return true;
  const [mem] = await db.select({ role: orgMembershipsTable.role })
    .from(orgMembershipsTable)
    .where(and(eq(orgMembershipsTable.organizationId, orgId), eq(orgMembershipsTable.userId, user.id)));
  return !!mem && ["org_admin", "tournament_director"].includes(mem.role);
}

/** Check if user is the linked pro for the given proId */
async function isLinkedPro(userId: number, proId: number, orgId: number): Promise<boolean> {
  const [pro] = await db.select({ userId: teachingProsTable.userId })
    .from(teachingProsTable)
    .where(and(eq(teachingProsTable.id, proId), eq(teachingProsTable.organizationId, orgId)));
  return !!pro && pro.userId === userId;
}

/* ─── Helpers ────────────────────────────────────────────────────── */

function formatPro(pro: typeof teachingProsTable.$inferSelect) {
  return {
    ...pro,
    specialisms: pro.specialisms ?? [],
    createdAt: pro.createdAt.toISOString(),
    updatedAt: pro.updatedAt.toISOString(),
  };
}

function formatBooking(booking: typeof lessonBookingsTable.$inferSelect, extras?: { proName?: string; lessonTypeName?: string }) {
  return {
    ...booking,
    scheduledAt: booking.scheduledAt.toISOString(),
    cancelledAt: booking.cancelledAt?.toISOString() ?? null,
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    proName: extras?.proName,
    lessonTypeName: extras?.lessonTypeName,
  };
}

/** Convert "HH:MM" string to minutes-since-midnight integer */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Convert minutes-since-midnight to "HH:MM" string */
function minutesToTime(m: number): string {
  return `${Math.floor(m / 60).toString().padStart(2, "0")}:${(m % 60).toString().padStart(2, "0")}`;
}

/**
 * Generate available time slots for a pro on a given date.
 *
 * Timezone strategy: all slot strings (startTime/endTime) are treated as IST
 * (UTC+5:30). Booked scheduledAt timestamps are also converted to IST minutes
 * for comparison, so everything stays in the same frame of reference.
 *
 * Occupancy: an existing booking occupies [bookedStart, bookedStart + duration),
 * so a new slot at time T is occupied when T is within any existing booking's
 * duration range (not just at its exact start).
 */
async function generateSlots(proId: number, orgId: number, dateStr: string): Promise<{ time: string; available: boolean }[]> {
  // Interpret the date as IST midnight (UTC+5:30 = +330 min)
  const IST_OFFSET_MIN = 330;
  const date = new Date(dateStr + "T00:00:00+05:30");
  const dayOfWeek = date.getDay(); // in IST

  // Fetch recurring availability for this day of week
  const recurring = await db.select()
    .from(proAvailabilityTable)
    .where(and(
      eq(proAvailabilityTable.proId, proId),
      eq(proAvailabilityTable.organizationId, orgId),
      eq(proAvailabilityTable.dayOfWeek, dayOfWeek),
      sql`${proAvailabilityTable.specificDate} IS NULL`,
    ));

  // Fetch specific-date overrides (compare in IST day boundaries)
  const dayStartIST = new Date(dateStr + "T00:00:00+05:30");
  const dayEndIST = new Date(dateStr + "T23:59:59+05:30");
  const overrides = await db.select()
    .from(proAvailabilityTable)
    .where(and(
      eq(proAvailabilityTable.proId, proId),
      eq(proAvailabilityTable.organizationId, orgId),
      gte(proAvailabilityTable.specificDate, dayStartIST),
      lte(proAvailabilityTable.specificDate, dayEndIST),
    ));

  // Build set of available time ranges
  const ranges: { start: string; end: string; interval: number; blocked: boolean }[] = [];
  const hasOverrides = overrides.length > 0;

  if (hasOverrides) {
    for (const ov of overrides) {
      if (ov.startTime && ov.endTime) {
        ranges.push({ start: ov.startTime, end: ov.endTime, interval: ov.slotIntervalMinutes, blocked: ov.isBlocked });
      }
    }
  } else {
    for (const rec of recurring) {
      if (rec.startTime && rec.endTime) {
        ranges.push({ start: rec.startTime, end: rec.endTime, interval: rec.slotIntervalMinutes, blocked: rec.isBlocked });
      }
    }
  }

  if (ranges.length === 0) return [];

  // Generate all time slots (in IST minutes-since-midnight)
  const slotSet = new Set<string>();
  const blockedSet = new Set<string>();
  for (const range of ranges) {
    let cur = timeToMinutes(range.start);
    const endMin = timeToMinutes(range.end);
    while (cur < endMin) {
      const t = minutesToTime(cur);
      if (range.blocked) blockedSet.add(t);
      else slotSet.add(t);
      cur += range.interval;
    }
  }

  // Fetch existing confirmed/pending bookings for this IST day
  // We fetch a slightly wider UTC window to ensure we catch all IST-day bookings
  const windowStart = new Date(dayStartIST.getTime() - 6 * 3600000); // 6h before IST midnight = safe UTC start
  const windowEnd = new Date(dayEndIST.getTime() + 6 * 3600000);     // 6h after IST day end = safe UTC end
  const existingBookings = await db.select({
    scheduledAt: lessonBookingsTable.scheduledAt,
    durationMinutes: lessonBookingsTable.durationMinutes,
  })
    .from(lessonBookingsTable)
    .where(and(
      eq(lessonBookingsTable.proId, proId),
      gte(lessonBookingsTable.scheduledAt, windowStart),
      lte(lessonBookingsTable.scheduledAt, windowEnd),
      inArray(lessonBookingsTable.status, ["pending", "confirmed"]),
    ));

  // Build occupied ranges [startMin, endMin) in IST minutes-since-midnight
  const occupiedRanges: { start: number; end: number }[] = [];
  for (const bk of existingBookings) {
    const bkDate = new Date(bk.scheduledAt);
    // Convert to IST total minutes of day
    const utcMin = bkDate.getUTCHours() * 60 + bkDate.getUTCMinutes();
    const istMin = (utcMin + IST_OFFSET_MIN) % 1440;
    // Check this booking is actually on our target IST date
    const bkDateIST = new Date(bkDate.getTime() + IST_OFFSET_MIN * 60000);
    const bkDateStr = bkDateIST.toISOString().split("T")[0];
    if (bkDateStr !== dateStr) continue;
    occupiedRanges.push({ start: istMin, end: istMin + (bk.durationMinutes ?? 60) });
  }

  const allTimes = Array.from(slotSet).sort();
  return allTimes.map(time => {
    if (blockedSet.has(time)) return { time, available: false };
    const slotMin = timeToMinutes(time);
    // A slot is occupied if it falls within any existing booking's duration
    const occupied = occupiedRanges.some(r => slotMin >= r.start && slotMin < r.end);
    return { time, available: !occupied };
  });
}

/* ─── Notification helper ────────────────────────────────────────── */

async function notifyProOfBooking(opts: {
  pro: typeof teachingProsTable.$inferSelect;
  booking: typeof lessonBookingsTable.$inferSelect;
  lessonType: typeof lessonTypesTable.$inferSelect;
  memberName: string;
}): Promise<void> {
  const { pro, booking, lessonType, memberName } = opts;
  const proEmail = pro.email;
  if (!proEmail) return;

  const scheduledStr = booking.scheduledAt.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
  const bodyText = [
    `A new lesson has been booked with you.`,
    `Member: ${memberName}`,
    `Lesson: ${lessonType.name} (${lessonType.durationMinutes} min)`,
    `Date & Time: ${scheduledStr}`,
    booking.amountPaise > 0 ? `Amount: ₹${(booking.amountPaise / 100).toLocaleString("en-IN")}` : `Amount: Complimentary`,
    booking.notes ? `Member notes: ${booking.notes}` : "",
    `Please log in to your Pro Dashboard to view and manage your schedule.`,
  ].filter(Boolean).join("\n");

  await sendBroadcastEmail(
    proEmail,
    pro.displayName,
    `New lesson booking from ${memberName}`,
    bodyText,
    "KharaGolf Lessons",
  );
}

/* ─── GET /pros/me — Get linked pro profile for current user ─────── */

router.get("/pros/me", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const [pro] = await db.select()
    .from(teachingProsTable)
    .where(and(
      eq(teachingProsTable.organizationId, orgId),
      eq(teachingProsTable.userId, user.id),
      eq(teachingProsTable.isActive, true),
    ));

  if (!pro) { { res.status(404).json({ error: "No linked pro profile found" }); return; } }
  res.json(formatPro(pro));
});

/* ─── GET /pros — List active teaching pros ─────────────────────── */

router.get("/pros", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const pros = await db.select()
    .from(teachingProsTable)
    .where(and(eq(teachingProsTable.organizationId, orgId), eq(teachingProsTable.isActive, true)))
    .orderBy(asc(teachingProsTable.displayName));
  res.json(pros.map(formatPro));
});

/* ─── POST /pros — Create pro (admin) ───────────────────────────── */

router.post("/pros", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { displayName, email, phone, bio, photoUrl, specialisms, userId, cancellationWindowHours } = req.body as {
    displayName: string;
    email?: string;
    phone?: string;
    bio?: string;
    photoUrl?: string;
    specialisms?: string[];
    userId?: number;
    cancellationWindowHours?: number;
  };

  if (!displayName) { { res.status(400).json({ error: "displayName is required" }); return; } }

  const [pro] = await db.insert(teachingProsTable).values({
    organizationId: orgId,
    displayName,
    email: email ?? null,
    phone: phone ?? null,
    bio: bio ?? null,
    photoUrl: photoUrl ?? null,
    specialisms: specialisms ?? [],
    userId: userId ?? null,
    cancellationWindowHours: cancellationWindowHours ?? 24,
  }).returning();

  res.status(201).json(formatPro(pro));
});

/* ─── PATCH /pros/:proId — Update pro (admin) ───────────────────── */

router.patch("/pros/:proId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [existing] = await db.select().from(teachingProsTable)
    .where(and(eq(teachingProsTable.id, proId), eq(teachingProsTable.organizationId, orgId)));
  if (!existing) { { res.status(404).json({ error: "Pro not found" }); return; } }

  const updates: Partial<typeof teachingProsTable.$inferInsert> = { updatedAt: new Date() };
  if (req.body.displayName != null) updates.displayName = req.body.displayName;
  if (req.body.email !== undefined) updates.email = req.body.email;
  if (req.body.phone !== undefined) updates.phone = req.body.phone;
  if (req.body.bio !== undefined) updates.bio = req.body.bio;
  if (req.body.photoUrl !== undefined) updates.photoUrl = req.body.photoUrl;
  if (req.body.specialisms != null) updates.specialisms = req.body.specialisms;
  if (req.body.isActive != null) updates.isActive = req.body.isActive;
  if (req.body.userId !== undefined) updates.userId = req.body.userId;
  if (req.body.cancellationWindowHours != null) updates.cancellationWindowHours = req.body.cancellationWindowHours;

  const [updated] = await db.update(teachingProsTable).set(updates)
    .where(and(eq(teachingProsTable.id, proId), eq(teachingProsTable.organizationId, orgId)))
    .returning();
  res.json(formatPro(updated));
});

/* ─── DELETE /pros/:proId — Delete pro (admin) ──────────────────── */

router.delete("/pros/:proId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(teachingProsTable)
    .where(and(eq(teachingProsTable.id, proId), eq(teachingProsTable.organizationId, orgId)));
  res.json({ success: true });
});

/* ─── GET /pros/:proId/lesson-types ─────────────────────────────── */

router.get("/pros/:proId/lesson-types", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  const types = await db.select().from(lessonTypesTable)
    .where(and(eq(lessonTypesTable.proId, proId), eq(lessonTypesTable.organizationId, orgId), eq(lessonTypesTable.isActive, true)))
    .orderBy(asc(lessonTypesTable.durationMinutes));
  res.json(types);
});

/* ─── POST /pros/:proId/lesson-types ────────────────────────────── */

router.post("/pros/:proId/lesson-types", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { name, description, durationMinutes, pricePaise } = req.body as {
    name: string;
    description?: string;
    durationMinutes?: number;
    pricePaise?: number;
  };
  if (!name) { { res.status(400).json({ error: "name is required" }); return; } }

  const [type] = await db.insert(lessonTypesTable).values({
    proId,
    organizationId: orgId,
    name,
    description: description ?? null,
    durationMinutes: durationMinutes ?? 60,
    pricePaise: pricePaise ?? 0,
  }).returning();

  res.status(201).json(type);
});

/* ─── PATCH /pros/:proId/lesson-types/:typeId ───────────────────── */

router.patch("/pros/:proId/lesson-types/:typeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  const typeId = parseInt(String((req.params as Record<string, string>).typeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const updates: Partial<typeof lessonTypesTable.$inferInsert> = {};
  if (req.body.name != null) updates.name = req.body.name;
  if (req.body.description !== undefined) updates.description = req.body.description;
  if (req.body.durationMinutes != null) updates.durationMinutes = req.body.durationMinutes;
  if (req.body.pricePaise != null) updates.pricePaise = req.body.pricePaise;
  if (req.body.isActive != null) updates.isActive = req.body.isActive;

  const [updated] = await db.update(lessonTypesTable).set(updates)
    .where(and(eq(lessonTypesTable.id, typeId), eq(lessonTypesTable.proId, proId), eq(lessonTypesTable.organizationId, orgId)))
    .returning();
  if (!updated) { { res.status(404).json({ error: "Lesson type not found" }); return; } }
  res.json(updated);
});

/* ─── DELETE /pros/:proId/lesson-types/:typeId ──────────────────── */

router.delete("/pros/:proId/lesson-types/:typeId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  const typeId = parseInt(String((req.params as Record<string, string>).typeId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.update(lessonTypesTable).set({ isActive: false })
    .where(and(eq(lessonTypesTable.id, typeId), eq(lessonTypesTable.proId, proId), eq(lessonTypesTable.organizationId, orgId)));
  res.json({ success: true });
});

/* ─── GET /pros/:proId/availability — available slots for a date ── */

router.get("/pros/:proId/availability", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  const { date } = req.query as { date?: string };

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: "date query param required (YYYY-MM-DD)" }); return;
  }

  const slots = await generateSlots(proId, orgId, date);
  res.json({ date, slots });
});

/* ─── GET /pros/:proId/availability/templates — recurring templates ─ */

router.get("/pros/:proId/availability/templates", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));

  const templates = await db.select()
    .from(proAvailabilityTable)
    .where(and(
      eq(proAvailabilityTable.proId, proId),
      eq(proAvailabilityTable.organizationId, orgId),
      sql`${proAvailabilityTable.specificDate} IS NULL`,
    ))
    .orderBy(asc(proAvailabilityTable.dayOfWeek));
  res.json(templates);
});

/* ─── POST /pros/:proId/availability — add recurring slot template (admin) ─ */

router.post("/pros/:proId/availability", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { dayOfWeek, startTime, endTime, specificDate, isBlocked, slotIntervalMinutes } = req.body as {
    dayOfWeek?: number;
    startTime?: string;
    endTime?: string;
    specificDate?: string;
    isBlocked?: boolean;
    slotIntervalMinutes?: number;
  };

  if (dayOfWeek == null && !specificDate) {
    res.status(400).json({ error: "Either dayOfWeek or specificDate is required" }); return;
  }
  if (!isBlocked && (!startTime || !endTime)) {
    res.status(400).json({ error: "startTime and endTime are required for available slots" }); return;
  }

  const [avail] = await db.insert(proAvailabilityTable).values({
    proId,
    organizationId: orgId,
    dayOfWeek: dayOfWeek ?? null,
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    specificDate: specificDate ? new Date(specificDate) : null,
    isBlocked: isBlocked ?? false,
    slotIntervalMinutes: slotIntervalMinutes ?? 30,
  }).returning();

  res.status(201).json(avail);
});

/* ─── DELETE /pros/:proId/availability/:availId ─────────────────── */

router.delete("/pros/:proId/availability/:availId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  const availId = parseInt(String((req.params as Record<string, string>).availId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  await db.delete(proAvailabilityTable)
    .where(and(eq(proAvailabilityTable.id, availId), eq(proAvailabilityTable.proId, proId), eq(proAvailabilityTable.organizationId, orgId)));
  res.json({ success: true });
});

/* ─── GET /pros/:proId/schedule — pro's upcoming bookings ────────── */

router.get("/pros/:proId/schedule", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;
  const isAdmin = await isOrgAdmin(user, orgId);
  const isPro = await isLinkedPro(user.id, proId, orgId);
  if (!isAdmin && !isPro) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const from = req.query.from ? new Date(req.query.from as string) : new Date();
  const to = req.query.to ? new Date(req.query.to as string) : new Date(Date.now() + 14 * 86400000);

  const rows = await db.select({
    booking: lessonBookingsTable,
    lessonTypeName: lessonTypesTable.name,
    memberDisplay: appUsersTable.displayName,
  })
    .from(lessonBookingsTable)
    .leftJoin(lessonTypesTable, eq(lessonBookingsTable.lessonTypeId, lessonTypesTable.id))
    .leftJoin(appUsersTable, eq(lessonBookingsTable.userId, appUsersTable.id))
    .where(and(
      eq(lessonBookingsTable.proId, proId),
      eq(lessonBookingsTable.organizationId, orgId),
      gte(lessonBookingsTable.scheduledAt, from),
      lte(lessonBookingsTable.scheduledAt, to),
    ))
    .orderBy(asc(lessonBookingsTable.scheduledAt));

  res.json(rows.map(r => formatBooking(r.booking, { lessonTypeName: r.lessonTypeName ?? undefined })));
});

/* ─── GET /my-bookings — member's own bookings ───────────────────── */

router.get("/my-bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const rows = await db.select({
    booking: lessonBookingsTable,
    proName: teachingProsTable.displayName,
    lessonTypeName: lessonTypesTable.name,
  })
    .from(lessonBookingsTable)
    .leftJoin(teachingProsTable, eq(lessonBookingsTable.proId, teachingProsTable.id))
    .leftJoin(lessonTypesTable, eq(lessonBookingsTable.lessonTypeId, lessonTypesTable.id))
    .where(and(eq(lessonBookingsTable.userId, user.id), eq(lessonBookingsTable.organizationId, orgId)))
    .orderBy(desc(lessonBookingsTable.scheduledAt));

  res.json(rows.map(r => formatBooking(r.booking, { proName: r.proName ?? undefined, lessonTypeName: r.lessonTypeName ?? undefined })));
});

/* ─── POST /pros/:proId/book — member books a lesson ─────────────── */

router.post("/pros/:proId/book", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const proId = parseInt(String((req.params as Record<string, string>).proId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const { lessonTypeId, scheduledAt, notes } = req.body as {
    lessonTypeId: number;
    scheduledAt: string;
    notes?: string;
  };
  if (!lessonTypeId || !scheduledAt) {
    res.status(400).json({ error: "lessonTypeId and scheduledAt are required" }); return;
  }

  // Fetch pro + lesson type
  const [pro] = await db.select().from(teachingProsTable)
    .where(and(eq(teachingProsTable.id, proId), eq(teachingProsTable.organizationId, orgId), eq(teachingProsTable.isActive, true)));
  if (!pro) { { res.status(404).json({ error: "Pro not found" }); return; } }

  const [lessonType] = await db.select().from(lessonTypesTable)
    .where(and(eq(lessonTypesTable.id, lessonTypeId), eq(lessonTypesTable.proId, proId), eq(lessonTypesTable.isActive, true)));
  if (!lessonType) { { res.status(404).json({ error: "Lesson type not found" }); return; } }

  const slotDate = new Date(scheduledAt);
  if (isNaN(slotDate.getTime())) { { res.status(400).json({ error: "Invalid scheduledAt" }); return; } }

  // Validate that requested time falls within the pro's configured availability
  const dateStr = slotDate.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD in IST
  const availableSlots = await generateSlots(proId, orgId, dateStr);
  const IST_OFFSET_MIN = 330;
  const slotISTMin = ((slotDate.getUTCHours() * 60 + slotDate.getUTCMinutes()) + IST_OFFSET_MIN) % 1440;
  const slotTimeStr = minutesToTime(slotISTMin);
  const isSlotAvailable = availableSlots.some(s => s.time === slotTimeStr && s.available);
  if (!isSlotAvailable) {
    res.status(400).json({ error: "Requested time is not within the pro's available schedule" }); return;
  }

  // Check for double-booking using proper half-open interval intersection:
  // Intervals [A_start, A_end) and [B_start, B_end) overlap iff A_start < B_end AND A_end > B_start.
  // New slot: [slotDate, slotEnd). Existing booking: [ex.scheduledAt, ex.scheduledAt + ex.duration).
  // Overlap iff: slotDate < existingEnd AND slotEnd > existingStart
  // SQL: existingStart < slotEnd AND existingStart + duration > slotStart (strict > for half-open)
  const slotEnd = new Date(slotDate.getTime() + lessonType.durationMinutes * 60000);
  const conflicts = await db.select({ id: lessonBookingsTable.id })
    .from(lessonBookingsTable)
    .where(and(
      eq(lessonBookingsTable.proId, proId),
      eq(lessonBookingsTable.organizationId, orgId),
      inArray(lessonBookingsTable.status, ["pending", "confirmed"]),
      lt(lessonBookingsTable.scheduledAt, slotEnd),
      sql`${lessonBookingsTable.scheduledAt} + (${lessonBookingsTable.durationMinutes} * interval '1 minute') > ${slotDate.toISOString()}`,
    ));
  if (conflicts.length > 0) { { res.status(409).json({ error: "This time slot is already booked" }); return; } }

  const isFree = lessonType.pricePaise === 0;

  const [booking] = await db.insert(lessonBookingsTable).values({
    organizationId: orgId,
    proId,
    lessonTypeId,
    userId: user.id,
    memberName: user.displayName ?? "Member",
    memberEmail: user.email ?? null,
    scheduledAt: slotDate,
    durationMinutes: lessonType.durationMinutes,
    status: isFree ? "confirmed" : "pending",
    paymentStatus: isFree ? "paid" : "unpaid",
    amountPaise: lessonType.pricePaise,
    notes: notes ?? null,
  }).returning();

  if (isFree) {
    // Notify pro of free booking
    notifyProOfBooking({ pro, booking, lessonType, memberName: user.displayName ?? "Member" }).catch(e =>
      logger.warn({ e }, "[lessons] pro notification failed (free booking)")
    );
    void track("lesson_booked", {
      bookingId: booking.id,
      proId,
      lessonTypeId,
      durationMinutes: lessonType.durationMinutes,
      pricePaise: lessonType.pricePaise,
      isFree: true,
    }, { organizationId: orgId, userId: user.id });
    res.json({ booking: formatBooking(booking), requiresPayment: false });
    return;
  }

  try {
    const rzp = getRazorpayClient();
    const keyId = getRazorpayKeyId();
    const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    const order = await rzp.orders.create({
      amount: lessonType.pricePaise,
      currency: "INR",
      receipt: `lesson-${booking.id}`,
      notes: { bookingId: String(booking.id), proId: String(proId), orgName: org?.name ?? "" },
    });

    await db.update(lessonBookingsTable)
      .set({ razorpayOrderId: order.id })
      .where(eq(lessonBookingsTable.id, booking.id));

    res.json({
      booking: { ...formatBooking(booking), razorpayOrderId: order.id },
      requiresPayment: true,
      razorpayOrder: { orderId: order.id, amount: lessonType.pricePaise, currency: "INR", keyId },
    });
  } catch (e) {
    logger.error({ e }, "[lessons] Razorpay order creation failed");
    await db.delete(lessonBookingsTable).where(eq(lessonBookingsTable.id, booking.id));
    res.status(500).json({ error: "Payment gateway error. Please try again." });
  }
});

/* ─── POST /bookings/:bookingId/payment/verify ───────────────────── */

router.post("/bookings/:bookingId/payment/verify", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const [booking] = await db.select().from(lessonBookingsTable)
    .where(and(eq(lessonBookingsTable.id, bookingId), eq(lessonBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const admin = await isOrgAdmin(user, orgId);
  if (!admin && booking.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  };

  if (!booking.razorpayOrderId || booking.razorpayOrderId !== razorpayOrderId) {
    res.status(400).json({ error: "Order ID mismatch" }); return;
  }
  if (booking.paymentStatus === "paid") { { res.json({ success: true, alreadyConfirmed: true }); return; } }
  if (booking.status === "cancelled") { { res.status(400).json({ error: "Booking is cancelled" }); return; } }

  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) {
    logger.error("[lessons] RAZORPAY_KEY_SECRET is not configured — payment verification cannot proceed");
    res.status(500).json({ error: "Payment verification is not configured. Please contact support." });
    return;
  }
  const body = razorpayOrderId + "|" + razorpayPaymentId;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (expected !== razorpaySignature) { { res.status(400).json({ error: "Invalid payment signature" }); return; } }

  await db.update(lessonBookingsTable).set({
    paymentStatus: "paid",
    status: "confirmed",
    razorpayPaymentId,
    updatedAt: new Date(),
  }).where(eq(lessonBookingsTable.id, bookingId));

  // Notify pro of confirmed paid booking
  const [proRow] = await db.select().from(teachingProsTable).where(eq(teachingProsTable.id, booking.proId));
  const [ltRow] = await db.select().from(lessonTypesTable).where(eq(lessonTypesTable.id, booking.lessonTypeId));
  if (proRow && ltRow) {
    notifyProOfBooking({ pro: proRow, booking, lessonType: ltRow, memberName: booking.memberName }).catch(e =>
      logger.warn({ e }, "[lessons] pro notification failed (payment verified)")
    );
  }

  void track("lesson_booked", {
    bookingId: booking.id,
    proId: booking.proId,
    lessonTypeId: booking.lessonTypeId,
    durationMinutes: booking.durationMinutes,
    pricePaise: booking.amountPaise,
    isFree: false,
    paymentVerified: true,
  }, { organizationId: orgId, userId: user.id });

  res.json({ success: true });
});

/* ─── POST /bookings/:bookingId/cancel ───────────────────────────── */

router.post("/bookings/:bookingId/cancel", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const [booking] = await db.select({
    booking: lessonBookingsTable,
    cancellationWindowHours: teachingProsTable.cancellationWindowHours,
  })
    .from(lessonBookingsTable)
    .leftJoin(teachingProsTable, eq(lessonBookingsTable.proId, teachingProsTable.id))
    .where(and(eq(lessonBookingsTable.id, bookingId), eq(lessonBookingsTable.organizationId, orgId)));

  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const admin = await isOrgAdmin(user, orgId);
  if (!admin && booking.booking.userId !== user.id) { { res.status(403).json({ error: "Forbidden" }); return; } }

  if (["cancelled", "completed"].includes(booking.booking.status)) {
    res.status(400).json({ error: `Booking is already ${booking.booking.status}` }); return;
  }

  // Enforce cancellation window for members (not admins)
  if (!admin) {
    const windowHours = booking.cancellationWindowHours ?? 24;
    const cutoff = new Date(booking.booking.scheduledAt.getTime() - windowHours * 3600000);
    if (new Date() > cutoff) {
      res.status(400).json({ error: `Cancellations must be made at least ${windowHours} hours in advance` }); return;
    }
  }

  await db.update(lessonBookingsTable).set({
    status: "cancelled",
    cancelledAt: new Date(),
    cancelledByUserId: user.id,
    updatedAt: new Date(),
  }).where(eq(lessonBookingsTable.id, bookingId));

  res.json({ success: true });
});

/* ─── POST /bookings/:bookingId/complete — mark completed + add note ─ */

router.post("/bookings/:bookingId/complete", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const [booking] = await db.select().from(lessonBookingsTable)
    .where(and(eq(lessonBookingsTable.id, bookingId), eq(lessonBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const admin = await isOrgAdmin(user, orgId);
  const isPro = await isLinkedPro(user.id, booking.proId, orgId);
  if (!admin && !isPro) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const { noteContent } = req.body as { noteContent?: string };

  await db.update(lessonBookingsTable).set({
    status: "completed",
    updatedAt: new Date(),
  }).where(eq(lessonBookingsTable.id, bookingId));

  // Award loyalty points for the lesson
  if (booking.userId && booking.amountPaise) {
    const lessonTotal = booking.amountPaise / 100;
    if (lessonTotal > 0) {
      awardPoints({
        organizationId: orgId,
        userId: booking.userId,
        amountSpent: lessonTotal,
        category: "lesson",
        referenceId: `lesson:${bookingId}`,
        description: `Lesson booking #${bookingId} completed`,
      }).catch(() => {});
    }
  }

  if (noteContent?.trim()) {
    const existing = await db.select({ id: coachingNotesTable.id }).from(coachingNotesTable)
      .where(eq(coachingNotesTable.bookingId, bookingId));
    if (existing.length > 0) {
      await db.update(coachingNotesTable).set({ content: noteContent.trim(), updatedAt: new Date() })
        .where(eq(coachingNotesTable.bookingId, bookingId));
    } else {
      await db.insert(coachingNotesTable).values({
        bookingId,
        proId: booking.proId,
        organizationId: orgId,
        content: noteContent.trim(),
      });
    }
  }

  // Attribute commission to the pro (via their linked user account) — non-fatal
  if (booking.proId) {
    const [proRow] = await db.select({ userId: teachingProsTable.userId, amountPaise: lessonBookingsTable.amountPaise })
      .from(teachingProsTable)
      .leftJoin(lessonBookingsTable, eq(lessonBookingsTable.id, bookingId))
      .where(eq(teachingProsTable.id, booking.proId));
    if (proRow?.userId) {
      const lessonAmount = (booking.amountPaise ?? 0) / 100;
      attributeLessonCommission(orgId, proRow.userId, bookingId, lessonAmount).catch(() => {});
    }
  }

  // Task #2008 — branded `coach.review.delivered` dispatch when the pro
  // attached a coaching note (the post-lesson "review" the player gets).
  // Wrapped in a dynamic import so this route file picks up the helper
  // without expanding its top-of-file import block, matching the pattern
  // used elsewhere in this task for cold-path branded notifications.
  if (noteContent?.trim() && booking.userId) {
    const { notifyCoachReviewDelivered } = await import("../lib/brandedNotifications.js");
    void notifyCoachReviewDelivered({
      userIds: [booking.userId],
      reviewId: bookingId,
    });
  }

  res.json({ success: true });
});

/* ─── GET /bookings/:bookingId/note — get coaching note ─────────── */

router.get("/bookings/:bookingId/note", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const [booking] = await db.select().from(lessonBookingsTable)
    .where(and(eq(lessonBookingsTable.id, bookingId), eq(lessonBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const admin = await isOrgAdmin(user, orgId);
  const isPro = await isLinkedPro(user.id, booking.proId, orgId);
  const isOwner = booking.userId === user.id;
  if (!admin && !isPro && !isOwner) { { res.status(403).json({ error: "Forbidden" }); return; } }

  const [note] = await db.select().from(coachingNotesTable)
    .where(eq(coachingNotesTable.bookingId, bookingId));
  res.json(note ?? null);
});

/* ─── PUT /bookings/:bookingId/note — upsert coaching note ──────── */

router.put("/bookings/:bookingId/note", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const bookingId = parseInt(String((req.params as Record<string, string>).bookingId));
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = getUser(req)!;

  const [booking] = await db.select().from(lessonBookingsTable)
    .where(and(eq(lessonBookingsTable.id, bookingId), eq(lessonBookingsTable.organizationId, orgId)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }

  const admin = await isOrgAdmin(user, orgId);
  const isPro = await isLinkedPro(user.id, booking.proId, orgId);
  if (!admin && !isPro) { { res.status(403).json({ error: "Only the pro or admin can add coaching notes" }); return; } }

  const { content } = req.body as { content: string };
  if (!content?.trim()) { { res.status(400).json({ error: "content is required" }); return; } }

  const existing = await db.select({ id: coachingNotesTable.id }).from(coachingNotesTable)
    .where(eq(coachingNotesTable.bookingId, bookingId));

  if (existing.length > 0) {
    const [updated] = await db.update(coachingNotesTable).set({ content: content.trim(), updatedAt: new Date() })
      .where(eq(coachingNotesTable.bookingId, bookingId)).returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(coachingNotesTable).values({
      bookingId,
      proId: booking.proId,
      organizationId: orgId,
      content: content.trim(),
    }).returning();
    res.status(201).json(created);
  }
});

/* ─── GET /admin/bookings — all bookings (admin) ─────────────────── */

router.get("/admin/bookings", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to, proId: proIdQ, status } = req.query as { from?: string; to?: string; proId?: string; status?: string };
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const toDate = to ? new Date(to) : new Date(Date.now() + 90 * 86400000);

  const conditions = [
    eq(lessonBookingsTable.organizationId, orgId),
    gte(lessonBookingsTable.scheduledAt, fromDate),
    lte(lessonBookingsTable.scheduledAt, toDate),
  ];
  if (proIdQ) conditions.push(eq(lessonBookingsTable.proId, parseInt(proIdQ)));
  if (status) conditions.push(eq(lessonBookingsTable.status, status as "pending" | "confirmed" | "cancelled" | "completed" | "no_show"));

  const rows = await db.select({
    booking: lessonBookingsTable,
    proName: teachingProsTable.displayName,
    lessonTypeName: lessonTypesTable.name,
    memberDisplay: appUsersTable.displayName,
  })
    .from(lessonBookingsTable)
    .leftJoin(teachingProsTable, eq(lessonBookingsTable.proId, teachingProsTable.id))
    .leftJoin(lessonTypesTable, eq(lessonBookingsTable.lessonTypeId, lessonTypesTable.id))
    .leftJoin(appUsersTable, eq(lessonBookingsTable.userId, appUsersTable.id))
    .where(and(...conditions))
    .orderBy(desc(lessonBookingsTable.scheduledAt));

  res.json(rows.map(r => ({
    ...formatBooking(r.booking, { proName: r.proName ?? undefined, lessonTypeName: r.lessonTypeName ?? undefined }),
    memberDisplay: r.memberDisplay,
  })));
});

/* ─── GET /admin/revenue — revenue summary (admin) ──────────────── */

router.get("/admin/revenue", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const { from, to } = req.query as { from?: string; to?: string };
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
  const toDate = to ? new Date(to) : new Date();

  const rows = await db.select({
    booking: lessonBookingsTable,
    proName: teachingProsTable.displayName,
  })
    .from(lessonBookingsTable)
    .leftJoin(teachingProsTable, eq(lessonBookingsTable.proId, teachingProsTable.id))
    .where(and(
      eq(lessonBookingsTable.organizationId, orgId),
      gte(lessonBookingsTable.scheduledAt, fromDate),
      lte(lessonBookingsTable.scheduledAt, toDate),
    ));

  const paid = rows.filter(r => r.booking.paymentStatus === "paid");
  const totalRevenuePaise = paid.reduce((t, r) => t + r.booking.amountPaise, 0);

  // Group by pro
  const byPro: Record<string, { proName: string; bookings: number; revenuePaise: number }> = {};
  for (const r of rows) {
    const key = String(r.booking.proId);
    if (!byPro[key]) byPro[key] = { proName: r.proName ?? "Unknown", bookings: 0, revenuePaise: 0 };
    byPro[key].bookings++;
    if (r.booking.paymentStatus === "paid") byPro[key].revenuePaise += r.booking.amountPaise;
  }

  res.json({
    kpis: {
      totalBookings: rows.length,
      confirmedBookings: rows.filter(r => ["confirmed", "completed"].includes(r.booking.status)).length,
      cancelledBookings: rows.filter(r => r.booking.status === "cancelled").length,
      completedBookings: rows.filter(r => r.booking.status === "completed").length,
      totalRevenuePaise,
    },
    byPro: Object.values(byPro),
  });
});

export default router;
