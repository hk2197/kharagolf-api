/**
 * Tests for the rule preview endpoint — Task #1163.
 *
 * Verifies `POST /organizations/:orgId/tee-pricing/rules/:id/preview`:
 *   - Returns the upcoming open slots over the next 7 days that would
 *     trigger a given rule, with the matching `rule` step located via
 *     `ruleStepIndex` so the UI can highlight it.
 *   - Honours the rule's day-of-week + time-window conditions (off-by-one
 *     and time-zone slip-ups become visible because non-matching slots
 *     are excluded).
 *   - Lets admins preview an INACTIVE rule (otherwise they can't sanity-
 *     check before flipping the switch).
 *   - 404s when the rule belongs to another org.
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
  teePricingRulesTable,
  teeDynamicPricingRulesTable,
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
    name: `RulePreviewTest_${stamp}`,
    slug: `rule-preview-test-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [user] = await db.insert(appUsersTable).values({
    replitUserId: `rule-preview-${stamp}`,
    username: `rule_preview_${stamp}`,
    email: `rule_preview_${stamp}@example.com`,
    displayName: "Rule Preview Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  userId = user.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId, userId, role: "org_admin",
  });

  const [course] = await db.insert(coursesTable).values({
    organizationId: orgId,
    name: "Rule Preview Course",
    slug: `rule-preview-course-${stamp}`,
  }).returning({ id: coursesTable.id });
  courseId = course.id;

  await db.insert(teePricingRulesTable).values({
    organizationId: orgId, memberRate: "1000", guestRate: "1500",
  });

  // Engine doesn't need to be enabled — rules apply on the dyn-disabled
  // fast path too. Leaving disabled keeps the breakdown shape minimal.
  await db.insert(teeDynamicPricingConfigTable).values({
    organizationId: orgId, enabled: false,
    priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
  });

  admin = {
    id: userId,
    username: `rule_preview_${stamp}`,
    displayName: "Rule Preview Admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  if (userId) await db.delete(appUsersTable).where(eq(appUsersTable.id, userId));
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

async function clearSlotsAndRules() {
  await db.delete(courseTeeSlotTable).where(eq(courseTeeSlotTable.organizationId, orgId));
  await db.delete(teeDynamicPricingRulesTable).where(eq(teeDynamicPricingRulesTable.organizationId, orgId));
}

describe("rule preview — Task #1163", () => {
  it("returns slots that match the day-of-week + time window and skips others", async () => {
    await clearSlotsAndRules();

    // Saturday slot inside the morning window — should match.
    const sat = nextDateForDow(6);
    const [matchSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    }).returning();

    // Saturday slot OUTSIDE the morning window — should be excluded.
    const [satAfternoon] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "14:00", capacity: 4,
    }).returning();

    // Wednesday slot — wrong DOW — should be excluded.
    const wed = nextDateForDow(3);
    const [wedSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: wed, slotTime: "08:00", capacity: 4,
    }).returning();

    // Blocked slot on Saturday — should be excluded even though it'd otherwise match.
    const [closedSlot] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "09:00", capacity: 4, status: "blocked",
    }).returning();

    const [rule] = await db.insert(teeDynamicPricingRulesTable).values({
      organizationId: orgId,
      name: "Weekend mornings +20%",
      conditions: { dayOfWeek: [0, 6], timeRange: ["06:00", "11:00"] },
      priceDeltaPct: "20",
      priority: 1,
      active: true,
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/${rule.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.rule.id).toBe(rule.id);
    expect(res.body.matchCount).toBe(1);

    const m = res.body.matches[0];
    expect(m.slotId).toBe(matchSlot.id);
    expect(m.slotTime).toBe("08:00");
    // Base 1000 → 1200 (+20%); priceDelta is the rule's contribution.
    expect(m.basePrice).toBe(1000);
    expect(m.finalPrice).toBe(1200);
    expect(m.priceDelta).toBeCloseTo(200, 2);

    // The breakdown step at ruleStepIndex must be the rule we tested.
    const step = m.breakdown[m.ruleStepIndex];
    expect(step.source).toBe("rule");
    expect(step.detail.ruleId).toBe(rule.id);

    // Make sure the excluded slots weren't smuggled in.
    const matchedIds = res.body.matches.map((x: { slotId: number }) => x.slotId);
    expect(matchedIds).not.toContain(satAfternoon.id);
    expect(matchedIds).not.toContain(wedSlot.id);
    expect(matchedIds).not.toContain(closedSlot.id);
  });

  it("previews an inactive rule too (so admins can sanity-check before publishing)", async () => {
    await clearSlotsAndRules();

    const sat = nextDateForDow(6);
    await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "08:00", capacity: 4,
    });

    const [rule] = await db.insert(teeDynamicPricingRulesTable).values({
      organizationId: orgId,
      name: "Draft weekend bump",
      conditions: { dayOfWeek: [6], timeRange: ["06:00", "11:00"] },
      priceDeltaPct: "15",
      priority: 1,
      active: false, // not yet published
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/${rule.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.matchCount).toBe(1);
    expect(res.body.matches[0].priceDelta).toBeCloseTo(150, 2);
  });

  it("returns 404 when the rule belongs to another org", async () => {
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/99999999/preview`)
      .send({ days: 7 });
    expect(res.status).toBe(404);
  });

  // Task #1344 — when a rule matches zero (or few) slots admins still need
  // to know *why*. The preview now also returns up to N "near miss" slots
  // that failed exactly one condition, with structured expected/actual
  // values so the UI can explain the off-by-one DOW or wrong time-window.
  it("returns near-miss slots with the single failing condition + expected/actual", async () => {
    await clearSlotsAndRules();

    // The rule below targets Saturday mornings 06:00–11:00. We seed three
    // upcoming open slots that each fall short on exactly one dimension so
    // we can assert the structured failure reason for each.
    const sat = nextDateForDow(6);
    const wed = nextDateForDow(3);
    const fri = nextDateForDow(5);

    // Saturday afternoon — wrong time window only.
    const [satAfternoon] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: sat, slotTime: "14:00", capacity: 4,
    }).returning();

    // Wednesday morning — wrong DOW only.
    const [wedMorning] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: wed, slotTime: "08:00", capacity: 4,
    }).returning();

    // Friday morning — wrong DOW only (a second wrong-DOW slot to confirm
    // we collect more than one near-miss).
    const [friMorning] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: fri, slotTime: "08:00", capacity: 4,
    }).returning();

    const [rule] = await db.insert(teeDynamicPricingRulesTable).values({
      organizationId: orgId,
      name: "Saturday mornings only",
      conditions: { dayOfWeek: [6], timeRange: ["06:00", "11:00"] },
      priceDeltaPct: "20",
      priority: 1,
      active: true,
    }).returning();

    // 14-day window guarantees all three seeded DOWs land in the preview
    // regardless of which weekday the test runs on.
    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/${rule.id}/preview`)
      .send({ days: 14, courseId });
    expect(res.status, res.text).toBe(200);
    // None of the three seeded slots fully match — preview should be empty…
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
    expect(wm!.failures[0].expected).toEqual([6]);
    // 3 = Wednesday in Date#getDay terms — the kind of off-by-one this
    // section is designed to surface.
    expect(wm!.failures[0].actual).toBe(3);

    const fm = bySlot.get(friMorning.id);
    expect(fm, "friday morning should be a near-miss").toBeDefined();
    expect(fm!.failures.length).toBe(1);
    expect(fm!.failures[0].condition).toBe("dayOfWeek");
    expect(fm!.failures[0].actual).toBe(5);
  });

  it("excludes slots that fail two or more conditions from near-misses", async () => {
    await clearSlotsAndRules();

    // Rule wants Saturday mornings. The slot below is on Wednesday afternoon
    // — wrong on BOTH DOW and timeRange — so it must NOT appear as a near-
    // miss; near-misses are reserved for single-condition failures so the
    // section stays signal-rich and points at the most likely culprit.
    const wed = nextDateForDow(3);
    const [wedAfternoon] = await db.insert(courseTeeSlotTable).values({
      courseId, organizationId: orgId,
      slotDate: wed, slotTime: "14:00", capacity: 4,
    }).returning();

    const [rule] = await db.insert(teeDynamicPricingRulesTable).values({
      organizationId: orgId,
      name: "Saturday mornings only",
      conditions: { dayOfWeek: [6], timeRange: ["06:00", "11:00"] },
      priceDeltaPct: "20",
      priority: 1,
      active: true,
    }).returning();

    const res = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/${rule.id}/preview`)
      .send({ days: 7, courseId });
    expect(res.status, res.text).toBe(200);
    expect(res.body.matchCount).toBe(0);
    const ids = (res.body.nearMisses as Array<{ slotId: number }>).map(n => n.slotId);
    expect(ids).not.toContain(wedAfternoon.id);
  });

  it("respects nearMissLimit and can be disabled with limit=0", async () => {
    await clearSlotsAndRules();

    // Seed several wrong-DOW slots so the limit actually clamps something.
    // Use a 14-day horizon below: when this test runs on a Wednesday,
    // nextDateForDow(3) lands exactly 7 days away, which the preview
    // endpoint's `slot_date < today + days` upper bound would exclude with
    // the default 7-day horizon (causing flaky 0-near-miss results).
    const wed = nextDateForDow(3);
    for (const t of ["07:00", "08:00", "09:00", "10:00"]) {
      await db.insert(courseTeeSlotTable).values({
        courseId, organizationId: orgId,
        slotDate: wed, slotTime: t, capacity: 4,
      });
    }

    const [rule] = await db.insert(teeDynamicPricingRulesTable).values({
      organizationId: orgId,
      name: "Saturday mornings only",
      conditions: { dayOfWeek: [6], timeRange: ["06:00", "11:00"] },
      priceDeltaPct: "20",
      priority: 1,
      active: true,
    }).returning();

    // Limit = 2 — only the first two near-misses should come back.
    const limited = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/${rule.id}/preview`)
      .send({ days: 14, courseId, nearMissLimit: 2 });
    expect(limited.status, limited.text).toBe(200);
    expect(limited.body.nearMissLimit).toBe(2);
    expect(limited.body.nearMisses.length).toBe(2);

    // Limit = 0 — admin opted out, near-miss section disabled entirely.
    const disabled = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/${rule.id}/preview`)
      .send({ days: 14, courseId, nearMissLimit: 0 });
    expect(disabled.status, disabled.text).toBe(200);
    expect(disabled.body.nearMissLimit).toBe(0);
    expect(disabled.body.nearMisses).toEqual([]);

    // Junk input (non-numeric string) must fall back to the default of 5
    // rather than silently disabling near-misses (which would surprise an
    // admin debugging a rule).
    const garbage = await request(app)
      .post(`/api/organizations/${orgId}/tee-pricing/rules/${rule.id}/preview`)
      .send({ days: 14, courseId, nearMissLimit: "not-a-number" });
    expect(garbage.status, garbage.text).toBe(200);
    expect(garbage.body.nearMissLimit).toBe(5);
    expect(garbage.body.nearMisses.length).toBeGreaterThan(0);
  });
});
