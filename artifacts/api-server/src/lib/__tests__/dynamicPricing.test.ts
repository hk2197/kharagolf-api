/**
 * Unit tests for the W2-G simple pricing rule engine (Task #1004).
 *
 * Covers `resolveEffectivePriceWith`, the pure in-memory price resolver:
 *   1. Active rules apply in priority order (higher priority first).
 *   2. Inactive rules in `ctx.rules` would be filtered by `loadPricingContext`,
 *      but if a caller passes an inactive rule it is left to the caller —
 *      `resolveEffectivePriceWith` itself trusts the `active` flag handled
 *      upstream. The engine still respects the per-rule condition gates:
 *        - `dayOfWeek`     — only fires when slotDate.getDay() is in the array
 *        - `timeRange`     — only fires when slotTime is within [start, end)
 *        - `occupancyMin`  — only fires when utilization >= the threshold
 *        - `leadTimeHoursMax` — only fires when leadTime <= the threshold
 *   3. Aggressive rules still get clamped to the configured price ceiling
 *      (and floor) when dynamic pricing is enabled.
 *
 * The engine is pure with respect to the `PricingContext` argument so these
 * tests build the context inline and never touch the database.
 */
import { describe, it, expect } from "vitest";
import {
  resolveEffectivePriceWith,
  type PricingContext,
  type PricingRuleRow,
  type ResolvePriceInput,
  type TierRow,
  type ModifierRow,
} from "../dynamicPricing.js";

// ── Fixture helpers ───────────────────────────────────────────────────────

function makeContext(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    legacyRules: {
      memberRate: "100.00",
      guestRate: "100.00",
      twilightStartTime: null,
      twilightMemberRate: null,
      twilightGuestRate: null,
      currency: "INR",
    },
    config: null,
    tiers: [],
    modifiers: [],
    rules: [],
    ...overrides,
  };
}

function makeRule(overrides: Partial<PricingRuleRow> & { id: number; name: string }): PricingRuleRow {
  return {
    conditions: {},
    priceDeltaPct: "0",
    priority: 0,
    active: true,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ResolvePriceInput> = {}): ResolvePriceInput {
  return {
    orgId: 1,
    courseId: 1,
    // 2026-04-15 is a Wednesday (getDay() === 3)
    slotDate: new Date(2026, 3, 15),
    slotTime: "10:00",
    capacity: 4,
    bookedCount: 2,
    memberType: "guest",
    asOf: new Date(2026, 3, 15, 9, 0, 0),
    ...overrides,
  };
}

// ── Priority ordering ─────────────────────────────────────────────────────

describe("resolveEffectivePriceWith — rule priority order", () => {
  it("applies rules from highest priority to lowest, compounding multiplicatively", () => {
    // Two unconditional rules: +10% (priority 5) and +20% (priority 10).
    // Expected order in breakdown: priority 10 first, then priority 5.
    // Final price: 100 * 1.20 * 1.10 = 132.
    const ctx = makeContext({
      rules: [
        makeRule({ id: 1, name: "Low priority +10%", priceDeltaPct: "10", priority: 5 }),
        makeRule({ id: 2, name: "High priority +20%", priceDeltaPct: "20", priority: 10 }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    expect(out.basePrice).toBe(100);
    expect(out.finalPrice).toBeCloseTo(132, 5);

    const ruleSteps = out.breakdown.filter(s => s.source === "rule");
    expect(ruleSteps).toHaveLength(2);
    // Higher-priority rule fires first.
    expect(ruleSteps[0].detail?.ruleId).toBe(2);
    expect(ruleSteps[1].detail?.ruleId).toBe(1);
  });

  it("ignores rules with priceDeltaPct=0 in the breakdown but still considers ordering", () => {
    const ctx = makeContext({
      rules: [
        makeRule({ id: 1, name: "No-op", priceDeltaPct: "0", priority: 100 }),
        makeRule({ id: 2, name: "+5%", priceDeltaPct: "5", priority: 1 }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    expect(out.finalPrice).toBeCloseTo(105, 5);
    const ruleSteps = out.breakdown.filter(s => s.source === "rule");
    expect(ruleSteps).toHaveLength(1);
    expect(ruleSteps[0].detail?.ruleId).toBe(2);
  });
});

// ── dayOfWeek gate ────────────────────────────────────────────────────────

describe("resolveEffectivePriceWith — dayOfWeek condition", () => {
  it("fires on a matching day-of-week", () => {
    // Wed (getDay === 3)
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Mid-week +25%", priceDeltaPct: "25", priority: 1,
        conditions: { dayOfWeek: [2, 3, 4] },
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ slotDate: new Date(2026, 3, 15) }), // Wed
      ctx,
    );

    expect(out.finalPrice).toBeCloseTo(125, 5);
    expect(out.breakdown.some(s => s.source === "rule")).toBe(true);
  });

  it("skips when the day-of-week is not in the array", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Weekend only", priceDeltaPct: "50", priority: 1,
        conditions: { dayOfWeek: [0, 6] },
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ slotDate: new Date(2026, 3, 15) }), // Wed
      ctx,
    );

    expect(out.finalPrice).toBe(100);
    expect(out.breakdown.some(s => s.source === "rule")).toBe(false);
  });
});

// ── timeRange gate ────────────────────────────────────────────────────────

describe("resolveEffectivePriceWith — timeRange condition", () => {
  it("fires when slotTime is inside the window", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Morning +15%", priceDeltaPct: "15", priority: 1,
        conditions: { timeRange: ["08:00", "12:00"] },
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ slotTime: "10:00" }),
      ctx,
    );

    expect(out.finalPrice).toBeCloseTo(115, 5);
  });

  it("skips when slotTime is outside the window (end is exclusive)", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Morning +15%", priceDeltaPct: "15", priority: 1,
        conditions: { timeRange: ["08:00", "12:00"] },
      })],
    });

    // 12:00 is the exclusive boundary → must NOT fire.
    const outAtEnd = resolveEffectivePriceWith(makeInput({ slotTime: "12:00" }), ctx);
    expect(outAtEnd.finalPrice).toBe(100);

    // 14:00 is well outside → must NOT fire.
    const outAfter = resolveEffectivePriceWith(makeInput({ slotTime: "14:00" }), ctx);
    expect(outAfter.finalPrice).toBe(100);
  });
});

