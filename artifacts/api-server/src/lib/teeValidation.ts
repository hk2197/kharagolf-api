/**
 * Tee Sheet Booking Validation
 *
 * Validates booking requests against:
 * 1. Player count rules (min/max by day, time, membership tier)
 * 2. Booking window tiers (how many days ahead each tier can book)
 *
 * Returns structured error codes and human-readable messages.
 */

import { db } from "@workspace/db";
import {
  teePlayerCountRulesTable,
  teeBookingWindowsTable,
  clubMembersTable,
  orgMembershipsTable,
  membershipTiersTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

export type TeeValidationError = {
  code: string;
  message: string;
  httpStatus: number;
};

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Resolve membership tier for a user based on their club membership.
 * Returns "public" for guests or unlinked users.
 */
async function resolveMembershipTier(orgId: number, userId: number): Promise<"full_member" | "social_member" | "guest" | "public"> {
  const [member] = await db
    .select({ tierId: clubMembersTable.tierId, subscriptionStatus: clubMembersTable.subscriptionStatus })
    .from(clubMembersTable)
    .where(and(eq(clubMembersTable.organizationId, orgId), eq(clubMembersTable.userId, userId)));

  if (!member) return "public";
  if (!member.tierId) return "full_member";

  const [tier] = await db
    .select({ name: membershipTiersTable.name })
    .from(membershipTiersTable)
    .where(eq(membershipTiersTable.id, member.tierId));

  if (!tier) return "full_member";
  const name = tier.name.toLowerCase();
  if (name.includes("social")) return "social_member";
  return "full_member";
}

/**
 * Validate player count rules for a booking.
 *
 * @param orgId  - Organization ID
 * @param courseId - Course ID (optional, null for org-wide rules)
 * @param slotDate - The date of the slot
 * @param slotTime - The time of the slot (e.g. "09:00")
 * @param partySize - Number of players in the booking
 * @param leadUserId - The lead user ID for tier resolution
 * @param isGuest - Whether the lead player is a guest
 */
export async function validatePlayerCountRules(
  orgId: number,
  courseId: number,
  slotDate: Date,
  slotTime: string,
  partySize: number,
  leadUserId: number,
  isGuest = false,
): Promise<TeeValidationError | null> {
  const dow = slotDate.getDay();
  const slotMin = toMinutes(slotTime);

  const tier = isGuest ? "guest" : await resolveMembershipTier(orgId, leadUserId);

  const rules = await db
    .select()
    .from(teePlayerCountRulesTable)
    .where(
      and(
        eq(teePlayerCountRulesTable.organizationId, orgId),
        eq(teePlayerCountRulesTable.isActive, true),
        sql`(${teePlayerCountRulesTable.courseId} IS NULL OR ${teePlayerCountRulesTable.courseId} = ${courseId})`,
        sql`(${teePlayerCountRulesTable.membershipTier} IS NULL OR ${teePlayerCountRulesTable.membershipTier} = ${tier})`,
      ),
    );

  for (const rule of rules) {
    const days = Array.isArray(rule.daysOfWeek) ? rule.daysOfWeek as number[] : null;
    if (days && !days.includes(dow)) continue;

    if (rule.startTime && rule.endTime) {
      const ruleStart = toMinutes(rule.startTime);
      const ruleEnd = toMinutes(rule.endTime);
      if (slotMin < ruleStart || slotMin >= ruleEnd) continue;
    }

    if (partySize < rule.minPlayers) {
      return {
        code: "PLAYER_COUNT_MIN_VIOLATION",
        message: `A minimum of ${rule.minPlayers} player(s) is required for this slot (club policy: ${rule.name}).`,
        httpStatus: 400,
      };
    }
    if (partySize > rule.maxPlayers) {
      return {
        code: "PLAYER_COUNT_MAX_VIOLATION",
        message: `A maximum of ${rule.maxPlayers} player(s) is allowed for this slot (club policy: ${rule.name}).`,
        httpStatus: 400,
      };
    }
  }

  return null;
}

/**
 * Validate that the booking is within the allowed booking window for the lead user's tier.
 */
export async function validateBookingWindow(
  orgId: number,
  slotDate: Date,
  leadUserId: number,
  isGuest = false,
): Promise<TeeValidationError | null> {
  const tier = isGuest ? "guest" : await resolveMembershipTier(orgId, leadUserId);

  const [windowRule] = await db
    .select({ daysAhead: teeBookingWindowsTable.daysAhead })
    .from(teeBookingWindowsTable)
    .where(
      and(
        eq(teeBookingWindowsTable.organizationId, orgId),
        eq(teeBookingWindowsTable.membershipTier, tier),
      ),
    );

  if (!windowRule) return null;

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const slotDay = new Date(slotDate);
  slotDay.setHours(0, 0, 0, 0);

  const daysUntilSlot = Math.round((slotDay.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

  if (daysUntilSlot > windowRule.daysAhead) {
    const tierLabels: Record<string, string> = {
      full_member: "Full Members",
      social_member: "Social Members",
      guest: "Guests",
      public: "Public",
    };
    return {
      code: "BOOKING_WINDOW_VIOLATION",
      message: `${tierLabels[tier] ?? "Your membership tier"} can only book up to ${windowRule.daysAhead} days in advance. This slot is ${daysUntilSlot} days away.`,
      httpStatus: 400,
    };
  }

  return null;
}

/**
 * Combined validation — runs both checks and returns the first error found.
 */
export async function validateTeeBooking(opts: {
  orgId: number;
  courseId: number;
  slotDate: Date;
  slotTime: string;
  partySize: number;
  leadUserId: number;
  isGuest?: boolean;
}): Promise<TeeValidationError | null> {
  const windowError = await validateBookingWindow(opts.orgId, opts.slotDate, opts.leadUserId, opts.isGuest);
  if (windowError) return windowError;

  const countError = await validatePlayerCountRules(
    opts.orgId,
    opts.courseId,
    opts.slotDate,
    opts.slotTime,
    opts.partySize,
    opts.leadUserId,
    opts.isGuest,
  );
  if (countError) return countError;

  return null;
}
