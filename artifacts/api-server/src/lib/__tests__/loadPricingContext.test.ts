/**
 * DB-backed tests for `loadPricingContext` (Task #1596).
 *
 * Task #1338 covered the pure in-memory price resolver
 * `resolveEffectivePriceWith`, but the loader that actually pulls tiers,
 * modifiers, rules, the dyn-pricing config, and the legacy pricing-rules
 * row out of Postgres for one org was still uncovered. A schema rename,
 * a missing column default, or a stray `active=false` filter could
 * silently strip rows and the resolver would happily return the wrong
 * price. These tests pin down:
 *
 *   1. The full shape returned for one org (every section populated with
 *      the values that were actually seeded).
 *   2. Inactive tiers / inactive modifiers / inactive rules are filtered
 *      out by the loader before they reach the resolver.
 *   3. Organization scoping — rows belonging to a different org are
 *      never returned.
 *   4. The legacy currency default (`"INR"`) and the per-segment
 *      elasticity defaults (`-0.20` / `-0.70`) fall in correctly when
 *      the underlying columns are null / not set on insert.
 */
import { describe, it, expect, afterAll } from "vitest";
import {
  db,
  organizationsTable,
  teePricingRulesTable,
  teeDynamicPricingTiersTable,
  teeDynamicPricingModifiersTable,
  teeDynamicPricingConfigTable,
  teeDynamicPricingRulesTable,
} from "@workspace/db";
import { inArray } from "drizzle-orm";
import { loadPricingContext } from "../dynamicPricing.js";

const createdOrgIds: number[] = [];

async function seedOrg(label: string): Promise<number> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `LoadPricingCtx_${label}_${stamp}`,
    slug: `load-pricing-ctx-${label}-${stamp}`,
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

