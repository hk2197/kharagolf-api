/**
 * Tests for the tier + modifier preview endpoints — Task #1345.
 *
 * Symmetric counterpart to `dynamic-pricing-rule-preview.test.ts` (Task #1163).
 * Verifies:
 *   - `POST /organizations/:orgId/tee-pricing/tiers/:id/preview` returns
 *     upcoming open slots that resolve to the tier as their base price,
 *     with the matching `tier` step located via `tierStepIndex` so the UI
 *     can highlight it. Honours day-of-week + time-window conditions and
 *     skips slots a higher-priority tier wins.
 *   - `POST /organizations/:orgId/tee-pricing/modifiers/:id/preview`
 *     returns slots whose breakdown contains the modifier, with the step
 *     located via `modifierStepIndex`. Honours utilisation thresholds.
 *   - Both endpoints preview INACTIVE rows so admins can sanity-check
 *     before publishing, and force the dyn engine on so admins on a
 *     disabled engine still see useful results.
 *   - Both endpoints 404 when the row belongs to another org.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  coursesTable,
  courseTeeSlotTable,
  teeBookingsTable,
  teePricingRulesTable,
  teeDynamicPricingTiersTable,
  teeDynamicPricingModifiersTable,
  teeDynamicPricingConfigTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let userId: number;
let courseId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** Pick a future Date that lands on the given DOW (0=Sun..6=Sat). */
function nextDateForDow(targetDow: number, minDaysAhead = 1): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() !== targetDow) d.setDate(d.getDate() + 1);
  return d;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TierModPreview_${stamp}`,
    slug: `tier-mod-preview-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `tier-mod-preview-${stamp}`,
    username: `tier_mod_preview_${stamp}`,
    email: `tier_mod_preview_${stamp}@example.com`,
    displayName: "Tier Mod Preview Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Tier Mod Preview Course",
    slug: `tier-mod-preview-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId, memberRate: "1000", guestRate: "1500",
  });

  // Engine intentionally left disabled — the preview endpoints force it
  // on per-evaluation so admins can preview before flipping the switch.
  // This guards against a regression where the preview silently no-ops
  // when the org hasn't enabled the dyn engine yet.
  await db.insert(teeDynamicPricingConfigTable).values({
    organizationId: orgId, enabled: false,
    priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
  });

  admin = {
    id: userId,
    username: `tier_mod_preview_${stamp}`,
    displayName: "Tier Mod Preview Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  // Delete bookings first — they FK to app_users.lead_user_id with restrict.
  if (orgId) await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

async function clearSlotsTiersMods() {
  await db.delete(teeBookingsTable).where(eq(teeBookingsTable.organizationId, orgId));
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  await db.delete(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  await db.delete(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
}

describe("tier preview — Task #1345", () => {
  it("returns slots that resolve to the tier and skips others (DOW + time window + higher-priority tier)", async () => {
    await clearSlotsTiersMods();

    // Saturday morning slot — should match the weekend morning tier.
    const sat = nextDateForDow(6);
    const [matchSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    }).returning();

    // Saturday afternoon slot — outside the morning window — should be excluded.
    const [satAfternoon] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "14:00", capacity: 4,
    }).returning();

    // Wednesday morning — wrong DOW — should be excluded.
    const wed = nextDateForDow(3);
    const [wedSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: wed, slotTime: "08:00", capacity: 4,
    }).returning();

    // Sunday morning — matches DOW + time window for our test tier, but a
    // higher-priority "premium" tier scoped to Sunday will win it. Should
    // be excluded from our preview because the tier step belongs to the
    // higher-priority tier, not ours.
    const sun = nextDateForDow(0);
    const [sunSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sun, slotTime: "08:00", capacity: 4,
    }).returning();

    const [tier] = await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId,
      name: "Weekend mornings",
      daysOfWeek: [0, 6],
      startTime: "06:00", endTime: "11:00",
      memberType: "any",
      memberRate: "1500", guestRate: "2000",
      priority: 1, isActive: true,
    }).returning();

    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId,
      name: "Sunday premium",
      daysOfWeek: [0],
      startTime: "06:00", endTime: "11:00",
      memberType: "any",
      memberRate: "1800", guestRate: "2500",
      priority: 5, isActive: true,
    });

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tier.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.tier.id).toBe(tier.id);
    expect(res.body.matchCount).toBe(1);

    const m = res.body.matches[0];
    expect(m.slotId).toBe(matchSlot.id);
    expect(m.slotTime).toBe("08:00");
    expect(m.basePrice).toBe(1000);
    // Tier sets price to 1500 (member rate). Final is 1500 too, no other steps.
    expect(m.finalPrice).toBe(1500);
    // priceDelta is the tier step's contribution (after - before = 1500 - 1000)
    expect(m.priceDelta).toBeCloseTo(500, 2);

    const step = m.breakdown[m.tierStepIndex];
    expect(step.source).toBe("tier");
    expect(step.detail.tierId).toBe(tier.id);

    const matchedIds = res.body.matches.map((x: { slotId: number }) => x.slotId);
    expect(matchedIds).not.toContain(satAfternoon.id);
    expect(matchedIds).not.toContain(wedSlot.id);
    expect(matchedIds).not.toContain(sunSlot.id);
  });

  it("previews an inactive tier too (with the engine disabled) so admins can sanity-check before publishing", async () => {
    await clearSlotsTiersMods();

    const sat = nextDateForDow(6);
    await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    });

    const [tier] = await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId,
      name: "Draft weekend tier",
      daysOfWeek: [6],
      startTime: "06:00", endTime: "11:00",
      memberType: "any",
      memberRate: "1750", guestRate: "2200",
      priority: 1, isActive: false, // not yet published
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tier.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.matches[0].finalPrice).toBe(1750);
  });

  it("returns 404 when the tier belongs to another org", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/99999999/preview`)
      .send({ days: 7 });
    expect(res.status).toBe(404);
  });

  // Task #1606 — when a tier matches zero (or few) slots, admins still need
  // to know *why*. The preview now returns up to N "near miss" slots that
  // failed exactly one tier condition (or lost to a higher-priority tier),
  // with structured expected/actual values so the UI can spell out the
  // off-by-one DOW, wrong time-window, or "lost to Sunday Premium".
  it("returns near-miss slots with structured failure reasons (DOW + time window + priority loss)", async () => {
    await clearSlotsTiersMods();

    // Saturday afternoon — wrong time window only.
    const sat = nextDateForDow(6);
    const [satAfternoon] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "14:00", capacity: 4,
    }).returning();

    // Wednesday morning — wrong DOW only.
    const wed = nextDateForDow(3);
    const [wedMorning] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: wed, slotTime: "08:00", capacity: 4,
    }).returning();

    // Sunday morning — matches our tier's conditions but loses to a
    // higher-priority Sunday-only tier. This is the priority-loss case
    // the section is specifically designed to surface.
    const sun = nextDateForDow(0);
    const [sunMorning] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sun, slotTime: "08:00", capacity: 4,
    }).returning();

    const [tier] = await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId,
      name: "Weekend mornings",
      daysOfWeek: [0, 6],
      startTime: "06:00", endTime: "11:00",
      memberType: "any",
      memberRate: "1500", guestRate: "2000",
      priority: 1, isActive: true,
    }).returning();

    const [winner] = await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId,
      name: "Sunday premium",
      daysOfWeek: [0],
      startTime: "06:00", endTime: "11:00",
      memberType: "any",
      memberRate: "1800", guestRate: "2500",
      priority: 5, isActive: true,
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tier.id}/preview`)
      .send({ days: 14, courseId });
    expect(res.status, res.text).toBe(200);
    // None of the three seeded slots are matches for *our* tier — preview
    // should be empty…
    expect(res.body.matchCount).toBe(0);
    // …but the structured "why not" reasons should be present.
    expect(Array.isArray(res.body.nearMisses)).toBe(true);
    expect(res.body.nearMisses.length).toBeGreaterThanOrEqual(3);

    type NM = {
      slotId: number;
      failures: Array<{ condition: string; expected: unknown; actual: unknown }>;
    };
    const bySlot = new Map<number, NM>(
      (res.body.nearMisses as NM[]).map(nm => [nm.slotId, nm]),
    );

    const sa = bySlot.get(satAfternoon.id);
    expect(sa, "saturday afternoon should be a near-miss").toBeDefined();
    expect(sa!.failures.length).toBe(1);
    expect(sa!.failures[0].condition).toBe("timeRange");
    expect(sa!.failures[0].expected).toEqual(["06:00", "11:00"]);
    expect(sa!.failures[0].actual).toBe("14:00");

    const wm = bySlot.get(wedMorning.id);
    expect(wm, "wednesday morning should be a near-miss").toBeDefined();
    expect(wm!.failures.length).toBe(1);
    expect(wm!.failures[0].condition).toBe("dayOfWeek");
    expect(wm!.failures[0].expected).toEqual([0, 6]);
    expect(wm!.failures[0].actual).toBe(3);

    // Sunday morning — matches conditions but lost on priority.
    const sm = bySlot.get(sunMorning.id);
    expect(sm, "sunday morning should be a priority-loss near-miss").toBeDefined();
    expect(sm!.failures.length).toBe(1);
    expect(sm!.failures[0].condition).toBe("priorityLoss");
    expect(sm!.failures[0].expected).toBe(1);
    expect(sm!.failures[0].actual).toEqual({
      tierId: winner.id, tierName: "Sunday premium", priority: 5,
    });
  });

  it("respects nearMissLimit and can be disabled with limit=0; junk falls back to default 5", async () => {
    await clearSlotsTiersMods();

    // Seed several wrong-DOW slots so the limit actually clamps something.
    const wed = nextDateForDow(3);
    for (const t of ["07:00", "08:00", "09:00", "10:00"]) {
      await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: wed, slotTime: t, capacity: 4,
      });
    }

    const [tier] = await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId,
      name: "Saturday mornings only",
      daysOfWeek: [6],
      startTime: "06:00", endTime: "11:00",
      memberType: "any",
      memberRate: "1500", guestRate: "2000",
      priority: 1, isActive: true,
    }).returning();

    // Use a 14-day window so the seeded Wed slots are guaranteed to fall
    // inside the preview range regardless of which weekday the test runs on.
    // Limit = 2 — only the first two near-misses come back.
    const limited = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tier.id}/preview`)
      .send({ days: 14, courseId, nearMissLimit: 2 });
    expect(limited.status, limited.text).toBe(200);
    expect(limited.body.nearMissLimit).toBe(2);
    expect(limited.body.nearMisses.length).toBe(2);

    // Limit = 0 — admin opted out, near-miss section disabled entirely.
    const disabled = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tier.id}/preview`)
      .send({ days: 14, courseId, nearMissLimit: 0 });
    expect(disabled.status, disabled.text).toBe(200);
    expect(disabled.body.nearMissLimit).toBe(0);
    expect(disabled.body.nearMisses).toEqual([]);

    // Junk input must fall back to the default of 5 rather than silently
    // disabling near-misses (which would surprise an admin debugging a tier).
    const garbage = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/tiers/${tier.id}/preview`)
      .send({ days: 14, courseId, nearMissLimit: "not-a-number" });
    expect(garbage.status, garbage.text).toBe(200);
    expect(garbage.body.nearMissLimit).toBe(5);
    expect(garbage.body.nearMisses.length).toBeGreaterThan(0);
  });
});

