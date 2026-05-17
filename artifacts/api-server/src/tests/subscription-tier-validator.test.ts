import { describe, it, expect } from "vitest";
import { isSubscriptionTier, SUBSCRIPTION_TIERS } from "../lib/subscriptionTiers";

describe("isSubscriptionTier", () => {
  it("accepts every canonical tier", () => {
    for (const tier of SUBSCRIPTION_TIERS) {
      expect(isSubscriptionTier(tier)).toBe(true);
    }
  });

  it("rejects legacy / mistyped slugs", () => {
    for (const value of ["Free", "STARTER", "premium", "growth", "team", "", " "]) {
      expect(isSubscriptionTier(value)).toBe(false);
    }
  });

  it("rejects non-string inputs", () => {
    for (const value of [null, undefined, 0, 1, {}, [], true]) {
      expect(isSubscriptionTier(value)).toBe(false);
    }
  });

  it("exposes exactly the canonical set", () => {
    expect([...SUBSCRIPTION_TIERS].sort()).toEqual(["enterprise", "free", "pro", "starter"]);
  });
});