afterAll(async () => {
  // organizationsTable cascades to all of the pricing children
  // (teePricingRulesTable, teeDynamicPricing{Tiers,Modifiers,Config,Rules}Table
  // all FK organization_id ON DELETE CASCADE), so deleting the orgs is enough.
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

// ── 1. Full happy-path shape ───────────────────────────────────────────────

describe("loadPricingContext — populated org returns the expected shape", () => {
  it("loads legacy rules, dyn config, tiers, modifiers, and rules with the seeded values", async () => {
    const orgId = await seedOrg("happy");

    await db.insert(teePricingRulesTable).values({
      organizationId: orgId,
      memberRate: "1000.00",
      guestRate: "1500.00",
      twilightStartTime: "17:30",
      twilightMemberRate: "800.00",
      twilightGuestRate: "1200.00",
    });

    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId,
      enabled: true,
      priceFloorPct: "0.60",
      priceCeilingPct: "1.80",
      dealBadgeThresholdPct: "0.90",
      defaultMemberElasticity: "-0.30",
      defaultGuestElasticity: "-0.80",
    });

    await db.insert(teeDynamicPricingTiersTable).values({
      organizationId: orgId,
      name: "Weekend morning",
      daysOfWeek: [0, 6],
      startTime: "06:00",
      endTime: "11:00",
      seasonStart: "04-01",
      seasonEnd: "06-30",
      memberType: "guest",
      memberRate: "0.00",
      guestRate: "1750.00",
      priority: 5,
    });

    await db.insert(teeDynamicPricingModifiersTable).values({
      organizationId: orgId,
      name: "High utilisation",
      kind: "utilization",
      thresholdMin: "0.75",
      thresholdMax: "1.00",
      adjustmentType: "percent",
      adjustmentValue: "15.00",
      applyTo: "any",
      priority: 3,
    });

    await db.insert(teeDynamicPricingRulesTable).values({
      organizationId: orgId,
      name: "Mid-week +10%",
      conditions: { dayOfWeek: [2, 3, 4], occupancyMin: 0.5 },
      priceDeltaPct: "10.00",
      priority: 7,
      active: true,
    });

    const ctx = await loadPricingContext(orgId);

    // Legacy rules
    expect(ctx.legacyRules).not.toBeNull();
    expect(ctx.legacyRules?.memberRate).toBe("1000.00");
    expect(ctx.legacyRules?.guestRate).toBe("1500.00");
    expect(ctx.legacyRules?.twilightStartTime).toBe("17:30");
    expect(ctx.legacyRules?.twilightMemberRate).toBe("800.00");
    expect(ctx.legacyRules?.twilightGuestRate).toBe("1200.00");
    // The currency column does not exist on teePricingRulesTable yet, so the
    // loader's TS fallback to "INR" should kick in.
    expect(ctx.legacyRules?.currency).toBe("INR");

    // Config
    expect(ctx.config).not.toBeNull();
    expect(ctx.config?.enabled).toBe(true);
    expect(ctx.config?.priceFloorPct).toBe("0.60");
    expect(ctx.config?.priceCeilingPct).toBe("1.80");
    expect(ctx.config?.dealBadgeThresholdPct).toBe("0.90");
    expect(ctx.config?.defaultMemberElasticity).toBe("-0.30");
    expect(ctx.config?.defaultGuestElasticity).toBe("-0.80");

    // Tiers
    expect(ctx.tiers).toHaveLength(1);
    const [tier] = ctx.tiers;
    expect(tier.name).toBe("Weekend morning");
    expect(tier.daysOfWeek).toEqual([0, 6]);
    expect(tier.startTime).toBe("06:00");
    expect(tier.endTime).toBe("11:00");
    expect(tier.seasonStart).toBe("04-01");
    expect(tier.seasonEnd).toBe("06-30");
    expect(tier.memberType).toBe("guest");
    expect(tier.memberRate).toBe("0.00");
    expect(tier.guestRate).toBe("1750.00");
    expect(tier.priority).toBe(5);
    expect(tier.courseId).toBeNull();

    // Modifiers
    expect(ctx.modifiers).toHaveLength(1);
    const [mod] = ctx.modifiers;
    expect(mod.name).toBe("High utilisation");
    expect(mod.kind).toBe("utilization");
    expect(mod.thresholdMin).toBe("0.75");
    expect(mod.thresholdMax).toBe("1.00");
    expect(mod.adjustmentType).toBe("percent");
    expect(mod.adjustmentValue).toBe("15.00");
    expect(mod.applyTo).toBe("any");
    expect(mod.priority).toBe(3);
    expect(mod.courseId).toBeNull();

    // Rules
    expect(ctx.rules).toHaveLength(1);
    const [rule] = ctx.rules;
    expect(rule.name).toBe("Mid-week +10%");
    expect(rule.conditions).toEqual({ dayOfWeek: [2, 3, 4], occupancyMin: 0.5 });
    expect(rule.priceDeltaPct).toBe("10.00");
    expect(rule.priority).toBe(7);
    expect(rule.active).toBe(true);
  });

  it("returns null sections when no legacy-rules row and no dyn-config row exist for the org", async () => {
    const orgId = await seedOrg("empty");
    const ctx = await loadPricingContext(orgId);
    expect(ctx.legacyRules).toBeNull();
    expect(ctx.config).toBeNull();
    expect(ctx.tiers).toEqual([]);
    expect(ctx.modifiers).toEqual([]);
    expect(ctx.rules).toEqual([]);
  });
});

// ── 2. Inactive rows are filtered out ──────────────────────────────────────

describe("loadPricingContext — inactive rows are filtered out", () => {
  it("hides isActive=false tiers, isActive=false modifiers, and active=false rules", async () => {
    const orgId = await seedOrg("inactive");

    // Two tiers: one active, one inactive — only the active one should
    // come through.
    await db.insert(teeDynamicPricingTiersTable).values([
      {
        organizationId: orgId, name: "Active tier",
        daysOfWeek: [3], memberType: "any",
        memberRate: "100.00", guestRate: "150.00", priority: 1,
        isActive: true,
      },
      {
        organizationId: orgId, name: "Inactive tier",
        daysOfWeek: [3], memberType: "any",
        memberRate: "100.00", guestRate: "150.00", priority: 1,
        isActive: false,
      },
    ]);

    await db.insert(teeDynamicPricingModifiersTable).values([
      {
        organizationId: orgId, name: "Active modifier",
        kind: "utilization", adjustmentType: "percent", adjustmentValue: "10.00",
        applyTo: "any", priority: 1, isActive: true,
      },
      {
        organizationId: orgId, name: "Inactive modifier",
        kind: "utilization", adjustmentType: "percent", adjustmentValue: "10.00",
        applyTo: "any", priority: 1, isActive: false,
      },
    ]);

    await db.insert(teeDynamicPricingRulesTable).values([
      {
        organizationId: orgId, name: "Active rule",
        priceDeltaPct: "5.00", priority: 1, active: true,
      },
      {
        organizationId: orgId, name: "Inactive rule",
        priceDeltaPct: "5.00", priority: 1, active: false,
      },
    ]);

    const ctx = await loadPricingContext(orgId);

    expect(ctx.tiers.map(t => t.name)).toEqual(["Active tier"]);
    expect(ctx.modifiers.map(m => m.name)).toEqual(["Active modifier"]);
    expect(ctx.rules.map(r => r.name)).toEqual(["Active rule"]);
  });
});

