/**
 * Tee Sheet Materialization Engine
 *
 * materializeTeeSheet(orgId, courseId, date) — reads active schedule templates and
 * block rules for a given date, then generates physical tee slots using
 * INSERT ... ON CONFLICT DO NOTHING so re-runs are safe.
 *
 * safeRegenerate(orgId, courseId, fromDate, toDate) — calls materializeTeeSheet for
 * each day in the range, skipping any days where all slots already have bookings.
 *
 * isDateBlocked(orgId, courseId, date, time?) — returns true when a block rule
 * covers the given date (and optionally time window).
 */

import { db } from "@workspace/db";
import {
  teeScheduleTemplatesTable,
  teeBlockRulesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  coursesTable,
} from "@workspace/db";
import { and, eq, gte, lte, sql, notInArray } from "drizzle-orm";
import { logger } from "./logger";

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function padTime(minutes: number): string {
  const h = Math.floor(minutes / 60).toString().padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Checks whether a given date+time is blocked by any active block rule for the org/course.
 * If slotTime is null, checks for a full-day block.
 */
export async function isDateBlocked(
  orgId: number,
  courseId: number,
  date: Date,
  slotTime?: string,
): Promise<boolean> {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);
  const dow = date.getDay();
  const dom = date.getDate();

  const rules = await db
    .select()
    .from(teeBlockRulesTable)
    .where(
      and(
        eq(teeBlockRulesTable.organizationId, orgId),
        eq(teeBlockRulesTable.isActive, true),
        sql`(${teeBlockRulesTable.courseId} IS NULL OR ${teeBlockRulesTable.courseId} = ${courseId})`,
      ),
    );

  for (const rule of rules) {
    let dateMatch = false;
    if (rule.recurrence === "one_off" && rule.blockDate) {
      const bd = new Date(rule.blockDate);
      dateMatch = bd >= dayStart && bd <= dayEnd;
    } else if (rule.recurrence === "weekly") {
      dateMatch = rule.recurrenceDayOfWeek === dow;
    } else if (rule.recurrence === "monthly") {
      dateMatch = rule.recurrenceDayOfMonth === dom;
    }

    if (!dateMatch) continue;

    if (!slotTime) return true;
    if (!rule.startTime && !rule.endTime) return true;
    if (rule.startTime && rule.endTime) {
      const slotMin = toMinutes(slotTime);
      const ruleStart = toMinutes(rule.startTime);
      const ruleEnd = toMinutes(rule.endTime);
      if (slotMin >= ruleStart && slotMin < ruleEnd) return true;
    }
  }
  return false;
}

type BlockRule = {
  recurrence: string | null;
  blockDate: Date | null;
  recurrenceDayOfWeek: number | null;
  recurrenceDayOfMonth: number | null;
  startTime: string | null;
  endTime: string | null;
};

/**
 * In-memory block check: same logic as isDateBlocked but operates on a pre-loaded
 * rules array to avoid N queries per slot during materialization.
 */
function isSlotBlockedInMemory(
  rules: BlockRule[],
  date: Date,
  slotTime: string,
): boolean {
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  const dow = date.getDay();
  const dom = date.getDate();

  for (const rule of rules) {
    let dateMatch = false;
    if (rule.recurrence === "one_off" && rule.blockDate) {
      const bd = new Date(rule.blockDate);
      dateMatch = bd >= dayStart && bd <= dayEnd;
    } else if (rule.recurrence === "weekly") {
      dateMatch = rule.recurrenceDayOfWeek === dow;
    } else if (rule.recurrence === "monthly") {
      dateMatch = rule.recurrenceDayOfMonth === dom;
    }
    if (!dateMatch) continue;
    if (!rule.startTime && !rule.endTime) return true;
    if (rule.startTime && rule.endTime) {
      const slotMin = toMinutes(slotTime);
      if (slotMin >= toMinutes(rule.startTime) && slotMin < toMinutes(rule.endTime)) return true;
    }
  }
  return false;
}