// ── occupancyMin gate ─────────────────────────────────────────────────────

describe("resolveEffectivePriceWith — occupancyMin condition", () => {
  it("fires when utilization is at or above the threshold", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Surge +30%", priceDeltaPct: "30", priority: 1,
        conditions: { occupancyMin: 0.5 },
      })],
    });

    // capacity 4, booked 2 → utilization = 0.5
    const out = resolveEffectivePriceWith(
      makeInput({ capacity: 4, bookedCount: 2 }),
      ctx,
    );

    expect(out.finalPrice).toBeCloseTo(130, 5);
  });

  it("skips when utilization is below the threshold", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Surge +30%", priceDeltaPct: "30", priority: 1,
        conditions: { occupancyMin: 0.5 },
      })],
    });

    // capacity 4, booked 1 → utilization = 0.25 < 0.5
    const out = resolveEffectivePriceWith(
      makeInput({ capacity: 4, bookedCount: 1 }),
      ctx,
    );

    expect(out.finalPrice).toBe(100);
  });
});

// ── leadTimeHoursMax gate ─────────────────────────────────────────────────

describe("resolveEffectivePriceWith — leadTimeHoursMax condition", () => {
  it("fires when lead time is within the cap", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Last-minute -20%", priceDeltaPct: "-20", priority: 1,
        conditions: { leadTimeHoursMax: 24 },
      })],
    });

    // slotDateTime = 2026-04-15 10:00; asOf = 2026-04-15 09:00 → leadTime = 1h
    const out = resolveEffectivePriceWith(
      makeInput({
        slotTime: "10:00",
        asOf: new Date(2026, 3, 15, 9, 0, 0),
      }),
      ctx,
    );

    expect(out.finalPrice).toBeCloseTo(80, 5);
  });

  it("skips when lead time exceeds the cap", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Last-minute -20%", priceDeltaPct: "-20", priority: 1,
        conditions: { leadTimeHoursMax: 24 },
      })],
    });

    // slotDateTime = 2026-04-15 10:00; asOf = 2026-04-13 09:00 → leadTime ≈ 49h
    const out = resolveEffectivePriceWith(
      makeInput({
        slotTime: "10:00",
        asOf: new Date(2026, 3, 13, 9, 0, 0),
      }),
      ctx,
    );

    expect(out.finalPrice).toBe(100);
  });
});

// ── Multiple gates combined ───────────────────────────────────────────────

