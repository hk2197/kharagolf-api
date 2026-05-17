import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { organizationsTable, tournamentsTable, leaguesTable, orgMembershipsTable } from "@workspace/db";
import { eq, count, sql, and } from "drizzle-orm";
import { TIER_DISPLAY, getTierDisplay, type SubscriptionTier } from "./subscriptionTiers";
import { getEffectivePlanConfig, type FeatureName } from "./planConfigLoader";

type OrgGateContext = {
  tier: SubscriptionTier;
  effectiveTier: SubscriptionTier;
  isActive: boolean;
  subscriptionLapsed: boolean;
  orgId: number;
};

/**
 * Fetches the org's plan context for gating.
 * `effectiveTier` is downgraded to 'free' when the subscription has lapsed.
 */
async function getOrgTier(orgId: number): Promise<OrgGateContext | null> {
  const [org] = await db
    .select({
      subscriptionTier: organizationsTable.subscriptionTier,
      subscriptionStatus: organizationsTable.subscriptionStatus,
      isActive: organizationsTable.isActive,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) return null;

  const tier = org.subscriptionTier as SubscriptionTier;
  const status = org.subscriptionStatus;
  const subscriptionLapsed = tier !== "free" && (status === "past_due" || status === "cancelled");
  const effectiveTier: SubscriptionTier = subscriptionLapsed ? "free" : tier;

  return { tier, effectiveTier, isActive: org.isActive, subscriptionLapsed, orgId };
}

// ─────────────────────────────────────────────────────────────
// Generic feature gate middleware factory
// ─────────────────────────────────────────────────────────────

/**
 * Middleware factory: gates any named feature.
 * orgId is resolved from (req.params as Record<string, string>).orgId (must be present on the route).
 *
 * Returns 402 featureGate response if the effective plan (tier + overrides) does not include the feature.
 */
export function gateFeature(feature: FeatureName) {
  const featureLabel: Record<FeatureName, string> = {
    sponsorLogos: "Sponsor logos",
    advancedAnalytics: "Advanced analytics",
    prioritySupport: "Priority support",
    mobileApp: "Mobile app access",
    marketplace: "Tee Time Marketplace",
    aiRulesAssistant: "AI Rules Assistant",
    whsScoring: "WHS self-scoring",
    duesBilling: "Dues & Billing",
    shopLockerAccess: "Shop & Locker access",
    whiteLabel: "White-label branding",
    customDomain: "Custom domain",
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    // orgId may be in params from the mounted route
    const rawOrgId = (req.params as Record<string, string>).orgId;
    const orgId = rawOrgId ? parseInt(rawOrgId) : NaN;
    if (isNaN(orgId)) { next(); return; }

    const orgData = await getOrgTier(orgId);
    if (!orgData) { next(); return; }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: `Your subscription has lapsed. Renew to access ${featureLabel[feature]}.`,
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      });
      return;
    }

    const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);

    if (!config[feature]) {
      // Determine which tier unlocks this feature
      const requiredTier = determineRequiredTier(feature);
      res.status(402).json({
        error: `${featureLabel[feature]} is not available on your ${TIER_DISPLAY[orgData.effectiveTier].label} plan.`,
        featureGate: {
          type: "feature_gate",
          feature,
          currentTier: orgData.tier,
          requiredTier,
          message: `Upgrade to ${TIER_DISPLAY[requiredTier].label} to unlock ${featureLabel[feature].toLowerCase()}.`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Session-aware variant of gateFeature.
 * Resolves orgId from req.user.organizationId (trusted session) instead of route params.
 * Use this for routes that don't carry :orgId in the path (e.g. /portal/submissions/:submissionId/*).
 *
 * Behaviour:
 *  - No session user (unauthenticated)                  → 401
 *  - Authenticated user with no org (super-admin, etc.) → allow (next())
 *  - Org not found in DB                                → 402 fail-closed
 *  - Plan does not include feature                      → 402 featureGate
 */
export function gateFeatureFromSession(feature: FeatureName) {
  const featureLabel: Record<FeatureName, string> = {
    sponsorLogos: "Sponsor logos",
    advancedAnalytics: "Advanced analytics",
    prioritySupport: "Priority support",
    mobileApp: "Mobile app access",
    marketplace: "Tee Time Marketplace",
    aiRulesAssistant: "AI Rules Assistant",
    whsScoring: "WHS self-scoring",
    duesBilling: "Dues & Billing",
    shopLockerAccess: "Shop & Locker access",
    whiteLabel: "White-label branding",
    customDomain: "Custom domain",
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const sessionUser = req.user as AuthUser | undefined;
    if (!sessionUser) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    const orgId = sessionUser.organizationId ?? null;
    if (orgId === null) { next(); return; } // No org context (super-admin, etc.) — allow

    const orgData = await getOrgTier(orgId);
    if (!orgData) {
      // Org referenced in session not found — deny (fail-closed)
      res.status(402).json({
        error: `Organisation not found. Cannot verify ${featureLabel[feature]} entitlement.`,
        featureGate: { type: "feature_gate", feature },
      });
      return;
    }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: `Your subscription has lapsed. Renew to access ${featureLabel[feature]}.`,
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      });
      return;
    }

    const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
    if (!config[feature]) {
      const requiredTier = determineRequiredTier(feature);
      res.status(402).json({
        error: `${featureLabel[feature]} is not available on your ${TIER_DISPLAY[orgData.effectiveTier].label} plan.`,
        featureGate: {
          type: "feature_gate",
          feature,
          currentTier: orgData.tier,
          requiredTier,
          message: `Upgrade to ${TIER_DISPLAY[requiredTier].label} to unlock ${featureLabel[feature].toLowerCase()}.`,
        },
      });
      return;
    }
    next();
  };
}

function determineRequiredTier(feature: FeatureName): SubscriptionTier {
  switch (feature) {
    case "whiteLabel":
    case "customDomain":
      return "enterprise";
    case "advancedAnalytics":
    case "prioritySupport":
    case "aiRulesAssistant":
    case "whsScoring":
    case "duesBilling":
      return "pro";
    case "marketplace":
    case "shopLockerAccess":
    case "sponsorLogos":
      return "starter";
    case "mobileApp":
    default:
      return "starter";
  }
}

// ─────────────────────────────────────────────────────────────
// Existing middleware (updated to use DB-driven config)
// ─────────────────────────────────────────────────────────────

/**
 * Middleware factory: checks if adding a new tournament exceeds the org's plan limit.
 */
export function gateTournamentCreate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (isNaN(orgId)) { next(); return; }

    const orgData = await getOrgTier(orgId);
    if (!orgData) { next(); return; }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: `Your subscription has lapsed. Renew to continue using your current features.`,
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is ${orgData.tier === "free" ? "free" : "past due or cancelled"}. Please renew to restore access.`,
        },
      });
      return;
    }

    const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
    if (config.maxActiveTournaments === null) { next(); return; }

    const requestedStatus = typeof req.body?.status === "string" ? req.body.status : "draft";
    if (requestedStatus === "draft") { next(); return; }

    const [activeCnt] = await db
      .select({ count: count() })
      .from(tournamentsTable)
      .where(and(
        eq(tournamentsTable.organizationId, orgId),
        sql`${tournamentsTable.status} IN ('active', 'upcoming')`,
      ));

    const current = Number(activeCnt?.count ?? 0);
    if (current >= config.maxActiveTournaments) {
      const nextTier: SubscriptionTier = orgData.effectiveTier === "free" ? "starter" : "pro";
      res.status(402).json({
        error: `Your ${TIER_DISPLAY[orgData.effectiveTier].label} plan allows a maximum of ${config.maxActiveTournaments} active tournament(s). You currently have ${current}.`,
        featureGate: {
          type: "tournament_limit",
          currentTier: orgData.tier,
          requiredTier: nextTier,
          message: `Upgrade to ${TIER_DISPLAY[nextTier].label} to run more tournaments simultaneously.`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Middleware factory: checks if adding a new org member is within the org's plan limits.
 */
export function gateMemberAdd() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (isNaN(orgId)) { next(); return; }

    const orgData = await getOrgTier(orgId);
    if (!orgData) { next(); return; }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: "Your subscription has lapsed. Renew to continue adding members.",
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      });
      return;
    }

    const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
    if (config.maxMembers === null) { next(); return; }

    const [memberCnt] = await db
      .select({ count: count() })
      .from(orgMembershipsTable)
      .where(eq(orgMembershipsTable.organizationId, orgId));

    const current = Number(memberCnt?.count ?? 0);
    if (current >= config.maxMembers) {
      const nextTier: SubscriptionTier = orgData.effectiveTier === "free" ? "starter" : "pro";
      res.status(402).json({
        error: `Your ${TIER_DISPLAY[orgData.effectiveTier].label} plan allows a maximum of ${config.maxMembers} members. You currently have ${current}.`,
        featureGate: {
          type: "member_limit",
          currentTier: orgData.tier,
          requiredTier: nextTier,
          message: `Upgrade to ${TIER_DISPLAY[nextTier].label} to add more members.`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Middleware factory: checks if creating a new league is within the org's plan limits.
 */
export function gateLeagueCreate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (isNaN(orgId)) { next(); return; }

    const orgData = await getOrgTier(orgId);
    if (!orgData) { next(); return; }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: "Your subscription has lapsed. Renew to continue creating leagues.",
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      });
      return;
    }

    const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
    if (config.maxLeagues === null) { next(); return; }

    const [leagueCnt] = await db
      .select({ count: count() })
      .from(leaguesTable)
      .where(eq(leaguesTable.organizationId, orgId));

    const current = Number(leagueCnt?.count ?? 0);
    if (current >= config.maxLeagues) {
      const nextTier: SubscriptionTier = orgData.effectiveTier === "free" ? "starter" : "pro";
      res.status(402).json({
        error: `Your ${TIER_DISPLAY[orgData.effectiveTier].label} plan allows a maximum of ${config.maxLeagues} league(s). You currently have ${current}.`,
        featureGate: {
          type: "league_limit",
          currentTier: orgData.tier,
          requiredTier: nextTier,
          message: `Upgrade to ${TIER_DISPLAY[nextTier].label} to create more leagues.`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Middleware factory: checks if the org's plan includes sponsor logos (Starter+).
 */
export function gateSponsorCreate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (isNaN(orgId)) { next(); return; }

    const orgData = await getOrgTier(orgId);
    if (!orgData) { next(); return; }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: "Your subscription has lapsed. Renew to manage sponsors.",
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      });
      return;
    }

    const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
    if (!config.sponsorLogos) {
      res.status(402).json({
        error: `Sponsor logos are not available on your ${TIER_DISPLAY[orgData.effectiveTier].label} plan.`,
        featureGate: {
          type: "feature_gate",
          feature: "sponsorLogos",
          currentTier: orgData.tier,
          requiredTier: "starter",
          message: `Upgrade to ${TIER_DISPLAY["starter"].label} to unlock sponsor logos.`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Middleware factory: checks if the org's plan includes white-label branding (Enterprise only).
 */
export function gateBranding() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (isNaN(orgId)) { next(); return; }

    const orgData = await getOrgTier(orgId);
    if (!orgData) { next(); return; }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: "Your subscription has lapsed. Renew to manage branding.",
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      });
      return;
    }

    const body = req.body as { customDomain?: unknown };
    if (body?.customDomain !== undefined) {
      const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
      if (!config.customDomain) {
        res.status(402).json({
          error: `Custom domain is not available on your ${TIER_DISPLAY[orgData.effectiveTier].label} plan.`,
          featureGate: {
            type: "feature_gate",
            feature: "customDomain",
            currentTier: orgData.tier,
            requiredTier: "enterprise",
            message: `Upgrade to ${TIER_DISPLAY["enterprise"].label} to unlock custom domain.`,
          },
        });
        return;
      }
    }
    next();
  };
}

/**
 * Middleware factory: checks if the org's plan includes advanced analytics (Pro+).
 */
export function gateAdvancedAnalytics() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const orgId = parseInt(String((req.params as Record<string, string>).orgId));
    if (isNaN(orgId)) { next(); return; }

    const orgData = await getOrgTier(orgId);
    if (!orgData) { next(); return; }

    if (orgData.subscriptionLapsed) {
      res.status(402).json({
        error: "Your subscription has lapsed. Renew to access analytics.",
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      });
      return;
    }

    const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
    if (!config.advancedAnalytics) {
      res.status(402).json({
        error: `Advanced analytics is not available on your ${TIER_DISPLAY[orgData.effectiveTier].label} plan.`,
        featureGate: {
          type: "feature_gate",
          feature: "advancedAnalytics",
          currentTier: orgData.tier,
          requiredTier: "pro",
          message: `Upgrade to ${TIER_DISPLAY["pro"].label} to unlock advanced analytics.`,
        },
      });
      return;
    }
    next();
  };
}

/**
 * Direct (non-middleware) tournament limit check for status transitions.
 */
export async function checkActiveTournamentLimitForTransition(
  orgId: number,
  newStatus: string,
): Promise<null | { status: 402; body: { error: string; featureGate: Record<string, unknown> } }> {
  if (newStatus !== "active" && newStatus !== "upcoming") return null;

  const orgData = await getOrgTier(orgId);
  if (!orgData) return null;

  if (orgData.subscriptionLapsed) {
    return {
      status: 402,
      body: {
        error: "Your subscription has lapsed. Renew to activate tournaments.",
        featureGate: {
          type: "subscription_lapsed",
          currentTier: orgData.tier,
          requiredTier: orgData.tier,
          message: `Your ${TIER_DISPLAY[orgData.tier].label} subscription is past due or cancelled. Please renew to restore access.`,
        },
      },
    };
  }

  const { config } = await getEffectivePlanConfig(orgData.effectiveTier, orgId);
  if (config.maxActiveTournaments === null) return null;

  const [activeCnt] = await db
    .select({ count: count() })
    .from(tournamentsTable)
    .where(and(
      eq(tournamentsTable.organizationId, orgId),
      sql`${tournamentsTable.status} IN ('active', 'upcoming')`,
    ));

  const current = Number(activeCnt?.count ?? 0);
  if (current >= config.maxActiveTournaments) {
    const nextTier: SubscriptionTier = orgData.effectiveTier === "free" ? "starter" : "pro";
    return {
      status: 402,
      body: {
        error: `Your ${TIER_DISPLAY[orgData.effectiveTier].label} plan allows a maximum of ${config.maxActiveTournaments} active tournament(s).`,
        featureGate: {
          type: "tournament_limit",
          currentTier: orgData.tier,
          requiredTier: nextTier,
          message: `Upgrade to ${TIER_DISPLAY[nextTier].label} to run more tournaments simultaneously.`,
        },
      },
    };
  }
  return null;
}

/**
 * Returns tier limits and current usage for an org — used by the frontend
 * to show plan usage and upgrade prompts.
 */
export async function getOrgPlanStatus(orgId: number) {
  const [org] = await db
    .select({
      subscriptionTier: organizationsTable.subscriptionTier,
      subscriptionStatus: organizationsTable.subscriptionStatus,
      isActive: organizationsTable.isActive,
      pendingSubscriptionTier: organizationsTable.pendingSubscriptionTier,
      razorpaySubscriptionId: organizationsTable.razorpaySubscriptionId,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));
  if (!org) return null;

  const tier = org.subscriptionTier as SubscriptionTier;
  const { config, hasActiveOverride } = await getEffectivePlanConfig(tier, orgId);

  const [activeTCount] = await db
    .select({ count: count() })
    .from(tournamentsTable)
    .where(and(
      eq(tournamentsTable.organizationId, orgId),
      sql`${tournamentsTable.status} IN ('active', 'upcoming')`,
    ));

  const [memberCnt] = await db
    .select({ count: count() })
    .from(orgMembershipsTable)
    .where(eq(orgMembershipsTable.organizationId, orgId));

  const [leagueCnt] = await db
    .select({ count: count() })
    .from(leaguesTable)
    .where(eq(leaguesTable.organizationId, orgId));

  return {
    tier,
    subscriptionStatus: org.subscriptionStatus,
    isActive: org.isActive,
    pendingSubscriptionTier: org.pendingSubscriptionTier,
    hasActiveSubscription: !!org.razorpaySubscriptionId,
    hasActiveOverride,
    limits: {
      maxActiveTournaments: config.maxActiveTournaments,
      maxMembers: config.maxMembers,
      maxLeagues: config.maxLeagues,
      whiteLabel: config.whiteLabel,
      sponsorLogos: config.sponsorLogos,
      customDomain: config.customDomain,
      advancedAnalytics: config.advancedAnalytics,
      prioritySupport: config.prioritySupport,
      marketplace: config.marketplace,
      aiRulesAssistant: config.aiRulesAssistant,
      whsScoring: config.whsScoring,
      duesBilling: config.duesBilling,
      shopLockerAccess: config.shopLockerAccess,
      mobileApp: config.mobileApp,
    },
    usage: {
      activeTournaments: Number(activeTCount?.count ?? 0),
      members: Number(memberCnt?.count ?? 0),
      leagues: Number(leagueCnt?.count ?? 0),
    },
    tierDisplay: getTierDisplay(tier),
  };
}
