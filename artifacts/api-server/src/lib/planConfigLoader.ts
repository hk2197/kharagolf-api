/**
 * DB-driven plan configuration loader with in-process cache.
 *
 * Replaces the hardcoded TIER_LIMITS / TIER_DISPLAY constants.
 * Cache is refreshed every 5 minutes or immediately after a super-admin
 * edit (call invalidatePlanConfigCache()).
 *
 * Merge priority for any field:
 *   org override (non-null + not expired)  >  tier default from DB  >  hardcoded fallback
 */

import { db } from "@workspace/db";
import { subscriptionPlanConfigsTable, orgPlanOverridesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { SubscriptionTier } from "./subscriptionTiers";

export interface PlanConfig {
  tier: SubscriptionTier;
  priceMonthly: number;
  maxActiveTournaments: number | null;
  maxMembers: number | null;
  maxLeagues: number | null;
  sponsorLogos: boolean;
  advancedAnalytics: boolean;
  prioritySupport: boolean;
  mobileApp: boolean;
  marketplace: boolean;
  aiRulesAssistant: boolean;
  whsScoring: boolean;
  duesBilling: boolean;
  shopLockerAccess: boolean;
  whiteLabel: boolean;
  customDomain: boolean;
}

export type FeatureName =
  | "sponsorLogos"
  | "advancedAnalytics"
  | "prioritySupport"
  | "mobileApp"
  | "marketplace"
  | "aiRulesAssistant"
  | "whsScoring"
  | "duesBilling"
  | "shopLockerAccess"
  | "whiteLabel"
  | "customDomain";

const HARDCODED_FALLBACK: Record<SubscriptionTier, PlanConfig> = {
  free: {
    tier: "free",
    priceMonthly: 0,
    maxActiveTournaments: 1,
    maxMembers: 50,
    maxLeagues: 1,
    sponsorLogos: false,
    advancedAnalytics: false,
    prioritySupport: false,
    mobileApp: true,
    marketplace: false,
    aiRulesAssistant: false,
    whsScoring: false,
    duesBilling: false,
    shopLockerAccess: false,
    whiteLabel: false,
    customDomain: false,
  },
  starter: {
    tier: "starter",
    priceMonthly: 2999,
    maxActiveTournaments: 5,
    maxMembers: 200,
    maxLeagues: 3,
    sponsorLogos: true,
    advancedAnalytics: false,
    prioritySupport: false,
    mobileApp: true,
    marketplace: true,
    aiRulesAssistant: false,
    whsScoring: false,
    duesBilling: false,
    shopLockerAccess: true,
    whiteLabel: false,
    customDomain: false,
  },
  pro: {
    tier: "pro",
    priceMonthly: 7999,
    maxActiveTournaments: null,
    maxMembers: null,
    maxLeagues: null,
    sponsorLogos: true,
    advancedAnalytics: true,
    prioritySupport: true,
    mobileApp: true,
    marketplace: true,
    aiRulesAssistant: true,
    whsScoring: true,
    duesBilling: true,
    shopLockerAccess: true,
    whiteLabel: false,
    customDomain: false,
  },
  enterprise: {
    tier: "enterprise",
    priceMonthly: 19999,
    maxActiveTournaments: null,
    maxMembers: null,
    maxLeagues: null,
    sponsorLogos: true,
    advancedAnalytics: true,
    prioritySupport: true,
    mobileApp: true,
    marketplace: true,
    aiRulesAssistant: true,
    whsScoring: true,
    duesBilling: true,
    shopLockerAccess: true,
    whiteLabel: true,
    customDomain: true,
  },
};

// In-process plan config cache
let planConfigCache: Record<SubscriptionTier, PlanConfig> | null = null;
let planConfigCacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidatePlanConfigCache(): void {
  planConfigCache = null;
  planConfigCacheAt = 0;
}

async function loadPlanConfigs(): Promise<Record<SubscriptionTier, PlanConfig>> {
  const now = Date.now();
  if (planConfigCache && now - planConfigCacheAt < CACHE_TTL_MS) {
    return planConfigCache;
  }

  try {
    const rows = await db.select().from(subscriptionPlanConfigsTable);
    if (rows.length === 0) {
      // Table is empty — use hardcoded fallback (seed not run yet)
      planConfigCache = { ...HARDCODED_FALLBACK };
      planConfigCacheAt = now;
      return planConfigCache;
    }

    const configs: Partial<Record<SubscriptionTier, PlanConfig>> = {};
    for (const row of rows) {
      const tier = row.tier as SubscriptionTier;
      configs[tier] = {
        tier,
        priceMonthly: row.priceMonthly,
        maxActiveTournaments: row.maxActiveTournaments ?? null,
        maxMembers: row.maxMembers ?? null,
        maxLeagues: row.maxLeagues ?? null,
        sponsorLogos: row.sponsorLogos,
        advancedAnalytics: row.advancedAnalytics,
        prioritySupport: row.prioritySupport,
        mobileApp: row.mobileApp,
        marketplace: row.marketplace,
        aiRulesAssistant: row.aiRulesAssistant,
        whsScoring: row.whsScoring,
        duesBilling: row.duesBilling,
        shopLockerAccess: row.shopLockerAccess,
        whiteLabel: row.whiteLabel,
        customDomain: row.customDomain,
      };
    }

    // Fill any missing tiers with hardcoded fallback
    for (const tier of ["free", "starter", "pro", "enterprise"] as SubscriptionTier[]) {
      if (!configs[tier]) configs[tier] = HARDCODED_FALLBACK[tier];
    }

    planConfigCache = configs as Record<SubscriptionTier, PlanConfig>;
    planConfigCacheAt = now;
    return planConfigCache;
  } catch {
    // DB not available — use fallback
    return { ...HARDCODED_FALLBACK };
  }
}

/**
 * Returns the effective plan config for an org, merging tier defaults
 * with any active (non-expired) per-org overrides.
 * Also returns `hasActiveOverride` flag for the "Customized" badge.
 */
export async function getEffectivePlanConfig(
  tier: SubscriptionTier,
  orgId: number,
): Promise<{ config: PlanConfig; hasActiveOverride: boolean }> {
  const configs = await loadPlanConfigs();
  // Defensive: an org's `subscription_tier` is free-form text, so legacy or
  // unknown values can be passed in. Fall back to the Free tier config so
  // downstream code never dereferences `undefined`.
  const base = configs[tier] ?? configs.free;

  let override: typeof orgPlanOverridesTable.$inferSelect | null = null;
  try {
    const [row] = await db
      .select()
      .from(orgPlanOverridesTable)
      .where(eq(orgPlanOverridesTable.organizationId, orgId));
    override = row ?? null;
  } catch {
    override = null;
  }

  // Check if override is still active (null expiry = permanent)
  const isActive =
    override !== null &&
    (override.overrideExpiresAt === null || override.overrideExpiresAt > new Date());

  if (!isActive || !override) {
    return { config: { ...base }, hasActiveOverride: false };
  }

  // Merge: non-null override fields win
  const merged: PlanConfig = {
    tier: base.tier,
    priceMonthly: base.priceMonthly,
    maxActiveTournaments:
      override.overrideMaxTournaments !== null ? override.overrideMaxTournaments : base.maxActiveTournaments,
    maxMembers:
      override.overrideMaxMembers !== null ? override.overrideMaxMembers : base.maxMembers,
    maxLeagues:
      override.overrideMaxLeagues !== null ? override.overrideMaxLeagues : base.maxLeagues,
    sponsorLogos:
      override.overrideSponsorLogos !== null ? override.overrideSponsorLogos! : base.sponsorLogos,
    advancedAnalytics:
      override.overrideAdvancedAnalytics !== null ? override.overrideAdvancedAnalytics! : base.advancedAnalytics,
    prioritySupport:
      override.overridePrioritySupport !== null ? override.overridePrioritySupport! : base.prioritySupport,
    mobileApp:
      override.overrideMobileApp !== null ? override.overrideMobileApp! : base.mobileApp,
    marketplace:
      override.overrideMarketplace !== null ? override.overrideMarketplace! : base.marketplace,
    aiRulesAssistant:
      override.overrideAiRulesAssistant !== null ? override.overrideAiRulesAssistant! : base.aiRulesAssistant,
    whsScoring:
      override.overrideWhsScoring !== null ? override.overrideWhsScoring! : base.whsScoring,
    duesBilling:
      override.overrideDuesBilling !== null ? override.overrideDuesBilling! : base.duesBilling,
    shopLockerAccess:
      override.overrideShopLockerAccess !== null ? override.overrideShopLockerAccess! : base.shopLockerAccess,
    whiteLabel:
      override.overrideWhiteLabel !== null ? override.overrideWhiteLabel! : base.whiteLabel,
    customDomain:
      override.overrideCustomDomain !== null ? override.overrideCustomDomain! : base.customDomain,
  };

  // hasActiveOverride is true if any field is actually overridden
  const hasActiveOverride =
    override.overrideMaxTournaments !== null ||
    override.overrideMaxMembers !== null ||
    override.overrideMaxLeagues !== null ||
    override.overrideSponsorLogos !== null ||
    override.overrideAdvancedAnalytics !== null ||
    override.overridePrioritySupport !== null ||
    override.overrideMobileApp !== null ||
    override.overrideMarketplace !== null ||
    override.overrideAiRulesAssistant !== null ||
    override.overrideWhsScoring !== null ||
    override.overrideDuesBilling !== null ||
    override.overrideShopLockerAccess !== null ||
    override.overrideWhiteLabel !== null ||
    override.overrideCustomDomain !== null;

  return { config: merged, hasActiveOverride };
}

/**
 * Returns just the tier config (no org override) for use in list endpoints.
 */
export async function getTierConfig(tier: SubscriptionTier): Promise<PlanConfig> {
  const configs = await loadPlanConfigs();
  return configs[tier];
}

/**
 * Returns all tier configs (for admin display).
 */
export async function getAllTierConfigs(): Promise<Record<SubscriptionTier, PlanConfig>> {
  return loadPlanConfigs();
}

/**
 * Returns the canonical hardcoded default config for a tier.
 * Used as fallback in PATCH handlers so partial edits don't accidentally zero-out fields.
 */
export function getHardcodedDefault(tier: SubscriptionTier): PlanConfig {
  return { ...HARDCODED_FALLBACK[tier] };
}

/**
 * Ensures all 4 tier rows exist in `subscription_plan_configs`.
 * Called once at server startup. Uses INSERT ... ON CONFLICT DO NOTHING so existing
 * admin-edited rows are never overwritten.
 */
export async function ensurePlanConfigsSeed(): Promise<void> {
  const { subscriptionPlanConfigsTable } = await import("@workspace/db");
  const tiers: SubscriptionTier[] = ["free", "starter", "pro", "enterprise"];
  for (const tier of tiers) {
    const fb = HARDCODED_FALLBACK[tier];
    try {
      await db
        .insert(subscriptionPlanConfigsTable)
        .values({
          tier,
          priceMonthly: fb.priceMonthly,
          maxActiveTournaments: fb.maxActiveTournaments,
          maxMembers: fb.maxMembers,
          maxLeagues: fb.maxLeagues,
          sponsorLogos: fb.sponsorLogos,
          advancedAnalytics: fb.advancedAnalytics,
          prioritySupport: fb.prioritySupport,
          mobileApp: fb.mobileApp,
          marketplace: fb.marketplace,
          aiRulesAssistant: fb.aiRulesAssistant,
          whsScoring: fb.whsScoring,
          duesBilling: fb.duesBilling,
          shopLockerAccess: fb.shopLockerAccess,
          whiteLabel: fb.whiteLabel,
          customDomain: fb.customDomain,
        })
        .onConflictDoNothing(); // Never overwrite admin-edited rows
    } catch {
      // Non-fatal: if seed fails (e.g. table not yet created), fallback is used
    }
  }
  // Invalidate cache so fresh DB rows are picked up
  invalidatePlanConfigCache();
}