describe("resolveEffectivePriceWith — multiple condition gates combined", () => {
  it("only fires when ALL conditions match", () => {
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Mid-week morning surge",
        priceDeltaPct: "40", priority: 1,
        conditions: {
          dayOfWeek: [3],            // Wed
          timeRange: ["08:00", "12:00"],
          occupancyMin: 0.5,
          leadTimeHoursMax: 48,
        },
      })],
    });

    // All conditions satisfied
    const allMatch = resolveEffectivePriceWith(
      makeInput({
        slotDate: new Date(2026, 3, 15), // Wed
        slotTime: "10:00",
        capacity: 4, bookedCount: 2,     // utilization 0.5
        asOf: new Date(2026, 3, 15, 9, 0, 0), // leadTime 1h
      }),
      ctx,
    );
    expect(allMatch.finalPrice).toBeCloseTo(140, 5);

    // Only one condition fails (occupancy too low) → rule skipped entirely
    const partialMatch = resolveEffectivePriceWith(
      makeInput({
        slotDate: new Date(2026, 3, 15),
        slotTime: "10:00",
        capacity: 4, bookedCount: 1,     // utilization 0.25 — below 0.5
        asOf: new Date(2026, 3, 15, 9, 0, 0),
      }),
      ctx,
    );
    expect(partialMatch.finalPrice).toBe(100);
  });
});

// ── Inactive rules ────────────────────────────────────────────────────────