describe("modifier preview — Task #1345", () => {
  it("returns slots whose breakdown includes the modifier (utilisation threshold honoured)", async () => {
    await clearSlotsTiersMods();

    const sat = nextDateForDow(6);

    // Slot at ~75% utilisation (3 of 4 booked) — inside the 50–100% band.
    const [highUtilSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      organizationId: orgId, slotId: highUtilSlot.id, leadUserId: userId,
      partySize: 3, status: "confirmed",
    });

    // Slot at 0% utilisation — below the threshold, should be excluded.
    const [lowUtilSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "10:00", capacity: 4,
    }).returning();

    const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId,
      name: "High demand surge",
      kind: "utilization",
      thresholdMin: "0.5", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "20",
      applyTo: "any",
      priority: 1, isActive: true,
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.modifier.id).toBe(mod.id);
    expect(res.body.matchCount).toBe(1);

    const m = res.body.matches[0];
    expect(m.slotId).toBe(highUtilSlot.id);
    // Base 1000 → +20% = 1200. Modifier step is the 200 contribution.
    expect(m.basePrice).toBe(1000);
    expect(m.finalPrice).toBe(1200);
    expect(m.priceDelta).toBeCloseTo(200, 2);

    const step = m.breakdown[m.modifierStepIndex];
    expect(step.source).toBe("modifier");
    expect(step.detail.modifierId).toBe(mod.id);

    const matchedIds = res.body.matches.map((x: { slotId: number }) => x.slotId);
    expect(matchedIds).not.toContain(lowUtilSlot.id);
  });

  it("previews an inactive modifier too (with the engine disabled) so admins can sanity-check before publishing", async () => {
    await clearSlotsTiersMods();

    const sat = nextDateForDow(6);
    const [slot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      organizationId: orgId, slotId: slot.id, leadUserId: userId,
      partySize: 3, status: "confirmed",
    });

    const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId,
      name: "Draft surge",
      kind: "utilization",
      thresholdMin: "0.5", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "15",
      applyTo: "any",
      priority: 1, isActive: false, // not yet published
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.matches[0].priceDelta).toBeCloseTo(150, 2);
  });

  it("returns 404 when the modifier belongs to another org", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/99999999/preview`)
      .send({ days: 7 });
    expect(res.status).toBe(404);
  });

  // Task #1606 — modifier near-miss section. When the modifier matches few
  // slots, surface the closest single-condition near-misses so admins can
  // see "occupancy too low" / "lead time too short" / "wrong member type"
  // at a glance instead of guessing.
  it("returns near-miss slots with structured failure reasons (utilisation below + applyTo)", async () => {
    await clearSlotsTiersMods();

    // Slot at 25% utilisation (1 of 4 booked) — *just* below the 50% min.
    const sat = nextDateForDow(6);
    const [lowUtilSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      organizationId: orgId, slotId: lowUtilSlot.id, leadUserId: userId,
      partySize: 1, status: "confirmed",
    });

    // Slot at 75% utilisation (3 of 4 booked) — inside the threshold band,
    // so it would normally match. We'll preview as a *guest* to trip the
    // applyTo filter (modifier is members-only).
    const [memberOnlySlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "10:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      organizationId: orgId, slotId: memberOnlySlot.id, leadUserId: userId,
      partySize: 3, status: "confirmed",
    });

    const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId,
      name: "Members surge",
      kind: "utilization",
      thresholdMin: "0.5", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "20",
      applyTo: "member",
      priority: 1, isActive: true,
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
      .send({ days: 7, courseId, memberType: "guest" });
    expect(res.status, res.text).toBe(200);
    expect(res.body.matchCount).toBe(0);
    expect(Array.isArray(res.body.nearMisses)).toBe(true);

    type NM = {
      slotId: number;
      failures: Array<{ condition: string; expected: unknown; actual: unknown }>;
    };
    const bySlot = new Map<number, NM>(
      (res.body.nearMisses as NM[]).map(nm => [nm.slotId, nm]),
    );

    // Low-utilisation slot — also fails applyTo when previewed as guest, so
    // it has 2 failures and is *excluded* from the single-failure-only
    // near-miss section. This guards the "exactly one failure" contract.
    expect(bySlot.has(lowUtilSlot.id)).toBe(false);

    // The 75%-occupied slot fails *only* applyTo (utilisation is in band),
    // so it should appear with the applyTo reason.
    const memOnly = bySlot.get(memberOnlySlot.id);
    expect(memOnly, "member-only slot should be a near-miss for guest preview").toBeDefined();
    expect(memOnly!.failures.length).toBe(1);
    expect(memOnly!.failures[0].condition).toBe("applyTo");
    expect(memOnly!.failures[0].expected).toBe("member");
    expect(memOnly!.failures[0].actual).toBe("guest");
  });

  it("surfaces utilisation threshold near-miss with the under-min reason and the actual occupancy", async () => {
    await clearSlotsTiersMods();

    const sat = nextDateForDow(6);
    // 25% occupancy — just below the 50% min. Single-failure near-miss.
    const [slot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    }).returning();
    await db.insert(teeBookingsTable).values({
      organizationId: orgId, slotId: slot.id, leadUserId: userId,
      partySize: 1, status: "confirmed",
    });

    const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId,
      name: "High demand surge",
      kind: "utilization",
      thresholdMin: "0.5", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "20",
      applyTo: "any",
      priority: 1, isActive: true,
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.matchCount).toBe(0);

    const nm = (res.body.nearMisses as Array<{
      slotId: number;
      failures: Array<{ condition: string; expected: number; actual: number }>;
    }>).find(x => x.slotId === slot.id);
    expect(nm, "low-utilisation slot should be a near-miss").toBeDefined();
    expect(nm!.failures.length).toBe(1);
    expect(nm!.failures[0].condition).toBe("utilizationBelowMin");
    expect(nm!.failures[0].expected).toBeCloseTo(0.5, 4);
    expect(nm!.failures[0].actual).toBeCloseTo(0.25, 4);
  });

  it("respects nearMissLimit and disables with limit=0; junk falls back to default 5", async () => {
    await clearSlotsTiersMods();

    // Seed several below-threshold slots so the limit clamps something.
    const sat = nextDateForDow(6);
    for (const t of ["07:00", "08:00", "09:00", "10:00"]) {
      const [s] = await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: t, capacity: 4,
      }).returning();
      await db.insert(teeBookingsTable).values({
        organizationId: orgId, slotId: s.id, leadUserId: userId,
        partySize: 1, status: "confirmed",
      });
    }

    const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId,
      name: "High demand surge",
      kind: "utilization",
      thresholdMin: "0.5", thresholdMax: "1.01",
      adjustmentType: "percent", adjustmentValue: "20",
      applyTo: "any",
      priority: 1, isActive: true,
    }).returning();

    const limited = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
      .send({ days: 7, courseId, nearMissLimit: 2 });
    expect(limited.status, limited.text).toBe(200);
    expect(limited.body.nearMissLimit).toBe(2);
    expect(limited.body.nearMisses.length).toBe(2);

    const disabled = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
      .send({ days: 7, courseId, nearMissLimit: 0 });
    expect(disabled.status, disabled.text).toBe(200);
    expect(disabled.body.nearMissLimit).toBe(0);
    expect(disabled.body.nearMisses).toEqual([]);

    const garbage = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
      .send({ days: 7, courseId, nearMissLimit: "not-a-number" });
    expect(garbage.status, garbage.text).toBe(200);
    expect(garbage.body.nearMissLimit).toBe(5);
    expect(garbage.body.nearMisses.length).toBeGreaterThan(0);
  });

  // Task #1607 — weather modifiers can't fire on real tee slots in preview
  // because slots don't carry a weather condition until the live engine
  // attaches one. The endpoint accepts an admin-supplied `simulateWeather`
  // (and falls back to the modifier's own configured condition) so admins
  // can validate "rain discount"-style modifiers end-to-end before publish.
  describe("weather modifier simulation — Task #1607", () => {
    it("matches all upcoming open slots when the modifier's own condition is used as the default simulation", async () => {
      await clearSlotsTiersMods();

      const sat = nextDateForDow(6);
      const [slot] = await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      }).returning();

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      // No `simulateWeather` in the body — backend should default to the
      // modifier's own configured condition ("rain") so admins see matches.
      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId });
      expect(res.status, res.text).toBe(200);
      expect(res.body.simulatedWeather).toBe("rain");
      expect(res.body.matchCount).toBe(1);

      const m = res.body.matches[0];
      expect(m.slotId).toBe(slot.id);
      // Base 1000 → -15% = 850. Modifier step contributes -150.
      expect(m.basePrice).toBe(1000);
      expect(m.finalPrice).toBe(850);
      expect(m.priceDelta).toBeCloseTo(-150, 2);

      const step = m.breakdown[m.modifierStepIndex];
      expect(step.source).toBe("modifier");
      expect(step.detail.modifierId).toBe(mod.id);
    });

    it("honours an admin-supplied simulateWeather override (case-insensitive match against modifier condition)", async () => {
      await clearSlotsTiersMods();

      const sat = nextDateForDow(6);
      await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      });

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      // Admin overrides the simulated condition with the same logical value
      // in different case + whitespace — engine matches case-insensitively
      // and the trimmed value is echoed back to the UI.
      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId, simulateWeather: "  RAIN  " });
      expect(res.status, res.text).toBe(200);
      expect(res.body.simulatedWeather).toBe("RAIN");
      expect(res.body.matchCount).toBe(1);
    });

    it("returns no matches when admin clears the simulation (empty string opts out)", async () => {
      await clearSlotsTiersMods();

      const sat = nextDateForDow(6);
      await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      });

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      // Empty string explicitly opts out of any simulation, so the realistic
      // "no weather data attached" preview returns zero matches — useful for
      // admins who want to confirm the live engine would skip the modifier
      // until weather is actually observed.
      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId, simulateWeather: "" });
      expect(res.status, res.text).toBe(200);
      expect(res.body.simulatedWeather).toBeNull();
      expect(res.body.matchCount).toBe(0);
    });

    it("returns no matches when simulated condition doesn't match the modifier's condition", async () => {
      await clearSlotsTiersMods();

      const sat = nextDateForDow(6);
      await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      });

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId, simulateWeather: "clear" });
      expect(res.status, res.text).toBe(200);
      expect(res.body.simulatedWeather).toBe("clear");
      expect(res.body.matchCount).toBe(0);
    });

    // Task #1995 — when the simulated condition is wired through to the
    // near-miss evaluator, weather modifiers can surface real
    // expected-vs-actual mismatches ("expected rain, slot is clear")
    // instead of always reporting "weather data missing". This is the
    // signal admins actually want when debugging weather pricing rules.
    it("surfaces a weatherMismatch near-miss with the real expected vs. simulated condition", async () => {
      await clearSlotsTiersMods();

      const sat = nextDateForDow(6);
      const [slot] = await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      }).returning();

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      // Admin previews the rain modifier against a "clear" forecast — the
      // modifier shouldn't fire (so matchCount=0), but the near-miss row
      // should explain why with `weatherMismatch` carrying the configured
      // expected value and the simulated actual value.
      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId, simulateWeather: "clear" });
      expect(res.status, res.text).toBe(200);
      expect(res.body.simulatedWeather).toBe("clear");
      expect(res.body.matchCount).toBe(0);

      type NM = {
        slotId: number;
        failures: Array<{ condition: string; expected: unknown; actual: unknown }>;
      };
      const nm = (res.body.nearMisses as NM[]).find(x => x.slotId === slot.id);
      expect(nm, "clear-day slot should be a weatherMismatch near-miss").toBeDefined();
      expect(nm!.failures.length).toBe(1);
      expect(nm!.failures[0].condition).toBe("weatherMismatch");
      expect(nm!.failures[0].expected).toBe("rain");
      expect(nm!.failures[0].actual).toBe("clear");
    });

    // Task #1995 — when the admin opts out of simulation entirely (empty
    // string → null), the near-miss section should still report the
    // realistic "no forecast attached" case via `weatherMissing`. This is
    // the legacy behaviour we kept after wiring `simulatedWeather` through
    // — only mismatches get upgraded to the structured expected-vs-actual
    // form; null inputs still flag as missing.
    it("still reports weatherMissing as a near-miss when the admin opts out of simulation", async () => {
      await clearSlotsTiersMods();

      const sat = nextDateForDow(6);
      const [slot] = await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      }).returning();

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId, simulateWeather: "" });
      expect(res.status, res.text).toBe(200);
      expect(res.body.simulatedWeather).toBeNull();
      expect(res.body.matchCount).toBe(0);

      type NM = {
        slotId: number;
        failures: Array<{ condition: string; expected: unknown; actual: unknown }>;
      };
      const nm = (res.body.nearMisses as NM[]).find(x => x.slotId === slot.id);
      expect(nm, "no-forecast slot should be a weatherMissing near-miss").toBeDefined();
      expect(nm!.failures.length).toBe(1);
      expect(nm!.failures[0].condition).toBe("weatherMissing");
      expect(nm!.failures[0].expected).toBe("rain");
      expect(nm!.failures[0].actual).toBeNull();
    });
  });

  // Task #1994 — forecast mode: when the admin opts in (`useForecast: true`),
  // the preview pulls Open-Meteo's daily forecast for every distinct course
  // in the slot list and evaluates each slot under *its own day's* expected
  // condition. The endpoint returns a per-course forecast strip so the UI
  // can render "Mon=rain, Tue=clear, …" alongside the matches.
  describe("forecast-driven weather preview — Task #1994", () => {
    let forecastCourseId: number;
    let realFetch: typeof fetch;

    beforeAll(async () => {
      // A second course with lat/lng so getDailyForecast has somewhere to
      // call — the original `courseId` row deliberately omits coordinates
      // so we can test the "no lat/lng → forecast unavailable" fallback
      // independently in another test.
      const [c] = await db.insert(coursesTable).values({
        organizationId: orgId,
        name: "Forecast Course",
        slug: `forecast-course-${stamp}`,
        // Use a lat/lng that stringifies uniquely to avoid colliding with
        // the module-level forecast cache between test runs in the same
        // process. The cache key is `lat.toFixed(2),lng.toFixed(2),days`.
        latitude: "12.34",
        longitude: "56.78",
      }).returning({ id: coursesTable.id });
      forecastCourseId = c.id;
    });

    beforeEach(() => {
      realFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      vi.restoreAllMocks();
    });

    /**
     * Stub `globalThis.fetch` so every Open-Meteo `daily=…` URL returns the
     * provided `code` for the next `days` days starting today. Other URLs
     * are passed through to the real fetch (in case the test app needs to
     * make any unrelated network calls — none currently do, but this keeps
     * the stub safely scoped).
     */
    function stubForecast(code: number, days = 7) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const times: string[] = [];
      const codes: number[] = [];
      for (let i = 0; i < days; i++) {
        const d = new Date(today); d.setDate(d.getDate() + i);
        times.push(d.toISOString().slice(0, 10));
        codes.push(code);
      }
      const body = {
        daily: {
          time: times,
          weather_code: codes,
          precipitation_sum: codes.map(() => 1.2),
          wind_speed_10m_max: codes.map(() => 9),
          temperature_2m_max: codes.map(() => 28),
          temperature_2m_min: codes.map(() => 18),
        },
      };
      const stub = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("api.open-meteo.com/v1/forecast") && url.includes("daily=")) {
          return new Response(JSON.stringify(body), { status: 200 });
        }
        return realFetch(input);
      });
      globalThis.fetch = stub as unknown as typeof fetch;
      return stub;
    }

    it("evaluates each slot under its own day's forecast condition and returns a per-course forecast strip", async () => {
      await clearSlotsTiersMods();

      // WMO code 63 → "rain" condition bucket. With every forecast day = rain,
      // a "rain discount" modifier should fire on every upcoming slot.
      const stub = stubForecast(63);

      const sat = nextDateForDow(6);
      const [slot] = await db.insert(courseTeeSlotTable).values({
        courseId: forecastCourseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      }).returning();

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Forecast rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId: forecastCourseId, useForecast: true });
      expect(res.status, res.text).toBe(200);

      // Forecast block is populated — the UI uses this to render the strip.
      expect(res.body.forecast).toBeTruthy();
      expect(res.body.forecast.enabled).toBe(true);
      expect(res.body.forecast.unavailable).toBe(false);
      expect(res.body.forecast.source).toBe("open-meteo");
      expect(res.body.forecast.byCourse).toHaveLength(1);
      expect(res.body.forecast.byCourse[0].courseId).toBe(forecastCourseId);
      expect(res.body.forecast.byCourse[0].days.length).toBeGreaterThan(0);
      expect(res.body.forecast.byCourse[0].days[0].condition).toBe("rain");

      // simulatedWeather is null in forecast mode — per-day conditions live
      // in the forecast strip instead of a single global value.
      expect(res.body.simulatedWeather).toBeNull();

      // Slot matched under the day's forecast → modifier fires.
      expect(res.body.matchCount).toBe(1);
      const m = res.body.matches[0];
      expect(m.slotId).toBe(slot.id);
      expect(m.weatherConditionUsed).toBe("rain");

      // Open-Meteo was actually called (caching might absorb later calls
      // in the same suite, but the first run hits the network).
      expect(stub).toHaveBeenCalled();
    });

    it("does NOT match when the slot's day forecast differs from the modifier's required condition", async () => {
      await clearSlotsTiersMods();

      // Use a different lat/lng (via a different course) so the forecast
      // cache doesn't return a stale "rain" result from the previous test.
      const [clearCourse] = await db.insert(coursesTable).values({
        organizationId: orgId,
        name: "Clear Forecast Course",
        slug: `forecast-clear-course-${stamp}`,
        latitude: "23.45",
        longitude: "67.89",
      }).returning({ id: coursesTable.id });

      // WMO code 0 → "clear" — modifier wants "rain" so nothing should fire.
      stubForecast(0);

      const sat = nextDateForDow(6);
      await db.insert(courseTeeSlotTable).values({
        courseId: clearCourse.id, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      });

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Forecast rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId: clearCourse.id, useForecast: true });
      expect(res.status, res.text).toBe(200);
      expect(res.body.forecast.enabled).toBe(true);
      expect(res.body.forecast.unavailable).toBe(false);
      expect(res.body.forecast.byCourse[0].days[0].condition).toBe("clear");
      expect(res.body.matchCount).toBe(0);
    });

    it("falls back to the modifier's own condition when no course in the preview has lat/lng", async () => {
      await clearSlotsTiersMods();

      // The original `courseId` row from the suite-level setup has no
      // lat/lng — so forecast mode can't reach Open-Meteo and must report
      // unavailable + fall back to the modifier's own condition so the
      // admin still sees a useful preview.
      stubForecast(63);

      const sat = nextDateForDow(6);
      await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      });

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId, useForecast: true });
      expect(res.status, res.text).toBe(200);
      expect(res.body.forecast).toBeTruthy();
      // `enabled` reflects "request honoured" (we entered forecast mode) —
      // `unavailable` is the orthogonal "but no data came back" signal so
      // the UI can show a reason banner while still showing fallback matches.
      expect(res.body.forecast.enabled).toBe(true);
      expect(res.body.forecast.unavailable).toBe(true);
      expect(res.body.forecast.reason).toMatch(/lat\/lng/i);
      // Fallback uses the modifier's own configured condition so admins
      // still get matches when the upstream service can't help.
      expect(res.body.simulatedWeather).toBe("rain");
      expect(res.body.matchCount).toBe(1);
    });

    it("an explicit simulateWeather override beats useForecast (admin override always wins)", async () => {
      await clearSlotsTiersMods();

      // Stub returns rain — but the admin's override says "clear", which
      // should win. forecast.enabled must reflect that we did NOT enter
      // forecast mode despite the request flag.
      stubForecast(63);

      const sat = nextDateForDow(6);
      await db.insert(courseTeeSlotTable).values({
        courseId: forecastCourseId, organizationId: orgId,
        slotDate: sat, slotTime: "08:00", capacity: 4,
      });

      const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
        organizationId: orgId,
        name: "Rain discount",
        kind: "weather",
        weatherCondition: "rain",
        adjustmentType: "percent", adjustmentValue: "-15",
        applyTo: "any",
        priority: 1, isActive: true,
      }).returning();

      const res = await request(app)
        .post(`/api/organizations/${orgId}/tee-pricing/modifiers/${mod.id}/preview`)
        .send({ days: 7, courseId: forecastCourseId, useForecast: true, simulateWeather: "clear" });
      expect(res.status, res.text).toBe(200);
      expect(res.body.simulatedWeather).toBe("clear");
      // forecast block reflects "requested but not active" (override won).
      expect(res.body.forecast).toBeTruthy();
      expect(res.body.forecast.enabled).toBe(false);
      // Modifier wants rain, override is clear → no match.
      expect(res.body.matchCount).toBe(0);
    });
  });
});
