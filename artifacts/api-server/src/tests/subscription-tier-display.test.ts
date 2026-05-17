import { describe, it, expect } from "vitest";
import { getTierDisplay, TIER_DISPLAY } from "../lib/subscriptionTiers";

describe("getTierDisplay", () => {
  it("returns the canonical display for each known tier", () => {
    for (const tier of ["free", "starter", "pro", "enterprise"] as const) {
      expect(getTierDisplay(tier)).toEqual(TIER_DISPLAY[tier]);
    }
  });

  it("falls back to a complete display for an unknown legacy tier", () => {
    const display = getTierDisplay("legacy_growth");
    expect(display.label).toBe("Legacy_growth");
    expect(typeof display.priceMonthly).toBe("number");
    expect(typeof display.currency).toBe("string");
    expect(typeof display.description).toBe("string");
  });

  it("falls back to Free when tier is null, undefined, or empty", () => {
    for (const value of [null, undefined, "", "   "]) {
      const display = getTierDisplay(value);
      expect(display.label).toBe(TIER_DISPLAY.free.label);
      expect(display.priceMonthly).toBe(TIER_DISPLAY.free.priceMonthly);
      expect(display.currency).toBe(TIER_DISPLAY.free.currency);
      expect(display.description).toBe(TIER_DISPLAY.free.description);
    }
  });

  it("never returns undefined for arbitrary tier strings", () => {
    const samples = ["GOLD", "platinum_v2", "trial-2024", "FREEMIUM", "??"];
    for (const s of samples) {
      const display = getTierDisplay(s);
      expect(display).toBeDefined();
      expect(typeof display.label).toBe("string");
      expect(display.label.length).toBeGreaterThan(0);
    }
  });
});