describe("resolveEffectivePriceWith — inactive rule handling contract", () => {
  it("documents that filtering inactive rules is the loader's job: anything in ctx.rules is treated as active", () => {
    // Contract: `loadPricingContext` is responsible for filtering out
    // `active=false` rows (it WHEREs `active=true`). The pure resolver
    // trusts whatever it receives in `ctx.rules` and applies it. This test
    // pins that contract so a future change that starts re-checking
    // `rule.active` inside the resolver becomes a deliberate, visible
    // decision rather than an accidental drift.
    const ctx = makeContext({
      rules: [makeRule({
        id: 1, name: "Disabled-but-passed-in",
        priceDeltaPct: "25", priority: 1,
        active: false, // would be filtered by the loader, but we pass it anyway
      })],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    expect(out.finalPrice).toBeCloseTo(125, 5);
    expect(out.breakdown.some(s => s.source === "rule")).toBe(true);
  });
});

// ── Caps & floors clamping ────────────────────────────────────────────────

describe("resolveEffectivePriceWith — caps clamp aggressive rules", () => {
  it("clamps to the price ceiling when an aggressive rule overshoots and dyn pricing is enabled", () => {
    // Dyn enabled, ceiling at 1.50× base. A +100% rule would push the price
    // to 200, but the ceiling caps it to 150.
    const ctx = makeContext({
      config: {
        enabled: true,
        priceFloorPct: "0.50",
        priceCeilingPct: "1.50",
        dealBadgeThresholdPct: "0.85",
        defaultMemberElasticity: "-0.20",
        defaultGuestElasticity: "-0.70",
      },
      rules: [makeRule({
        id: 1, name: "Aggressive +100%",
        priceDeltaPct: "100", priority: 1,
      })],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    expect(out.basePrice).toBe(100);
    expect(out.finalPrice).toBe(150);

    // Both the rule step AND the ceiling clamp step should be present, in
    // that order — rule fires first, then the cap clamps it.
    const sources = out.breakdown.map(s => s.source);
    const ruleIdx = sources.indexOf("rule");
    const capIdx = sources.indexOf("cap");
    expect(ruleIdx).toBeGreaterThanOrEqual(0);
    expect(capIdx).toBeGreaterThan(ruleIdx);
  });

  it("clamps to the price floor when a steep discount rule undershoots", () => {
    const ctx = makeContext({
      config: {
        enabled: true,
        priceFloorPct: "0.50",
        priceCeilingPct: "2.00",
        dealBadgeThresholdPct: "0.85",
        defaultMemberElasticity: "-0.20",
        defaultGuestElasticity: "-0.70",
      },
      rules: [makeRule({
        id: 1, name: "Aggressive -80%",
        priceDeltaPct: "-80", priority: 1,
      })],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    // -80% would land at 20; floor 0.50 × 100 = 50.
    expect(out.finalPrice).toBe(50);
    expect(out.breakdown.some(s => s.source === "floor")).toBe(true);
  });

  it("does not clamp when dynamic pricing is disabled (legacy/rule-only path)", () => {
    // No config row → dyn disabled. Rules still apply but caps/floors don't.
    const ctx = makeContext({
      config: null,
      rules: [makeRule({
        id: 1, name: "Aggressive +100%",
        priceDeltaPct: "100", priority: 1,
      })],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    // No caps applied → +100% goes through.
    expect(out.finalPrice).toBe(200);
    expect(out.breakdown.some(s => s.source === "cap")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Tier selection, modifier loop, deal badge, twilight fallback
// (Task #1338 — coverage for the rest of `resolveEffectivePriceWith`.)
// ═════════════════════════════════════════════════════════════════════════

function makeTier(overrides: Partial<TierRow> & { id: number; name: string }): TierRow {
  return {
    courseId: null,
    daysOfWeek: [],
    startTime: null,
    endTime: null,
    seasonStart: null,
    seasonEnd: null,
    memberType: "any",
    memberRate: "120.00",
    guestRate: "150.00",
    priority: 0,
    ...overrides,
  };
}

function makeModifier(overrides: Partial<ModifierRow> & { id: number; name: string }): ModifierRow {
  return {
    courseId: null,
    kind: "utilization",
    thresholdMin: null,
    thresholdMax: null,
    weatherCondition: null,
    adjustmentType: "percent",
    adjustmentValue: "0",
    applyTo: "any",
    priority: 0,
    ...overrides,
  };
}

/** Dyn-pricing config with very wide caps so cap/floor never interferes. */
const DYN_OPEN: PricingContext["config"] = {
  enabled: true,
  priceFloorPct: "0.01",
  priceCeilingPct: "100.00",
  dealBadgeThresholdPct: "0.85",
  defaultMemberElasticity: "-0.20",
  defaultGuestElasticity: "-0.70",
};

// ── Tier selection: priority + scope filters ──────────────────────────────

describe("resolveEffectivePriceWith — selectBestTier picks highest-priority match", () => {
  it("picks the highest-priority matching tier when multiple match", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        makeTier({ id: 1, name: "Low priority", priority: 1, guestRate: "110.00" }),
        makeTier({ id: 2, name: "Top priority", priority: 50, guestRate: "180.00" }),
        makeTier({ id: 3, name: "Mid priority", priority: 10, guestRate: "140.00" }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    expect(out.tierId).toBe(2);
    expect(out.tierName).toBe("Top priority");
    expect(out.finalPrice).toBe(180);
    const tierStep = out.breakdown.find(s => s.source === "tier");
    expect(tierStep?.detail?.tierId).toBe(2);
  });

  it("returns no tier (and falls back to legacy rate) when none match", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        // Only matches Sundays — slot is a Wednesday.
        makeTier({ id: 1, name: "Sunday only", daysOfWeek: [0], guestRate: "200.00" }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);

    expect(out.tierId).toBeNull();
    expect(out.tierName).toBeNull();
    expect(out.finalPrice).toBe(100); // legacy guest rate from fixture
    expect(out.breakdown.some(s => s.source === "tier")).toBe(false);
  });
});

describe("resolveEffectivePriceWith — tier course-scope filter", () => {
  it("excludes tiers scoped to a different courseId", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        // High-priority but scoped to course 99 — must be skipped.
        makeTier({ id: 1, name: "Course 99 only", courseId: 99, priority: 100, guestRate: "300.00" }),
        // Lower priority, but unscoped — should win.
        makeTier({ id: 2, name: "All courses", courseId: null, priority: 1, guestRate: "140.00" }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput({ courseId: 1 }), ctx);

    expect(out.tierId).toBe(2);
    expect(out.finalPrice).toBe(140);
  });

  it("includes a tier scoped to the matching courseId", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        makeTier({ id: 1, name: "Course 7 special", courseId: 7, priority: 1, guestRate: "175.00" }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput({ courseId: 7 }), ctx);

    expect(out.tierId).toBe(1);
    expect(out.finalPrice).toBe(175);
  });
});

describe("resolveEffectivePriceWith — tier season-window filter", () => {
  it("matches a tier when slot date is inside a non-wrapping season window", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        // Spring season: April–June. Slot is 2026-04-15.
        makeTier({
          id: 1, name: "Spring",
          seasonStart: "04-01", seasonEnd: "06-30",
          guestRate: "160.00",
        }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);
    expect(out.tierId).toBe(1);
    expect(out.finalPrice).toBe(160);
  });

  it("skips a tier when slot date is outside a non-wrapping season window", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        makeTier({
          id: 1, name: "Summer",
          seasonStart: "07-01", seasonEnd: "08-31",
          guestRate: "200.00",
        }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx); // April → outside
    expect(out.tierId).toBeNull();
    expect(out.finalPrice).toBe(100);
  });

  it("matches a wrapping season window (winter Dec→Feb)", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        makeTier({
          id: 1, name: "Winter",
          seasonStart: "12-01", seasonEnd: "02-28",
          guestRate: "180.00",
        }),
      ],
    });

    // January 15 → must match the wrapping window.
    const out = resolveEffectivePriceWith(
      makeInput({ slotDate: new Date(2026, 0, 15) }),
      ctx,
    );
    expect(out.tierId).toBe(1);
    expect(out.finalPrice).toBe(180);
  });
});

describe("resolveEffectivePriceWith — tier member-type filter", () => {
  it('skips a tier whose memberType does not match the booking', () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        // Member-only tier, but booking is a guest.
        makeTier({
          id: 1, name: "Members only",
          memberType: "member", priority: 100,
          memberRate: "90.00", guestRate: "90.00",
        }),
        makeTier({
          id: 2, name: "Anyone",
          memberType: "any", priority: 1,
          guestRate: "140.00",
        }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput({ memberType: "guest" }), ctx);
    expect(out.tierId).toBe(2);
    expect(out.finalPrice).toBe(140);
  });

  it('honours a member-specific tier and uses the member rate column', () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        makeTier({
          id: 1, name: "Members only",
          memberType: "member", priority: 1,
          memberRate: "90.00", guestRate: "999.00",
        }),
      ],
    });

    const out = resolveEffectivePriceWith(makeInput({ memberType: "member" }), ctx);
    expect(out.tierId).toBe(1);
    // Member rate, not guest rate, must be used.
    expect(out.finalPrice).toBe(90);
  });
});

