/**
 * Tests for the Dynamic Pricing Engine — Task #435.
 *
 * Covers `artifacts/api-server/src/lib/dynamicPricing.ts` and the booking
 * route in `artifacts/api-server/src/routes/tee-bookings.ts`:
 *
 *   Unit tests (resolveEffectivePrice):
 *     - Tier priority selection (highest priority + courseId/memberType
 *       specificity tie-break)
 *     - Member-type matching (member-only / guest-only / any)
 *     - Utilization, lead-time and weather modifiers
 *     - Cap (ceiling) and floor clamping
 *     - Deal-badge threshold
 *
 *   Integration test (POST /tee-bookings):
 *     - Books a slot end-to-end and asserts the booking's `totalAmount`
 *       reflects the price the engine resolved (party_size × effective rate).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  teeBookingPlayersTable,
  teePricingRulesTable,
  teeDynamicPricingTiersTable,
  teeDynamicPricingModifiersTable,
  teeDynamicPricingConfigTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { resolveEffectivePrice } from "../lib/dynamicPricing.js";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let userId: number;
let courseId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** Pick a future date that lands on a specific day-of-week (0=Sun..6=Sat). */
function nextDateForDow(targetDow: number, minDaysAhead = 7): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() !== targetDow) d.setDate(d.getDate() + 1);
  return d;
}