/**
 * Materialises tee slots for a single org/course/date combination.
 * Reads active schedule templates valid for the given date, then inserts slots
 * that don't already exist (ON CONFLICT DO NOTHING).
 * Block rules are loaded once per call and evaluated in-memory.
 * Returns the number of new slots created.
 */
export async function materializeTeeSheet(
  orgId: number,
  courseId: number,
  date: Date,
  dryRun = false,
): Promise<{ created: number; skipped: number; slots: { time: string; startingHole: number; startType: string; capacity: number }[] }> {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dow = date.getDay();

  // Load block rules and templates in parallel — one query each, no per-slot round-trips
  const [templates, blockRules] = await Promise.all([
    db
      .select()
      .from(teeScheduleTemplatesTable)
      .where(
        and(
          eq(teeScheduleTemplatesTable.organizationId, orgId),
          eq(teeScheduleTemplatesTable.courseId, courseId),
          eq(teeScheduleTemplatesTable.isActive, true),
          sql`(${teeScheduleTemplatesTable.validFrom} IS NULL OR ${teeScheduleTemplatesTable.validFrom} <= ${dayStart})`,
          sql`(${teeScheduleTemplatesTable.validUntil} IS NULL OR ${teeScheduleTemplatesTable.validUntil} >= ${dayStart})`,
        ),
      ),
    db
      .select()
      .from(teeBlockRulesTable)
      .where(
        and(
          eq(teeBlockRulesTable.organizationId, orgId),
          eq(teeBlockRulesTable.isActive, true),
          sql`(${teeBlockRulesTable.courseId} IS NULL OR ${teeBlockRulesTable.courseId} = ${courseId})`,
        ),
      ),
  ]);

  const activeTemplates = templates.filter((t) => {
    const days = Array.isArray(t.daysOfWeek) ? t.daysOfWeek as number[] : [0,1,2,3,4,5,6];
    return days.includes(dow);
  });

  if (activeTemplates.length === 0) {
    return { created: 0, skipped: 0, slots: [] };
  }

  const slotsToCreate: { time: string; startingHole: number; startType: string; capacity: number; templateId: number }[] = [];

  for (const tmpl of activeTemplates) {
    const startMin = toMinutes(tmpl.firstTeeTime);
    const endMin = toMinutes(tmpl.lastTeeTime);
    const interval = Math.max(1, tmpl.intervalMinutes);

    for (let min = startMin; min < endMin; min += interval) {
      const slotTime = padTime(min);
      const blocked = isSlotBlockedInMemory(blockRules as BlockRule[], date, slotTime);
      if (blocked) { slotsToCreate.push({ time: slotTime, startingHole: -1, startType: tmpl.startType, capacity: tmpl.capacity, templateId: tmpl.id }); continue; }

      if (tmpl.startType === "split_tee") {
        slotsToCreate.push({ time: slotTime, startingHole: 1, startType: "split_tee", capacity: tmpl.capacity, templateId: tmpl.id });
        slotsToCreate.push({ time: slotTime, startingHole: 10, startType: "split_tee", capacity: tmpl.capacity, templateId: tmpl.id });
      } else if (tmpl.startType === "shotgun") {
        for (let hole = 1; hole <= 18; hole++) {
          slotsToCreate.push({ time: slotTime, startingHole: hole, startType: "shotgun", capacity: tmpl.capacity, templateId: tmpl.id });
        }
      } else {
        slotsToCreate.push({ time: slotTime, startingHole: 1, startType: "normal", capacity: tmpl.capacity, templateId: tmpl.id });
      }
    }
  }

  const validSlots = slotsToCreate.filter(s => s.startingHole !== -1);
  const skipped = slotsToCreate.length - validSlots.length;

  if (dryRun) {
    return {
      created: 0,
      skipped,
      slots: validSlots.map(s => ({ time: s.time, startingHole: s.startingHole, startType: s.startType, capacity: s.capacity })),
    };
  }

  if (validSlots.length === 0) {
    return { created: 0, skipped, slots: [] };
  }

  const inserted = await db
    .insert(courseTeeSlotTable)
    .values(
      validSlots.map(s => ({
        organizationId: orgId,
        courseId,
        slotDate: dayStart,
        slotTime: s.time,
        capacity: s.capacity,
        startingHole: s.startingHole,
        startType: s.startType as "normal" | "split_tee" | "shotgun",
        templateId: s.templateId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: courseTeeSlotTable.id });

  return {
    created: inserted.length,
    skipped,
    slots: validSlots.map(s => ({ time: s.time, startingHole: s.startingHole, startType: s.startType, capacity: s.capacity })),
  };
}

/**
 * Safe re-generation for a date range.
 * Skips any slot that already has active bookings (confirmed or pending).
 * Only regenerates open/unbooked slots.
 */
export async function safeRegenerate(
  orgId: number,
  courseId: number,
  fromDate: Date,
  toDate: Date,
): Promise<{ daysProcessed: number; totalCreated: number; totalSkipped: number }> {
  let totalCreated = 0;
  let totalSkipped = 0;
  let daysProcessed = 0;

  const cur = new Date(fromDate);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(toDate);
  end.setHours(23, 59, 59, 999);

  while (cur <= end) {
    const dayStart = new Date(cur);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(cur);
    dayEnd.setHours(23, 59, 59, 999);

    // Find slot IDs that have active bookings — these must be preserved
    const bookedRows = await db
      .select({ slotId: teeBookingsTable.slotId })
      .from(teeBookingsTable)
      .innerJoin(courseTeeSlotTable, eq(courseTeeSlotTable.id, teeBookingsTable.slotId))
      .where(
        and(
          eq(courseTeeSlotTable.organizationId, orgId),
          eq(courseTeeSlotTable.courseId, courseId),
          gte(courseTeeSlotTable.slotDate, dayStart),
          lte(courseTeeSlotTable.slotDate, dayEnd),
          sql`${teeBookingsTable.status} IN ('confirmed', 'pending')`,
        ),
      );

    const bookedSlotIds = [...new Set(bookedRows.map(r => r.slotId))];

    // Delete only the open (unbooked) slots for this day — booked slots are untouched
    const deleteWhere = bookedSlotIds.length > 0
      ? and(
          eq(courseTeeSlotTable.organizationId, orgId),
          eq(courseTeeSlotTable.courseId, courseId),
          gte(courseTeeSlotTable.slotDate, dayStart),
          lte(courseTeeSlotTable.slotDate, dayEnd),
          eq(courseTeeSlotTable.status, "open"),
          notInArray(courseTeeSlotTable.id, bookedSlotIds),
        )
      : and(
          eq(courseTeeSlotTable.organizationId, orgId),
          eq(courseTeeSlotTable.courseId, courseId),
          gte(courseTeeSlotTable.slotDate, dayStart),
          lte(courseTeeSlotTable.slotDate, dayEnd),
          eq(courseTeeSlotTable.status, "open"),
        );

    await db.delete(courseTeeSlotTable).where(deleteWhere);

    // Re-materialise — ON CONFLICT DO NOTHING means booked slots that still exist are skipped
    const result = await materializeTeeSheet(orgId, courseId, cur);
    totalCreated += result.created;
    totalSkipped += result.skipped + bookedSlotIds.length;

    daysProcessed++;
    cur.setDate(cur.getDate() + 1);
  }

  logger.info({ orgId, courseId, fromDate, toDate, totalCreated, daysProcessed }, "[teeMaterializer] safeRegenerate complete");
  return { daysProcessed, totalCreated, totalSkipped };
}

/**
 * Called by the nightly cron job to materialise all courses for a specific date.
 */
export async function materializeAllCoursesForDate(orgId: number, date: Date): Promise<void> {
  const courses = await db
    .select({ id: coursesTable.id })
    .from(coursesTable)
    .where(eq(coursesTable.organizationId, orgId));

  for (const course of courses) {
    try {
      const result = await materializeTeeSheet(orgId, course.id, date);
      if (result.created > 0) {
        logger.info({ orgId, courseId: course.id, date, created: result.created }, "[teeMaterializer] materialised slots");
      }
    } catch (err) {
      logger.error({ err, orgId, courseId: course.id, date }, "[teeMaterializer] failed to materialise");
    }
  }
}