describe("resolveEffectivePriceWith — tier day-of-week and time-window filters", () => {
  it("filters by day-of-week", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        makeTier({
          id: 1, name: "Weekend",
          daysOfWeek: [0, 6], // Sun, Sat
          guestRate: "200.00",
        }),
      ],
    });

    // Wed → no match.
    const wed = resolveEffectivePriceWith(
      makeInput({ slotDate: new Date(2026, 3, 15) }),
      ctx,
    );
    expect(wed.tierId).toBeNull();

    // Sat → matches.
    const sat = resolveEffectivePriceWith(
      makeInput({ slotDate: new Date(2026, 3, 18) }),
      ctx,
    );
    expect(sat.tierId).toBe(1);
    expect(sat.finalPrice).toBe(200);
  });

  it("filters by time-window (end is exclusive)", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [
        makeTier({
          id: 1, name: "Morning",
          startTime: "08:00", endTime: "12:00",
          guestRate: "165.00",
        }),
      ],
    });

    const inWindow = resolveEffectivePriceWith(makeInput({ slotTime: "10:00" }), ctx);
    expect(inWindow.tierId).toBe(1);

    // 12:00 sits on the exclusive boundary → no match.
    const onBoundary = resolveEffectivePriceWith(makeInput({ slotTime: "12:00" }), ctx);
    expect(onBoundary.tierId).toBeNull();

    const after = resolveEffectivePriceWith(makeInput({ slotTime: "14:00" }), ctx);
    expect(after.tierId).toBeNull();
  });
});

// ── Modifier loop: kinds, percent vs flat, scoping ────────────────────────