async function clearDynamicConfig() {
  await db.delete(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
}

async function setConfig(opts: { enabled: boolean; floor?: string; ceiling?: string; dealPct?: string }) {
  const fields = {
    enabled: opts.enabled,
    priceFloorPct: opts.floor ?? "0.50",
    priceCeilingPct: opts.ceiling ?? "2.00",
    dealBadgeThresholdPct: opts.dealPct ?? "0.85",
  };
  await db.insert(teeDynamicPricingConfigTable).values({
    organizationId: orgId,
    ...fields,
  }).onConflictDoUpdate({
    target: teeDynamicPricingConfigTable.organizationId,
    set: { ...fields, updatedAt: new Date() },
  });
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `DynPricingTest_${stamp}`,
    slug: `dyn-pricing-test-${stamp}`,
    subscriptionTier: "starter", // bypass the free-tier subscription gate
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `dyn-pricing-${stamp}`,
    username: `dyn_pricing_${stamp}`,
    email: `dyn_pricing_${stamp}@example.com`,
    displayName: "Dyn Pricing Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Test Course",
    slug: `test-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  // Base legacy rates: members 1000, guests 1500.
  await db.insert(teePricingRulesTable).values({
    organizationId: orgId,
    memberRate: "1000",
    guestRate: "1500",
  });

  admin = {
    id: userId,
    username: `dyn_pricing_${stamp}`,
    displayName: "Dyn Pricing Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

// Reusable input builder
function priceInput(over: Partial<Parameters<typeof resolveEffectivePrice>[0]> = {}) {
  return {
    orgId,
    courseId,
    slotDate: nextDateForDow(3), // Wednesday
    slotTime: "10:00",
    capacity: 4,
    bookedCount: 0,
    memberType: "member" as const,
    asOf: new Date(),
    ...over,
  };
}

describe("dynamicPricing unit — base/legacy fallback", () => {
  it("returns the legacy member rate when dynamic pricing is disabled", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: false });
    const r = await resolveEffectivePrice(priceInput());
    expect(r.basePrice).toBe(1000);
    expect(r.finalPrice).toBe(1000);
    expect(r.tierId).toBeNull();
    expect(r.isDeal).toBe(false);
  });

  it("returns the legacy guest rate for guest member type", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: false });
    const r = await resolveEffectivePrice(priceInput({ memberType: "guest" }));
    expect(r.basePrice).toBe(1500);
    expect(r.finalPrice).toBe(1500);
  });
});

describe("dynamicPricing unit — tier selection", () => {
  it("picks the highest-priority tier that matches", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });

    // Two tiers both match; priority 5 should win over priority 1.
    await db.insert(teeDynamicPricingTiersTable).values([
      {
        organizationId: orgId, name: "Low priority", daysOfWeek: [3],
        memberType: "any", memberRate: "800", guestRate: "1200", priority: 1,
      },
      {
        organizationId: orgId, name: "High priority", daysOfWeek: [3],
        memberType: "any", memberRate: "1300", guestRate: "1800", priority: 5,
      },
    ]);

    const r = await resolveEffectivePrice(priceInput());
    expect(r.tierName).toBe("High priority");
    expect(r.finalPrice).toBe(1300);
  });

  it("ignores tiers that do not match the day-of-week", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId, name: "Weekend only",
      daysOfWeek: [0, 6], // Sun, Sat
      memberType: "any", memberRate: "2000", guestRate: "3000", priority: 10,
    });

    const wednesday = nextDateForDow(3);
    const r = await resolveEffectivePrice(priceInput({ slotDate: wednesday }));
    expect(r.tierName).toBeNull();
    expect(r.finalPrice).toBe(1000); // back to legacy base
  });

  it("prefers a course-specific tier over an org-wide tier at equal priority", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingTiersTable).values([
      {
        organizationId: orgId, name: "Org-wide", courseId: null,
        daysOfWeek: [3], memberType: "any",
        memberRate: "950", guestRate: "1450", priority: 5,
      },
      {
        organizationId: orgId, name: "Course-specific", courseId,
        daysOfWeek: [3], memberType: "any",
        memberRate: "880", guestRate: "1380", priority: 5,
      },
    ]);
    const r = await resolveEffectivePrice(priceInput());
    expect(r.tierName).toBe("Course-specific");
    expect(r.finalPrice).toBe(880);
  });

  it("respects tier time-window (start_time/end_time)", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId, name: "Morning",
      daysOfWeek: [3], startTime: "06:00", endTime: "10:00",
      memberType: "any", memberRate: "700", guestRate: "1100", priority: 5,
    });

    const inWindow = await resolveEffectivePrice(priceInput({ slotTime: "09:00" }));
    expect(inWindow.tierName).toBe("Morning");
    expect(inWindow.finalPrice).toBe(700);

    const outWindow = await resolveEffectivePrice(priceInput({ slotTime: "10:00" }));
    expect(outWindow.tierName).toBeNull();
  });
});

describe("dynamicPricing unit — member-type matching", () => {
  it("only matches a member-type=guest tier when memberType is guest", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId, name: "Guest premium",
      daysOfWeek: [3], memberType: "guest",
      memberRate: "0", guestRate: "1800", priority: 5,
    });

    const memberCall = await resolveEffectivePrice(priceInput({ memberType: "member" }));
    expect(memberCall.tierId).toBeNull();
    expect(memberCall.finalPrice).toBe(1000); // legacy member rate

    const guestCall = await resolveEffectivePrice(priceInput({ memberType: "guest" }));
    expect(guestCall.tierName).toBe("Guest premium");
    expect(guestCall.finalPrice).toBe(1800);
  });

  it("prefers a member-type-specific tier over an 'any' tier of equal priority", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingTiersTable).values([
      {
        organizationId: orgId, name: "Generic any",
        daysOfWeek: [3], memberType: "any",
        memberRate: "900", guestRate: "1400", priority: 5,
      },
      {
        organizationId: orgId, name: "Member-specific",
        daysOfWeek: [3], memberType: "member",
        memberRate: "850", guestRate: "0", priority: 5,
      },
    ]);
    const r = await resolveEffectivePrice(priceInput({ memberType: "member" }));
    expect(r.tierName).toBe("Member-specific");
    expect(r.finalPrice).toBe(850);
  });
});

describe("dynamicPricing unit — modifiers", () => {
  it("applies a utilization modifier when utilization is in [min,max)", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId, name: "High demand",
      kind: "utilization",
      thresholdMin: "0.75", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "20",
      applyTo: "any", priority: 1,
    });

    // capacity 4, booked 3 → utilization 0.75 → modifier fires (+20%)
    const fires = await resolveEffectivePrice(priceInput({ capacity: 4, bookedCount: 3 }));
    expect(fires.finalPrice).toBe(1200);

    // capacity 4, booked 2 → utilization 0.5 → no modifier
    const skips = await resolveEffectivePrice(priceInput({ capacity: 4, bookedCount: 2 }));
    expect(skips.finalPrice).toBe(1000);
  });

  it("applies a lead-time modifier (last-minute discount via flat adjustment)", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId, name: "Last-minute deal",
      kind: "lead_time",
      thresholdMin: "0", thresholdMax: "6", // less than 6h away
      adjustmentType: "flat", adjustmentValue: "-200",
      applyTo: "any", priority: 1,
    });

    const slotDate = nextDateForDow(3);
    const slotTime = "10:00";
    // asOf = 2h before slot → lead_time = 2h → modifier fires
    const asOfClose = new Date(slotDate);
    asOfClose.setHours(8, 0, 0, 0);
    const closeIn = await resolveEffectivePrice(priceInput({ slotDate, slotTime, asOf: asOfClose }));
    expect(closeIn.finalPrice).toBe(800);

    // asOf 24h before slot → lead_time = 24h → no modifier
    const asOfFar = new Date(slotDate);
    asOfFar.setDate(asOfFar.getDate() - 1);
    asOfFar.setHours(10, 0, 0, 0);
    const farOut = await resolveEffectivePrice(priceInput({ slotDate, slotTime, asOf: asOfFar }));
    expect(farOut.finalPrice).toBe(1000);
  });

  it("applies a weather modifier on matching condition (case-insensitive)", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId, name: "Rain discount",
      kind: "weather",
      weatherCondition: "rain",
      adjustmentType: "percent", adjustmentValue: "-25",
      applyTo: "any", priority: 1,
    });

    const rainy = await resolveEffectivePrice(priceInput({ weatherCondition: "RAIN" }));
    expect(rainy.finalPrice).toBe(750);

    const sunny = await resolveEffectivePrice(priceInput({ weatherCondition: "sunny" }));
    expect(sunny.finalPrice).toBe(1000);
  });
});

describe("dynamicPricing unit — caps and floors", () => {
  it("clamps an aggressive surge to the configured ceiling", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true, ceiling: "1.30", floor: "0.50" });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId, name: "Crazy surge",
      kind: "utilization",
      thresholdMin: "0", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "200", // would triple price
      applyTo: "any", priority: 1,
    });
    const r = await resolveEffectivePrice(priceInput());
    // 1000 * 3 = 3000 → clamped to 1000 * 1.30 = 1300
    expect(r.finalPrice).toBe(1300);
    expect(r.breakdown.some(s => s.source === "cap")).toBe(true);
  });

  it("clamps an aggressive discount up to the configured floor", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true, ceiling: "2.00", floor: "0.70" });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId, name: "Huge discount",
      kind: "utilization",
      thresholdMin: "0", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "-90",
      applyTo: "any", priority: 1,
    });
    const r = await resolveEffectivePrice(priceInput());
    // 1000 * 0.10 = 100 → floored to 1000 * 0.70 = 700
    expect(r.finalPrice).toBe(700);
    expect(r.breakdown.some(s => s.source === "floor")).toBe(true);
  });
});

describe("dynamicPricing unit — deal badge", () => {
  it("flags isDeal when final price is below the deal threshold of base", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true, floor: "0.50", ceiling: "2.00", dealPct: "0.85" });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId, name: "Modest discount",
      kind: "utilization",
      thresholdMin: "0", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "-20", // 1000 → 800 (< 850 threshold)
      applyTo: "any", priority: 1,
    });
    const r = await resolveEffectivePrice(priceInput());
    expect(r.finalPrice).toBe(800);
    expect(r.isDeal).toBe(true);
    expect(r.dealBadge).toMatch(/Save 20%/);
  });

  it("does not flag a deal when discount is smaller than the threshold gap", async () => {
    await clearDynamicConfig();
    await setConfig({ enabled: true, floor: "0.50", ceiling: "2.00", dealPct: "0.85" });
    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId, name: "Tiny discount",
      kind: "utilization",
      thresholdMin: "0", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "-10", // 1000 → 900 (>= 850 threshold)
      applyTo: "any", priority: 1,
    });
    const r = await resolveEffectivePrice(priceInput());
    expect(r.finalPrice).toBe(900);
    expect(r.isDeal).toBe(false);
    expect(r.dealBadge).toBeNull();
  });
});

describe("dynamicPricing integration — booking persists effective price", () => {
  it("creates a booking whose totalAmount = partySize × effective member rate", async () => {
    await clearDynamicConfig();
    // Enable dynamic pricing with a tier that materially shifts the price.
    await setConfig({ enabled: true, floor: "0.50", ceiling: "2.00", dealPct: "0.85" });
    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId, name: "Booking tier",
      daysOfWeek: [0,1,2,3,4,5,6], // any day
      memberType: "any", memberRate: "750", guestRate: "1200", priority: 5,
    });

    const slotDate = nextDateForDow(3);
    const slotTime = "11:00";
    const [slot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate, slotTime, capacity: 4,
    }).returning();

    // Sanity: pricing engine resolves to 750 for members.
    const resolved = await resolveEffectivePrice({
      orgId, courseId, slotDate, slotTime,
      capacity: 4, bookedCount: 0, memberType: "member",
    });
    expect(resolved.finalPrice).toBe(750);

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-bookings`)
      .send({ slotId: slot.id, partySize: 2 });

    expect(res.status, `booking failed: ${res.text}`).toBe(201);
    const bookingId: number = res.body.id;
    expect(bookingId).toBeGreaterThan(0);

    const [booking] = await db.select().from(teeBookingsTable)
      .where(eq(teeBookingsTable.id, bookingId));
    expect(booking).toBeDefined();
    // 2 seats × 750 = 1500
    expect(parseFloat(String(booking.totalAmount ?? "0"))).toBe(1500);

    // Each player row carries the effective per-seat fee.
    const players = await db.select().from(teeBookingPlayersTable)
      .where(eq(teeBookingPlayersTable.bookingId, bookingId));
    expect(players.length).toBe(2);
    for (const p of players) {
      expect(parseFloat(String(p.fee ?? "0"))).toBe(750);
    }

    // Cleanup
    await db.delete(teeBookingPlayersTable).where(eq(teeBookingPlayersTable.bookingId, bookingId));
    await db.delete(teeBookingsTable).where(eq(teeBookingsTable.id, bookingId));
    await db.delete(courseTeeSlotTable).where(and(
      eq(courseTeeSlotTable.id, slot.id),
      eq(courseTeeSlotTable.organizationId, orgId),
    ));
  });
});