// ── 3. Organization scoping ────────────────────────────────────────────────

describe("loadPricingContext — organization scoping", () => {
  it("returns only the requested org's rows; rows from another org are not returned", async () => {
    const targetOrgId = await seedOrg("target");
    const otherOrgId = await seedOrg("other");

    await db.insert(teePricingRulesTable).values({
      organizationId: targetOrgId, memberRate: "100.00", guestRate: "200.00",
    });
    await db.insert(teePricingRulesTable).values({
      organizationId: otherOrgId, memberRate: "999.00", guestRate: "999.00",
    });

    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: targetOrgId, enabled: true,
    });
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: otherOrgId, enabled: false,
    });

    await db.insert(teeDynamicPricingTiersTable).values([
      {
        organizationId: targetOrgId, name: "Target tier",
        daysOfWeek: [3], memberType: "any",
        memberRate: "100.00", guestRate: "150.00", priority: 1,
      },
      {
        organizationId: otherOrgId, name: "Other-org tier",
        daysOfWeek: [3], memberType: "any",
        memberRate: "100.00", guestRate: "150.00", priority: 1,
      },
    ]);

    await db.insert(teeDynamicPricingModifiersTable).values([
      {
        organizationId: targetOrgId, name: "Target modifier",
        kind: "utilization", adjustmentType: "percent", adjustmentValue: "10.00",
        applyTo: "any", priority: 1,
      },
      {
        organizationId: otherOrgId, name: "Other-org modifier",
        kind: "utilization", adjustmentType: "percent", adjustmentValue: "10.00",
        applyTo: "any", priority: 1,
      },
    ]);

    await db.insert(teeDynamicPricingRulesTable).values([
      { organizationId: targetOrgId, name: "Target rule", priceDeltaPct: "5.00", priority: 1, active: true },
      { organizationId: otherOrgId, name: "Other-org rule", priceDeltaPct: "5.00", priority: 1, active: true },
    ]);

    const ctx = await loadPricingContext(targetOrgId);

    expect(ctx.legacyRules?.memberRate).toBe("100.00");
    expect(ctx.legacyRules?.guestRate).toBe("200.00");
    expect(ctx.config?.enabled).toBe(true);

    expect(ctx.tiers.map(t => t.name)).toEqual(["Target tier"]);
    expect(ctx.modifiers.map(m => m.name)).toEqual(["Target modifier"]);
    expect(ctx.rules.map(r => r.name)).toEqual(["Target rule"]);
  });
});

// ── 4. Legacy currency + elasticity defaults ───────────────────────────────

describe("loadPricingContext — legacy defaults fall in when columns are null/missing", () => {
  it('defaults the legacy currency to "INR" when the column is absent on the legacy rules row', async () => {
    const orgId = await seedOrg("currency");

    // Insert with only the bare-minimum required columns. The currency
    // column does not exist on teePricingRulesTable, so the loader's
    // TS-level `?? "INR"` fallback is the only thing keeping the
    // resolver from getting `undefined` here.
    await db.insert(teePricingRulesTable).values({
      organizationId: orgId,
      memberRate: "500.00",
      guestRate: "750.00",
    });

    const ctx = await loadPricingContext(orgId);
    expect(ctx.legacyRules?.currency).toBe("INR");
  });

  it("defaults member/guest elasticity to -0.20 / -0.70 when not set on the dyn-pricing config row", async () => {
    const orgId = await seedOrg("elasticity");

    // Insert without specifying the elasticity columns — Postgres applies
    // its own defaults (-0.20 / -0.70 per schema) and the loader passes
    // them through. This test pins both the DB defaults AND the loader's
    // TS fallback so a future schema rename that drops the columns
    // entirely still surfaces the same numbers.
    await db.insert(teeDynamicPricingConfigTable).values({
      organizationId: orgId,
      enabled: true,
    });

    const ctx = await loadPricingContext(orgId);
    expect(ctx.config).not.toBeNull();
    expect(ctx.config?.defaultMemberElasticity).toBe("-0.20");
    expect(ctx.config?.defaultGuestElasticity).toBe("-0.70");
  });
});