describe("resolveEffectivePriceWith — utilization modifier", () => {
  it("fires when utilization is in [min, max) and applies a percent adjustment", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 10, name: "Busy +20%",
        kind: "utilization",
        thresholdMin: "0.5", thresholdMax: "1.0",
        adjustmentType: "percent", adjustmentValue: "20",
      })],
    });

    // capacity 4, booked 2 → utilization 0.5 → in [0.5, 1.0).
    const out = resolveEffectivePriceWith(
      makeInput({ capacity: 4, bookedCount: 2 }),
      ctx,
    );
    expect(out.finalPrice).toBe(120);
    const modStep = out.breakdown.find(s => s.source === "modifier");
    expect(modStep?.detail?.modifierId).toBe(10);
    expect(modStep?.detail?.kind).toBe("utilization");
  });

  it("does not fire when utilization sits at the exclusive max boundary", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Busy +20%",
        kind: "utilization",
        thresholdMin: "0.0", thresholdMax: "0.5",
        adjustmentType: "percent", adjustmentValue: "20",
      })],
    });

    // utilization exactly 0.5 → must NOT fire (exclusive max).
    const out = resolveEffectivePriceWith(
      makeInput({ capacity: 4, bookedCount: 2 }),
      ctx,
    );
    expect(out.finalPrice).toBe(100);
    expect(out.breakdown.some(s => s.source === "modifier")).toBe(false);
  });

  it("applies a flat adjustment (currency units, not percent)", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Peak surcharge",
        kind: "utilization",
        thresholdMin: "0.5", thresholdMax: "1.0",
        adjustmentType: "flat", adjustmentValue: "15",
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ capacity: 4, bookedCount: 2 }),
      ctx,
    );
    expect(out.finalPrice).toBe(115);
  });
});

describe("resolveEffectivePriceWith — lead_time modifier", () => {
  it("fires when leadTimeHours is inside [min, max)", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Last-minute -10%",
        kind: "lead_time",
        thresholdMin: "0", thresholdMax: "6",
        adjustmentType: "percent", adjustmentValue: "-10",
      })],
    });

    // slotTime 10:00, asOf 09:00 → leadTime 1h.
    const out = resolveEffectivePriceWith(
      makeInput({
        slotTime: "10:00",
        asOf: new Date(2026, 3, 15, 9, 0, 0),
      }),
      ctx,
    );
    expect(out.finalPrice).toBe(90);
  });

  it("does not fire when leadTimeHours is outside the window", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Last-minute -10%",
        kind: "lead_time",
        thresholdMin: "0", thresholdMax: "6",
        adjustmentType: "percent", adjustmentValue: "-10",
      })],
    });

    // 49h ahead → outside [0, 6).
    const out = resolveEffectivePriceWith(
      makeInput({
        slotTime: "10:00",
        asOf: new Date(2026, 3, 13, 9, 0, 0),
      }),
      ctx,
    );
    expect(out.finalPrice).toBe(100);
  });
});

describe("resolveEffectivePriceWith — lead_time modifier (flat adjustment)", () => {
  it("applies a flat currency adjustment when leadTime is in window", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Last-minute fee",
        kind: "lead_time",
        thresholdMin: "0", thresholdMax: "6",
        adjustmentType: "flat", adjustmentValue: "-12",
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({
        slotTime: "10:00",
        asOf: new Date(2026, 3, 15, 9, 0, 0),
      }),
      ctx,
    );
    expect(out.finalPrice).toBe(88);
  });
});

describe("resolveEffectivePriceWith — weather modifier", () => {
  it("matches case-insensitively when weatherCondition strings agree", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Rainy -25%",
        kind: "weather",
        weatherCondition: "Rain",
        adjustmentType: "percent", adjustmentValue: "-25",
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ weatherCondition: "rain" }),
      ctx,
    );
    expect(out.finalPrice).toBe(75);
  });

  it("does not fire when weatherCondition is missing on the input", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Rainy -25%",
        kind: "weather",
        weatherCondition: "Rain",
        adjustmentType: "percent", adjustmentValue: "-25",
      })],
    });

    const out = resolveEffectivePriceWith(makeInput({ weatherCondition: null }), ctx);
    expect(out.finalPrice).toBe(100);
  });

  it("applies a flat currency adjustment for a matching weather condition", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Rain credit",
        kind: "weather",
        weatherCondition: "Rain",
        adjustmentType: "flat", adjustmentValue: "-15",
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ weatherCondition: "rain" }),
      ctx,
    );
    expect(out.finalPrice).toBe(85);
  });

  it("does not fire when weather condition strings do not match", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [makeModifier({
        id: 1, name: "Snow -50%",
        kind: "weather",
        weatherCondition: "Snow",
        adjustmentType: "percent", adjustmentValue: "-50",
      })],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ weatherCondition: "Rain" }),
      ctx,
    );
    expect(out.finalPrice).toBe(100);
  });
});

