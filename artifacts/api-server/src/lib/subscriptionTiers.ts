export type SubscriptionTier = "free" | "starter" | "pro" | "enterprise";

export const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = [
  "free",
  "starter",
  "pro",
  "enterprise",
] as const;

/**
 * Service-layer validator for subscription tier writes. The DB column is the
 * `subscription_tier` enum so Postgres will reject anything outside the
 * canonical set, but raw enum errors surface as opaque 500s. Validating here
 * lets the API return a clear 400 and matches the migration in
 * `lib/db/drizzle/0056_normalize_subscription_tier.sql` which keeps existing
 * rows on canonical values.
 */
export function isSubscriptionTier(value: unknown): value is SubscriptionTier {
  return typeof value === "string"
    && (SUBSCRIPTION_TIERS as readonly string[]).includes(value);
}

/**
 * Task #1905 — Comparator over the canonical tier ladder
 * (`free < starter < pro < enterprise`). Returns negative when `a` is
 * cheaper than `b`, positive when `a` is more expensive, and zero when
 * they're the same tier. Callers should pre-filter inputs through
 * {@link isSubscriptionTier} since the ordering is undefined for
 * unknown slugs.
 */
export function compareSubscriptionTiers(a: SubscriptionTier, b: SubscriptionTier): number {
  return SUBSCRIPTION_TIERS.indexOf(a) - SUBSCRIPTION_TIERS.indexOf(b);
}

/**
 * Task #1905 — Was the move from `from` to `to` a downgrade on the
 * canonical tier ladder? Used by the Stripe and Razorpay webhook
 * handlers to fan out a realtime super-admin alert when a paying club
 * drops to a cheaper plan (e.g. enterprise → starter), mirroring the
 * cancellation alert path.
 *
 * Returns `false` when:
 *   - `from` is null/undefined/non-canonical (we can't safely classify
 *     a downgrade if we don't know the prior tier),
 *   - `from === to` (same-tier renewal — silent), or
 *   - `to` is more expensive than `from` (genuine upgrade — silent).
 */
export function isTierDowngrade(
  from: string | null | undefined,
  to: SubscriptionTier,
): boolean {
  if (!isSubscriptionTier(from)) return false;
  return compareSubscriptionTiers(to, from) < 0;
}

export interface TierLimits {
  maxActiveTournaments: number | null;
  maxMembers: number | null;
  maxLeagues: number | null;
  whiteLabel: boolean;
  sponsorLogos: boolean;
  customDomain: boolean;
  advancedAnalytics: boolean;
  prioritySupport: boolean;
}

export const TIER_LIMITS: Record<SubscriptionTier, TierLimits> = {
  free: {
    maxActiveTournaments: 1,
    maxMembers: 50,
    maxLeagues: 1,
    whiteLabel: false,
    sponsorLogos: false,
    customDomain: false,
    advancedAnalytics: false,
    prioritySupport: false,
  },
  starter: {
    maxActiveTournaments: 5,
    maxMembers: 200,
    maxLeagues: 3,
    whiteLabel: false,
    sponsorLogos: true,
    customDomain: false,
    advancedAnalytics: false,
    prioritySupport: false,
  },
  pro: {
    maxActiveTournaments: null,
    maxMembers: null,
    maxLeagues: null,
    whiteLabel: false,
    sponsorLogos: true,
    customDomain: false,
    advancedAnalytics: true,
    prioritySupport: true,
  },
  enterprise: {
    maxActiveTournaments: null,
    maxMembers: null,
    maxLeagues: null,
    whiteLabel: true,
    sponsorLogos: true,
    customDomain: true,
    advancedAnalytics: true,
    prioritySupport: true,
  },
};

export const TIER_DISPLAY: Record<SubscriptionTier, { label: string; priceMonthly: number; currency: string; description: string }> = {
  free: {
    label: "Free",
    priceMonthly: 0,
    currency: "INR",
    description: "Perfect for small clubs just getting started",
  },
  starter: {
    label: "Starter",
    priceMonthly: 2999,
    currency: "INR",
    description: "For growing clubs with regular tournaments",
  },
  pro: {
    label: "Pro",
    priceMonthly: 7999,
    currency: "INR",
    description: "Unlimited everything for established clubs",
  },
  enterprise: {
    label: "Enterprise",
    priceMonthly: 19999,
    currency: "INR",
    description: "Full platform control with white-label branding",
  },
};

export type TierDisplay = { label: string; priceMonthly: number; currency: string; description: string };

/**
 * Always-defined tier display lookup.
 *
 * The `organizations.subscription_tier` column is a free-form text field that
 * predates the SubscriptionTier union, so legacy rows can still hold values
 * outside `free|starter|pro|enterprise` (e.g. discontinued plan slugs). The
 * `/plan` API and any UI that renders a plan badge must never receive an
 * `undefined` here, otherwise the sidebar crashes with
 * "Cannot read properties of undefined (reading 'label')".
 *
 * For unknown tiers we degrade gracefully: keep the raw tier string as the
 * label (Title-cased) and reuse the Free tier's pricing/description so the
 * shape is always complete.
 */
