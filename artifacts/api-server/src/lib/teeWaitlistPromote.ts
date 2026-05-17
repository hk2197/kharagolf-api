/**
 * Wave 2 W2-G — Tee-time waitlist auto-promote.
 *
 * When a confirmed booking on a slot cancels, this helper picks the
 * earliest matching waitlist entry whose party fits the freed capacity
 * and promotes it to a confirmed booking. The promotion runs inside a
 * single transaction so we never leave the slot in an inconsistent
 * state.
 *
 * The notification dispatch is deliberately fire-and-forget — the
 * caller (cancellation route) shouldn't block on email plumbing.
 */

import {
  db,
  teeBookingWaitlistTable,
  teeBookingsTable,
  courseTeeSlotTable,
  organizationsTable,
  coursesTable,
} from "@workspace/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { dispatchNotification } from "./notifyDispatch.js";
import type { EmailBranding } from "./mailer.js";
import { logger } from "./logger.js";

export interface PromotionResult {
  promoted: boolean;
  waitlistId?: number;
  bookingId?: number;
  reason?: string;
}

export async function promoteFromWaitlist(slotId: number): Promise<PromotionResult> {
  // Architect-flagged concurrency fix: do EVERYTHING — slot lock,
  // capacity recompute, candidate select-for-update-skip-locked,
  // status-guarded update, booking insert — inside a single
  // transaction so two concurrent cancellations on the same slot can
  // never promote the same waitlist row twice or overbook capacity.
  const result = await db.transaction(async (tx): Promise<PromotionResult> => {
    // 1. Lock the slot row so capacity check + insert is serialised.
    const [slot] = await tx.execute<{
      id: number; organization_id: number; capacity: number;
    }>(sql`
      SELECT id, organization_id, capacity
        FROM course_tee_slots
       WHERE id = ${slotId}
       FOR UPDATE
    `).then(r => (r as unknown as { rows: Array<{ id: number; organization_id: number; capacity: number }> }).rows ?? []);
    if (!slot) return { promoted: false, reason: "slot_not_found" };

    // 2. Recompute usage INSIDE the txn after the lock.
    const [usageRow] = await tx
      .select({ used: sql<number>`coalesce(sum(${teeBookingsTable.partySize}), 0)::int`.as("used") })
      .from(teeBookingsTable)
      .where(and(
        eq(teeBookingsTable.slotId, slotId),
        sql`${teeBookingsTable.status} IN ('pending', 'confirmed')`,
      ));
    const used = Number(usageRow?.used ?? 0);
    const free = (slot.capacity ?? 4) - used;
    if (free <= 0) return { promoted: false, reason: "no_capacity" };

    // 3. Pick + lock the oldest still-waiting entry that fits.
    //    SKIP LOCKED so a parallel txn moves to the next candidate
    //    instead of blocking.
    const candidates = await tx.execute<{ id: number; user_id: number; party_size: number }>(sql`
      SELECT id, user_id, party_size
        FROM tee_booking_waitlist
       WHERE slot_id = ${slotId}
         AND status = 'waiting'
         AND party_size <= ${free}
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    `).then(r => (r as unknown as { rows: Array<{ id: number; user_id: number; party_size: number }> }).rows ?? []);
    const candidate = candidates[0];
    if (!candidate) return { promoted: false, reason: "no_eligible_waiter" };

    // 4. Insert the booking + status-guarded update so a duplicate
    //    promotion attempt (somehow racing past SKIP LOCKED) cannot
    //    flip a row that already moved to 'promoted'.
    const [booking] = await tx.insert(teeBookingsTable).values({
      slotId,
      organizationId: slot.organization_id,
      leadUserId: candidate.user_id,
      partySize: candidate.party_size,
      status: "pending",
      paymentModel: "pay_at_checkin",
    }).returning({ id: teeBookingsTable.id });

    const updated = await tx.update(teeBookingWaitlistTable)
      .set({ status: "promoted", promotedBookingId: booking.id, promotedAt: new Date() })
      .where(and(
        eq(teeBookingWaitlistTable.id, candidate.id),
        eq(teeBookingWaitlistTable.status, "waiting"),
      ))
      .returning({ id: teeBookingWaitlistTable.id });
    if (updated.length === 0) {
      // Status raced to non-waiting; force rollback.
      throw new Error("waitlist_status_race");
    }
    return { promoted: true, waitlistId: candidate.id, bookingId: booking.id };
  });

  if (!result.promoted) return result;
  const promotedBookingId = result.bookingId!;
  const promotedWaitlistId = result.waitlistId!;

  // Look up the promoted user so we can notify them. The waitlist row
  // is the most reliable source — the candidate variable inside the txn
  // is no longer in scope here.
  let promotedUserId: number | null = null;
  try {
    const [row] = await db.select({ userId: teeBookingWaitlistTable.userId })
      .from(teeBookingWaitlistTable)
      .where(eq(teeBookingWaitlistTable.id, promotedWaitlistId))
      .limit(1);
    promotedUserId = row?.userId ?? null;
  } catch (err) {
    logger.warn({ promotedWaitlistId, err }, "[waitlist-promote] failed to load user for notify");
  }

  if (promotedUserId != null) {
    // Task #1171 — load slot/course/org context so the branded
    // `booking.waitlist.promoted` template can render the actual tee
    // time, course name, and club logo. The whole block is wrapped in
    // try/catch because notification enrichment must never break the
    // waitlist promote — we still fall back to bare values.
    let courseName: string | undefined;
    let teeDate: string | undefined;
    let teeTime: string | undefined;
    let branding: EmailBranding | undefined;
    try {
      const [slotInfo] = await db.select({
        courseId: courseTeeSlotTable.courseId,
        organizationId: courseTeeSlotTable.organizationId,
        slotDate: courseTeeSlotTable.slotDate,
        slotTime: courseTeeSlotTable.slotTime,
        courseName: coursesTable.name,
        orgName: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
        .from(courseTeeSlotTable)
        .leftJoin(coursesTable, eq(coursesTable.id, courseTeeSlotTable.courseId))
        .leftJoin(organizationsTable, eq(organizationsTable.id, courseTeeSlotTable.organizationId))
        .where(eq(courseTeeSlotTable.id, slotId))
        .limit(1);
      if (slotInfo) {
        courseName = slotInfo.courseName ?? undefined;
        teeDate = slotInfo.slotDate ? new Date(slotInfo.slotDate).toISOString().slice(0, 10) : undefined;
        teeTime = slotInfo.slotTime ?? undefined;
        branding = {
          orgId: slotInfo.organizationId,
          orgName: slotInfo.orgName ?? undefined,
          logoUrl: slotInfo.logoUrl ?? undefined,
          primaryColor: slotInfo.primaryColor ?? undefined,
        };
      }
    } catch (err) {
      logger.warn({ slotId, err }, "[waitlist-promote] failed to load branding/context");
    }

    // Task #1357 — supply a deep-link to the new booking so the
    // branded `booking.waitlist.promoted` template can render its CTA
    // ("View booking") and the recipient lands directly on the
    // confirmed tee time from the email.
    const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;
    const bookingUrl = `${baseUrl.replace(/\/$/, "")}/portal/bookings/${promotedBookingId}`;
    dispatchNotification("booking.waitlist.promoted", [promotedUserId], {
      title: "You're off the waitlist",
      body: "A spot opened up — your tee booking is now confirmed.",
      data: {
        type: "booking_waitlist_promoted",
        bookingId: promotedBookingId,
        slotId,
        courseName,
        teeDate,
        teeTime,
        bookingUrl,
      },
      branding,
    }).catch((err: unknown) => {
      logger.warn({ promotedBookingId, err }, "[waitlist-promote] notify dispatch failed");
    });
  }

  return { promoted: true, waitlistId: promotedWaitlistId, bookingId: promotedBookingId };
}