describe("resolveEffectivePriceWith — modifier scoping", () => {
  it("excludes modifiers scoped to a different courseId", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [
        makeModifier({
          id: 1, name: "Course 99 surge",
          courseId: 99,
          kind: "utilization",
          thresholdMin: "0", thresholdMax: "1",
          adjustmentType: "percent", adjustmentValue: "50",
        }),
        makeModifier({
          id: 2, name: "All courses",
          courseId: null,
          kind: "utilization",
          thresholdMin: "0", thresholdMax: "1",
          adjustmentType: "percent", adjustmentValue: "10",
        }),
      ],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ courseId: 1, capacity: 4, bookedCount: 2 }),
      ctx,
    );
    // Only the unscoped +10% should fire.
    expect(out.finalPrice).toBe(110);
    const modSteps = out.breakdown.filter(s => s.source === "modifier");
    expect(modSteps).toHaveLength(1);
    expect(modSteps[0].detail?.modifierId).toBe(2);
  });

  it("excludes modifiers whose applyTo does not match the booking memberType", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00", memberRate: "100.00" })],
      modifiers: [
        makeModifier({
          id: 1, name: "Members only +30%",
          applyTo: "member",
          kind: "utilization",
          thresholdMin: "0", thresholdMax: "1",
          adjustmentType: "percent", adjustmentValue: "30",
        }),
      ],
    });

    // Guest booking → member-scoped modifier must be skipped.
    const guestOut = resolveEffectivePriceWith(
      makeInput({ memberType: "guest", capacity: 4, bookedCount: 2 }),
      ctx,
    );
    expect(guestOut.finalPrice).toBe(100);

    // Member booking → modifier fires.
    const memberOut = resolveEffectivePriceWith(
      makeInput({ memberType: "member", capacity: 4, bookedCount: 2 }),
      ctx,
    );
    expect(memberOut.finalPrice).toBe(130);
  });

  it("applies modifiers from highest priority to lowest, compounding", () => {
    const ctx = makeContext({
      config: DYN_OPEN,
      tiers: [makeTier({ id: 1, name: "Base", guestRate: "100.00" })],
      modifiers: [
        makeModifier({
          id: 1, name: "Low priority +10%",
          priority: 1,
          kind: "utilization",
          thresholdMin: "0", thresholdMax: "1",
          adjustmentType: "percent", adjustmentValue: "10",
        }),
        makeModifier({
          id: 2, name: "High priority +20%",
          priority: 10,
          kind: "utilization",
          thresholdMin: "0", thresholdMax: "1",
          adjustmentType: "percent", adjustmentValue: "20",
        }),
      ],
    });

    const out = resolveEffectivePriceWith(
      makeInput({ capacity: 4, bookedCount: 2 }),
      ctx,
    );
    // 100 * 1.20 * 1.10 = 132
    expect(out.finalPrice).toBeCloseTo(132, 5);

    const modSteps = out.breakdown.filter(s => s.source === "modifier");
    expect(modSteps).toHaveLength(2);
    expect(modSteps[0].detail?.modifierId).toBe(2); // higher priority first
    expect(modSteps[1].detail?.modifierId).toBe(1);
  });
});

// ── Deal badge threshold ──────────────────────────────────────────────────