export function getTierDisplay(tier: string | null | undefined): TierDisplay {
  if (tier && (tier in TIER_DISPLAY)) {
    return TIER_DISPLAY[tier as SubscriptionTier];
  }
  const raw = (tier ?? "").trim();
  const label = raw.length > 0
    ? raw.charAt(0).toUpperCase() + raw.slice(1)
    : TIER_DISPLAY.free.label;
  return {
    label,
    priceMonthly: TIER_DISPLAY.free.priceMonthly,
    currency: TIER_DISPLAY.free.currency,
    description: TIER_DISPLAY.free.description,
  };
}

export interface FeatureGateResult {
  allowed: boolean;
  reason?: string;
  upgrade?: {
    currentTier: SubscriptionTier;
    requiredTier: SubscriptionTier;
    message: string;
  };
}

export function checkTournamentLimit(tier: SubscriptionTier, currentActiveTournaments: number): FeatureGateResult {
  const limits = TIER_LIMITS[tier];
  if (limits.maxActiveTournaments === null) return { allowed: true };
  if (currentActiveTournaments >= limits.maxActiveTournaments) {
    const nextTier = tier === "free" ? "starter" : "pro";
    return {
      allowed: false,
      reason: `Your ${TIER_DISPLAY[tier].label} plan allows a maximum of ${limits.maxActiveTournaments} active tournament(s). You currently have ${currentActiveTournaments}.`,
      upgrade: {
        currentTier: tier,
        requiredTier: nextTier as SubscriptionTier,
        message: `Upgrade to ${TIER_DISPLAY[nextTier as SubscriptionTier].label} to run more tournaments simultaneously.`,
      },
    };
  }
  return { allowed: true };
}

export function checkMemberLimit(tier: SubscriptionTier, currentMembers: number): FeatureGateResult {
  const limits = TIER_LIMITS[tier];
  if (limits.maxMembers === null) return { allowed: true };
  if (currentMembers >= limits.maxMembers) {
    const nextTier = tier === "free" ? "starter" : "pro";
    return {
      allowed: false,
      reason: `Your ${TIER_DISPLAY[tier].label} plan allows a maximum of ${limits.maxMembers} members. You currently have ${currentMembers}.`,
      upgrade: {
        currentTier: tier,
        requiredTier: nextTier as SubscriptionTier,
        message: `Upgrade to ${TIER_DISPLAY[nextTier as SubscriptionTier].label} to add more members.`,
      },
    };
  }
  return { allowed: true };
}

export function checkLeagueLimit(tier: SubscriptionTier, currentLeagues: number): FeatureGateResult {
  const limits = TIER_LIMITS[tier];
  if (limits.maxLeagues === null) return { allowed: true };
  if (currentLeagues >= limits.maxLeagues) {
    const nextTier = tier === "free" ? "starter" : "pro";
    return {
      allowed: false,
      reason: `Your ${TIER_DISPLAY[tier].label} plan allows a maximum of ${limits.maxLeagues} league(s). You currently have ${currentLeagues}.`,
      upgrade: {
        currentTier: tier,
        requiredTier: nextTier as SubscriptionTier,
        message: `Upgrade to ${TIER_DISPLAY[nextTier as SubscriptionTier].label} to create more leagues.`,
      },
    };
  }
  return { allowed: true };
}

export function checkFeatureAccess(tier: SubscriptionTier, feature: keyof Pick<TierLimits, "whiteLabel" | "sponsorLogos" | "customDomain" | "advancedAnalytics" | "prioritySupport">): FeatureGateResult {
  const limits = TIER_LIMITS[tier];
  if (limits[feature]) return { allowed: true };

  const featureNames: Record<string, string> = {
    whiteLabel: "White-label branding",
    sponsorLogos: "Sponsor logos",
    customDomain: "Custom domain",
    advancedAnalytics: "Advanced analytics",
    prioritySupport: "Priority support",
  };

  const requiredTier: SubscriptionTier = feature === "whiteLabel" || feature === "customDomain" ? "enterprise"
    : feature === "advancedAnalytics" || feature === "prioritySupport" ? "pro"
    : "starter";

  return {
    allowed: false,
    reason: `${featureNames[feature]} is not available on your ${TIER_DISPLAY[tier].label} plan.`,
    upgrade: {
      currentTier: tier,
      requiredTier,
      message: `Upgrade to ${TIER_DISPLAY[requiredTier].label} to unlock ${featureNames[feature].toLowerCase()}.`,
    },
  };
}