describe("resolveEffectivePriceWith — deal-badge threshold flips at the configured percent", () => {
  it("flags isDeal=true when finalPrice is strictly below basePrice * threshold", () => {
    // basePrice 100, threshold 0.85 → deal when price < 85.
    const ctx = makeContext({
      config: { ...DYN_OPEN, dealBadgeThresholdPct: "0.85" },
      tiers: [makeTier({
        id: 1, name: "Discount tier",
        guestRate: "84.00", // < 85 → deal
      })],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);
    expect(out.finalPrice).toBe(84);
    expect(out.isDeal).toBe(true);
    expect(out.dealBadge).toMatch(/^Save \d+%$/);
  });

  it("flags isDeal=false when finalPrice exactly equals basePrice * threshold (boundary is exclusive)", () => {
    const ctx = makeContext({
      config: { ...DYN_OPEN, dealBadgeThresholdPct: "0.85" },
      tiers: [makeTier({
        id: 1, name: "On the line",
        guestRate: "85.00", // exactly 0.85 × 100 — must NOT be a deal.
      })],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);
    expect(out.finalPrice).toBe(85);
    expect(out.isDeal).toBe(false);
    expect(out.dealBadge).toBeNull();
  });

  it("respects an alternate threshold value", () => {
    // threshold 0.50 → only flag when below 50% of base.
    const ctx = makeContext({
      config: { ...DYN_OPEN, dealBadgeThresholdPct: "0.50" },
      tiers: [makeTier({
        id: 1, name: "Big discount",
        guestRate: "49.00", // < 50 → deal
      })],
    });

    const out = resolveEffectivePriceWith(makeInput(), ctx);
    expect(out.isDeal).toBe(true);

    const ctx2 = makeContext({
      config: { ...DYN_OPEN, dealBadgeThresholdPct: "0.50" },
      tiers: [makeTier({
        id: 1, name: "Mild discount",
        guestRate: "70.00", // above 50% — would be a deal under 0.85 default but not here.
      })],
    });
    const out2 = resolveEffectivePriceWith(makeInput(), ctx2);
    expect(out2.isDeal).toBe(false);
  });
});

// ── Legacy twilight-rate fallback ─────────────────────────────────────────

describe("resolveEffectivePriceWith — legacy twilight-rate fallback", () => {
  it("uses twilightGuestRate when slotTime >= twilightStartTime for a guest", () => {
    const ctx = makeContext({
      legacyRules: {
        memberRate: "100.00",
        guestRate: "120.00",
        twilightStartTime: "16:00",
        twilightMemberRate: "60.00",
        twilightGuestRate: "70.00",
        currency: "INR",
      },
    });

    // 16:30 → past twilight start.
    const out = resolveEffectivePriceWith(
      makeInput({ slotTime: "16:30", memberType: "guest" }),
      ctx,
    );
    expect(out.basePrice).toBe(70);
    expect(out.finalPrice).toBe(70);
  });

  it("uses twilightMemberRate for a member booking after twilight starts", () => {
    const ctx = makeContext({
      legacyRules: {
        memberRate: "100.00",
        guestRate: "120.00",
        twilightStartTime: "16:00",
        twilightMemberRate: "60.00",
        twilightGuestRate: "70.00",
        currency: "INR",
      },
    });

    const out = resolveEffectivePriceWith(
      makeInput({ slotTime: "17:00", memberType: "member" }),
      ctx,
    );
    expect(out.basePrice).toBe(60);
    expect(out.finalPrice).toBe(60);
  });

  it("uses the regular rate before twilight starts", () => {
    const ctx = makeContext({
      legacyRules: {
        memberRate: "100.00",
        guestRate: "120.00",
        twilightStartTime: "16:00",
        twilightMemberRate: "60.00",
        twilightGuestRate: "70.00",
        currency: "INR",
      },
    });

    const out = resolveEffectivePriceWith(
      makeInput({ slotTime: "10:00", memberType: "guest" }),
      ctx,
    );
    expect(out.basePrice).toBe(120);
    expect(out.finalPrice).toBe(120);
  });

  it("triggers exactly at the twilightStartTime boundary (inclusive)", () => {
    const ctx = makeContext({
      legacyRules: {
        memberRate: "100.00",
        guestRate: "120.00",
        twilightStartTime: "16:00",
        twilightMemberRate: "60.00",
        twilightGuestRate: "70.00",
        currency: "INR",
      },
    });

    const out = resolveEffectivePriceWith(
      makeInput({ slotTime: "16:00", memberType: "guest" }),
      ctx,
    );
    expect(out.basePrice).toBe(70);
  });

  it("falls back to the regular rate if the twilight column is null even after twilight starts", () => {
    const ctx = makeContext({
      legacyRules: {
        memberRate: "100.00",
        guestRate: "120.00",
        twilightStartTime: "16:00",
        twilightMemberRate: null,   // not configured
        twilightGuestRate: null,
        currency: "INR",
      },
    });

    const out = resolveEffectivePriceWith(
      makeInput({ slotTime: "17:00", memberType: "guest" }),
      ctx,
    );
    expect(out.basePrice).toBe(120);
    expect(out.finalPrice).toBe(120);
  });

  it("does not apply twilight pricing when twilightStartTime is null", () => {
    const ctx = makeContext({
      legacyRules: {
        memberRate: "100.00",
        guestRate: "120.00",
        twilightStartTime: null,
        twilightMemberRate: "60.00",
        twilightGuestRate: "70.00",
        currency: "INR",
      },
    });

    // Even at 18:00 the twilight rate should not kick in if no start configured.
    const out = resolveEffectivePriceWith(
      makeInput({ slotTime: "18:00", memberType: "guest" }),
      ctx,
    );
    expect(out.basePrice).toBe(120);
  });
});
