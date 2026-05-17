/**
 * Dynamic Pricing Engine — Task #367
 *
 * Resolves the effective price per tee slot based on:
 *   1. Base rates from teePricingRulesTable (legacy fallback)
 *   2. Active dynamic pricing tier (day-of-week, time, season, member type, priority)
 *   3. Demand modifiers (utilization, lead-time, weather)
 *   4. Caps & floors from teeDynamicPricingConfigTable
 *
 * Returns base price, final price, breakdown, and a "deal" flag.
 */
import { db } from "@workspace/db";
import {
  teeDynamicPricingTiersTable,
  teeDynamicPricingModifiersTable,
  teeDynamicPricingConfigTable,
  teeDynamicPricingRulesTable,
  teePricingRulesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

export type PricingMemberType = "member" | "guest";

/** W2-G simple pricing rule — admin-built conditions + flat % delta. */
export interface PricingRuleRow {
  id: number;
  name: string;
  conditions: {
    dayOfWeek?: number[];
    timeRange?: [string, string];
    occupancyMin?: number;
    leadTimeHoursMax?: number;
  };
  priceDeltaPct: string;
  priority: number;
  active: boolean;
}

export interface PricingBreakdownStep {
  source: "base" | "tier" | "modifier" | "cap" | "floor" | "twilight" | "rule";
  label: string;
  before: number;
  after: number;
  detail?: Record<string, unknown>;
}

export interface ResolvedPrice {
  basePrice: number;
  finalPrice: number;
  currency: string;
  tierId: number | null;
  tierName: string | null;
  isDeal: boolean;
  dealBadge: string | null;
  breakdown: PricingBreakdownStep[];
}

export interface ResolvePriceInput {
  orgId: number;
  courseId: number;
  slotDate: Date;
  slotTime: string; // "HH:MM"
  capacity?: number;
  bookedCount?: number;
  memberType: PricingMemberType;
  weatherCondition?: string | null;
  /** Reference time for lead-time calculations; defaults to now() */
  asOf?: Date;
}

export interface TierRow {
  id: number;
  name: string;
  courseId: number | null;
  daysOfWeek: number[];
  startTime: string | null;
  endTime: string | null;
  seasonStart: string | null;
  seasonEnd: string | null;
  memberType: "any" | "member" | "guest";
  memberRate: string;
  guestRate: string;
  priority: number;
}

export interface ModifierRow {
  id: number;
  name: string;
  courseId: number | null;
  kind: "utilization" | "lead_time" | "weather";
  thresholdMin: string | null;
  thresholdMax: string | null;
  weatherCondition: string | null;
  adjustmentType: "percent" | "flat";
  adjustmentValue: string;
  applyTo: "any" | "member" | "guest";
  priority: number;
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m ?? 0);
}

function inTimeWindow(slotTime: string, start: string | null, end: string | null): boolean {
  if (!start && !end) return true;
  const m = timeToMinutes(slotTime);
  if (start && m < timeToMinutes(start)) return false;
  if (end && m >= timeToMinutes(end)) return false;
  return true;
}

/** Season window uses MM-DD strings, supports wrapping (e.g. winter Dec→Feb). */
function inSeason(slotDate: Date, start: string | null, end: string | null): boolean {
  if (!start && !end) return true;
  const md = `${String(slotDate.getMonth() + 1).padStart(2, "0")}-${String(slotDate.getDate()).padStart(2, "0")}`;
  if (start && end) {
    return start <= end ? md >= start && md <= end : md >= start || md <= end;
  }
  if (start) return md >= start;
  return end ? md <= end : true;
}

function clampToCaps(price: number, basePrice: number, floorPct: number, ceilingPct: number, breakdown: PricingBreakdownStep[]): number {
  const floor = basePrice * floorPct;
  const ceiling = basePrice * ceilingPct;
  if (price < floor) {
    breakdown.push({ source: "floor", label: `Price floor (${(floorPct * 100).toFixed(0)}% of base)`, before: price, after: floor });
    return floor;
  }
  if (price > ceiling) {
    breakdown.push({ source: "cap", label: `Price ceiling (${(ceilingPct * 100).toFixed(0)}% of base)`, before: price, after: ceiling });
    return ceiling;
  }
  return price;
}

/** Pick highest-priority tier matching all conditions. Returns null if none match. */
function selectBestTier(tiers: TierRow[], slotDate: Date, slotTime: string, courseId: number, memberType: PricingMemberType): TierRow | null {
  const dow = slotDate.getDay();
  const matching = tiers.filter(t =>
    (t.courseId === null || t.courseId === courseId) &&
    (t.daysOfWeek.length === 0 || t.daysOfWeek.includes(dow)) &&
    inTimeWindow(slotTime, t.startTime, t.endTime) &&
    inSeason(slotDate, t.seasonStart, t.seasonEnd) &&
    (t.memberType === "any" || t.memberType === memberType)
  );
  if (matching.length === 0) return null;
  matching.sort((a, b) =>
    b.priority - a.priority ||
    (b.courseId !== null ? 1 : 0) - (a.courseId !== null ? 1 : 0) ||
    (b.memberType !== "any" ? 1 : 0) - (a.memberType !== "any" ? 1 : 0)
  );
  return matching[0];
}


function modifierMatches(
  m: ModifierRow,
  ctx: { utilizationPct: number; leadTimeHours: number; weatherCondition: string | null; courseId: number; memberType: PricingMemberType }
): boolean {
  return evaluateModifier(m, ctx).matched;
}

function applyModifier(price: number, m: ModifierRow): number {
  const v = parseFloat(m.adjustmentValue);
  return m.adjustmentType === "percent" ? price * (1 + v / 100) : price + v;
}

export interface PricingContext {
  legacyRules: {
    memberRate: string | null;
    guestRate: string | null;
    twilightStartTime: string | null;
    twilightMemberRate: string | null;
    twilightGuestRate: string | null;
    currency?: string | null;
  } | null;
  config: {
    enabled: boolean;
    priceFloorPct: string;
    priceCeilingPct: string;
    dealBadgeThresholdPct: string;
    defaultMemberElasticity: string;
    defaultGuestElasticity: string;
  } | null;
  tiers: TierRow[];
  modifiers: ModifierRow[];
  /** Task #1004 — W2-G simple admin-built pricing rules. */
  rules: PricingRuleRow[];
}

/** Load all rows needed by the engine for one org. */
export async function loadPricingContext(orgId: number): Promise<PricingContext> {
  const [legacyRules] = await db.select().from(teePricingRulesTable).where(eq(teePricingRulesTable.organizationId, orgId));
  const [config] = await db.select().from(teeDynamicPricingConfigTable).where(eq(teeDynamicPricingConfigTable.organizationId, orgId));
  const tiers = await db.select({
    id: teeDynamicPricingTiersTable.id,
    name: teeDynamicPricingTiersTable.name,
    courseId: teeDynamicPricingTiersTable.courseId,
    daysOfWeek: teeDynamicPricingTiersTable.daysOfWeek,
    startTime: teeDynamicPricingTiersTable.startTime,
    endTime: teeDynamicPricingTiersTable.endTime,
    seasonStart: teeDynamicPricingTiersTable.seasonStart,
    seasonEnd: teeDynamicPricingTiersTable.seasonEnd,
    memberType: teeDynamicPricingTiersTable.memberType,
    memberRate: teeDynamicPricingTiersTable.memberRate,
    guestRate: teeDynamicPricingTiersTable.guestRate,
    priority: teeDynamicPricingTiersTable.priority,
    isActive: teeDynamicPricingTiersTable.isActive,
  }).from(teeDynamicPricingTiersTable).where(eq(teeDynamicPricingTiersTable.organizationId, orgId));
  const modifiers = await db.select({
    id: teeDynamicPricingModifiersTable.id,
    name: teeDynamicPricingModifiersTable.name,
    courseId: teeDynamicPricingModifiersTable.courseId,
    kind: teeDynamicPricingModifiersTable.kind,
    thresholdMin: teeDynamicPricingModifiersTable.thresholdMin,
    thresholdMax: teeDynamicPricingModifiersTable.thresholdMax,
    weatherCondition: teeDynamicPricingModifiersTable.weatherCondition,
    adjustmentType: teeDynamicPricingModifiersTable.adjustmentType,
    adjustmentValue: teeDynamicPricingModifiersTable.adjustmentValue,
    applyTo: teeDynamicPricingModifiersTable.applyTo,
    priority: teeDynamicPricingModifiersTable.priority,
    isActive: teeDynamicPricingModifiersTable.isActive,
  }).from(teeDynamicPricingModifiersTable).where(eq(teeDynamicPricingModifiersTable.organizationId, orgId));
  return {
    legacyRules: legacyRules ? {
      memberRate: legacyRules.memberRate as string | null,
      guestRate: legacyRules.guestRate as string | null,
      twilightStartTime: legacyRules.twilightStartTime,
      twilightMemberRate: legacyRules.twilightMemberRate as string | null,
      twilightGuestRate: legacyRules.twilightGuestRate as string | null,
      currency: (legacyRules as { currency?: string | null }).currency ?? "INR",
    } : null,
    config: config ? {
      enabled: config.enabled,
      priceFloorPct: config.priceFloorPct,
      priceCeilingPct: config.priceCeilingPct,
      dealBadgeThresholdPct: config.dealBadgeThresholdPct,
      defaultMemberElasticity: (config as { defaultMemberElasticity?: string }).defaultMemberElasticity ?? "-0.20",
      defaultGuestElasticity: (config as { defaultGuestElasticity?: string }).defaultGuestElasticity ?? "-0.70",
    } : null,
    // Filter to active tiers/modifiers, scoped per slot at evaluation time.
    tiers: (tiers as Array<TierRow & { isActive: boolean }>).filter(t => t.isActive),
    modifiers: (modifiers as Array<ModifierRow & { isActive: boolean }>).filter(m => m.isActive),
    rules: (await db.select({
      id: teeDynamicPricingRulesTable.id,
      name: teeDynamicPricingRulesTable.name,
      conditions: teeDynamicPricingRulesTable.conditions,
      priceDeltaPct: teeDynamicPricingRulesTable.priceDeltaPct,
      priority: teeDynamicPricingRulesTable.priority,
      active: teeDynamicPricingRulesTable.active,
    }).from(teeDynamicPricingRulesTable).where(and(
      eq(teeDynamicPricingRulesTable.organizationId, orgId),
      eq(teeDynamicPricingRulesTable.active, true),
    ))).map(r => ({
      id: r.id,
      name: r.name,
      conditions: (r.conditions ?? {}) as PricingRuleRow["conditions"],
      priceDeltaPct: r.priceDeltaPct,
      priority: r.priority,
      active: r.active,
    })),
  };
}

/**
 * Task #1344 — Structured "why didn't this rule match?" output. Each failure
 * describes one condition the slot fell short of, together with the expected
 * value (as authored on the rule) and the slot's actual value, so the UI can
 * say things like "wrong DOW: expected [0,6] but got 3" or "lead-time too
 * long: expected ≤ 24h but got 48.0h". `evaluateRule` collects all failures
 * (not just the first), so a single near-miss row can surface every problem
 * with the slot at once.
 */
export type RuleMatchFailure =
  | { condition: "dayOfWeek"; expected: number[]; actual: number }
  | { condition: "timeRange"; expected: [string, string]; actual: string }
  | { condition: "occupancyMin"; expected: number; actual: number }
  | { condition: "leadTimeHoursMax"; expected: number; actual: number };

export interface RuleEvaluation {
  matched: boolean;
  failures: RuleMatchFailure[];
}

export function evaluateRule(
  rule: PricingRuleRow,
  ctx: { slotDate: Date; slotTime: string; utilizationPct: number; leadTimeHours: number }
): RuleEvaluation {
  const c = rule.conditions ?? {};
  const failures: RuleMatchFailure[] = [];
  if (Array.isArray(c.dayOfWeek) && c.dayOfWeek.length > 0) {
    const actual = ctx.slotDate.getDay();
    if (!c.dayOfWeek.includes(actual)) {
      failures.push({ condition: "dayOfWeek", expected: [...c.dayOfWeek], actual });
    }
  }
  if (Array.isArray(c.timeRange) && c.timeRange.length === 2) {
    const [start, end] = c.timeRange;
    if (!inTimeWindow(ctx.slotTime, start, end)) {
      failures.push({ condition: "timeRange", expected: [start, end], actual: ctx.slotTime });
    }
  }
  if (c.occupancyMin != null) {
    const expected = Number(c.occupancyMin);
    if (ctx.utilizationPct < expected) {
      failures.push({ condition: "occupancyMin", expected, actual: ctx.utilizationPct });
    }
  }
  if (c.leadTimeHoursMax != null) {
    const expected = Number(c.leadTimeHoursMax);
    if (ctx.leadTimeHours > expected) {
      failures.push({ condition: "leadTimeHoursMax", expected, actual: ctx.leadTimeHours });
    }
  }
  return { matched: failures.length === 0, failures };
}

/** Task #1004 — evaluate W2-G admin-built rules against the slot context. */
function ruleMatches(
  rule: PricingRuleRow,
  ctx: { slotDate: Date; slotTime: string; utilizationPct: number; leadTimeHours: number }
): boolean {
  return evaluateRule(rule, ctx).matched;
}

/**
 * Task #1606 — Structured "why didn't this tier match?" output. Mirrors
 * `RuleMatchFailure`: each entry describes one condition the slot fell short
 * of, with the expected value (as authored on the tier) and the slot's actual
 * value, so the UI can say things like "wrong DOW: expected [0,6] but got 3"
 * or "outside time window: expected 06:00–11:00 but got 14:00".
 *
 * `priorityLoss` is special: it means the tier matched all of its own
 * conditions but lost the slot to a higher-priority tier — surfaced so
 * admins can see *which* tier won instead of being told "wrong day of week"
 * by mistake. `zeroRate` is the other special case: the tier won but the
 * rate for this member type is 0, so the engine skips its breakdown step.
 */
export type TierMatchFailure =
  | { condition: "course"; expected: number; actual: number }
  | { condition: "dayOfWeek"; expected: number[]; actual: number }
  | { condition: "timeRange"; expected: [string | null, string | null]; actual: string }
  | { condition: "season"; expected: [string | null, string | null]; actual: string }
  | { condition: "memberType"; expected: "any" | "member" | "guest"; actual: PricingMemberType }
  | { condition: "priorityLoss"; expected: number; actual: { tierId: number; tierName: string; priority: number } }
  | { condition: "zeroRate"; expected: PricingMemberType; actual: 0 };

export interface TierEvaluation {
  matched: boolean;
  failures: TierMatchFailure[];
}

/** Evaluate a tier's own conditions against a slot. Does NOT consider
 * priority/competition with other tiers — callers (e.g. the preview route)
 * layer that on top by running `selectBestTier` over the active tier set. */
export function evaluateTier(
  tier: TierRow,
  ctx: { slotDate: Date; slotTime: string; courseId: number; memberType: PricingMemberType }
): TierEvaluation {
  const failures: TierMatchFailure[] = [];
  if (tier.courseId !== null && tier.courseId !== ctx.courseId) {
    failures.push({ condition: "course", expected: tier.courseId, actual: ctx.courseId });
  }
  if (tier.daysOfWeek.length > 0) {
    const actual = ctx.slotDate.getDay();
    if (!tier.daysOfWeek.includes(actual)) {
      failures.push({ condition: "dayOfWeek", expected: [...tier.daysOfWeek], actual });
    }
  }
  if ((tier.startTime || tier.endTime) && !inTimeWindow(ctx.slotTime, tier.startTime, tier.endTime)) {
    failures.push({
      condition: "timeRange",
      expected: [tier.startTime, tier.endTime],
      actual: ctx.slotTime,
    });
  }
  if ((tier.seasonStart || tier.seasonEnd) && !inSeason(ctx.slotDate, tier.seasonStart, tier.seasonEnd)) {
    const md = `${String(ctx.slotDate.getMonth() + 1).padStart(2, "0")}-${String(ctx.slotDate.getDate()).padStart(2, "0")}`;
    failures.push({
      condition: "season",
      expected: [tier.seasonStart, tier.seasonEnd],
      actual: md,
    });
  }
  if (tier.memberType !== "any" && tier.memberType !== ctx.memberType) {
    failures.push({ condition: "memberType", expected: tier.memberType, actual: ctx.memberType });
  }
  return { matched: failures.length === 0, failures };
}

/**
 * Task #1606 — Structured "why didn't this modifier match?" output. Mirrors
 * `RuleMatchFailure` and `TierMatchFailure`. We split utilisation/lead-time
 * threshold misses into below-min and above-max so the admin sees which side
 * of the band the slot fell off. Weather has its own missing-vs-mismatch
 * split so admins can tell "no forecast attached yet" from "wrong condition
 * configured".
 */
export type ModifierMatchFailure =
  | { condition: "course"; expected: number; actual: number }
  | { condition: "applyTo"; expected: "any" | "member" | "guest"; actual: PricingMemberType }
  | { condition: "utilizationBelowMin"; expected: number; actual: number }
  | { condition: "utilizationAboveMax"; expected: number; actual: number }
  | { condition: "leadTimeBelowMin"; expected: number; actual: number }
  | { condition: "leadTimeAboveMax"; expected: number; actual: number }
  | { condition: "weatherMissing"; expected: string; actual: null }
  | { condition: "weatherMismatch"; expected: string; actual: string };

export interface ModifierEvaluation {
  matched: boolean;
  failures: ModifierMatchFailure[];
}

export function evaluateModifier(
  m: ModifierRow,
  ctx: { utilizationPct: number; leadTimeHours: number; weatherCondition: string | null; courseId: number; memberType: PricingMemberType }
): ModifierEvaluation {
  const failures: ModifierMatchFailure[] = [];
  if (m.courseId !== null && m.courseId !== ctx.courseId) {
    failures.push({ condition: "course", expected: m.courseId, actual: ctx.courseId });
  }
  if (m.applyTo !== "any" && m.applyTo !== ctx.memberType) {
    failures.push({ condition: "applyTo", expected: m.applyTo, actual: ctx.memberType });
  }
  if (m.kind === "utilization") {
    const min = m.thresholdMin != null ? parseFloat(m.thresholdMin) : -Infinity;
    const max = m.thresholdMax != null ? parseFloat(m.thresholdMax) : Infinity;
    if (ctx.utilizationPct < min) {
      failures.push({ condition: "utilizationBelowMin", expected: min, actual: ctx.utilizationPct });
    } else if (ctx.utilizationPct >= max) {
      failures.push({ condition: "utilizationAboveMax", expected: max, actual: ctx.utilizationPct });
    }
  } else if (m.kind === "lead_time") {
    const min = m.thresholdMin != null ? parseFloat(m.thresholdMin) : -Infinity;
    const max = m.thresholdMax != null ? parseFloat(m.thresholdMax) : Infinity;
    if (ctx.leadTimeHours < min) {
      failures.push({ condition: "leadTimeBelowMin", expected: min, actual: ctx.leadTimeHours });
    } else if (ctx.leadTimeHours >= max) {
      failures.push({ condition: "leadTimeAboveMax", expected: max, actual: ctx.leadTimeHours });
    }
  } else if (m.kind === "weather") {
    if (!m.weatherCondition) {
      // Misconfigured modifier — treat as a mismatch with empty expected so
      // the UI can flag it. Use the missing branch since there's nothing to
      // compare against.
      failures.push({ condition: "weatherMissing", expected: "", actual: null });
    } else if (!ctx.weatherCondition) {
      failures.push({ condition: "weatherMissing", expected: m.weatherCondition, actual: null });
    } else if (ctx.weatherCondition.toLowerCase() !== m.weatherCondition.toLowerCase()) {
      failures.push({ condition: "weatherMismatch", expected: m.weatherCondition, actual: ctx.weatherCondition });
    }
  }
  return { matched: failures.length === 0, failures };
}

/** Public re-export for routes — same logic the in-engine selector uses,
 * so the preview route can detect "lost to higher-priority tier" without
 * duplicating the priority/tiebreak rules. */
export function pickBestTier(
  tiers: TierRow[],
  slotDate: Date,
  slotTime: string,
  courseId: number,
  memberType: PricingMemberType
): TierRow | null {
  return selectBestTier(tiers, slotDate, slotTime, courseId, memberType);
}

/** Pure, in-memory price resolution given a pre-loaded context (no DB calls). */
export function resolveEffectivePriceWith(input: ResolvePriceInput, ctx: PricingContext): ResolvedPrice {
  const breakdown: PricingBreakdownStep[] = [];
  const asOf = input.asOf ?? new Date();
  const legacyRules = ctx.legacyRules;
  const config = ctx.config;

  const dynEnabled = config?.enabled ?? false;
  const floorPct = parseFloat(config?.priceFloorPct ?? "0.50");
  const ceilingPct = parseFloat(config?.priceCeilingPct ?? "2.00");
  const dealThresholdPct = parseFloat(config?.dealBadgeThresholdPct ?? "0.85");

  function legacyRate(): number {
    if (!legacyRules) return 0;
    const isTwilight = legacyRules.twilightStartTime && input.slotTime >= legacyRules.twilightStartTime;
    if (input.memberType === "guest") {
      const r = (isTwilight && legacyRules.twilightGuestRate != null) ? legacyRules.twilightGuestRate : legacyRules.guestRate;
      return parseFloat(String(r ?? "0"));
    }
    const r = (isTwilight && legacyRules.twilightMemberRate != null) ? legacyRules.twilightMemberRate : legacyRules.memberRate;
    return parseFloat(String(r ?? "0"));
  }

  const basePrice = legacyRate();
  let price = basePrice;
  breakdown.push({ source: "base", label: `Base rate (${input.memberType})`, before: 0, after: price });

  // Pre-compute slot context shared by modifier + rule evaluation. We need
  // these even on the dyn-disabled fast path so rules can fire standalone.
  const utilizationPct = (input.capacity && input.capacity > 0)
    ? (input.bookedCount ?? 0) / input.capacity
    : 0;
  const slotDateTime = new Date(input.slotDate);
  const [hh, mm] = input.slotTime.split(":").map(Number);
  slotDateTime.setHours(hh, mm ?? 0, 0, 0);
  const leadTimeHours = Math.max(0, (slotDateTime.getTime() - asOf.getTime()) / 3_600_000);

  function applyRules(p: number): number {
    const sortedRules = [...ctx.rules].sort((a, b) => b.priority - a.priority);
    let cur = p;
    for (const rule of sortedRules) {
      if (ruleMatches(rule, { slotDate: input.slotDate, slotTime: input.slotTime, utilizationPct, leadTimeHours })) {
        const deltaPct = parseFloat(rule.priceDeltaPct);
        if (Number.isFinite(deltaPct) && deltaPct !== 0) {
          const before = cur;
          cur = cur * (1 + deltaPct / 100);
          breakdown.push({
            source: "rule",
            label: `Rule: ${rule.name} (${deltaPct > 0 ? "+" : ""}${deltaPct}%)`,
            before, after: cur,
            detail: { ruleId: rule.id, conditions: rule.conditions },
          });
        }
      }
    }
    return cur;
  }

  if (!dynEnabled) {
    // Rules still apply even if the full tier/modifier engine is off — they're
    // a simpler, opt-in primitive admins can use without the full setup.
    price = applyRules(price);
    price = Math.round(price * 100) / 100;
    return {
      basePrice, finalPrice: price, currency: legacyRules?.currency ?? "INR",
      tierId: null, tierName: null, isDeal: false, dealBadge: null, breakdown,
    };
  }

  const scopedTiers = ctx.tiers.filter(t => t.courseId === null || t.courseId === input.courseId);
  const tier = selectBestTier(scopedTiers, input.slotDate, input.slotTime, input.courseId, input.memberType);
  let tierId: number | null = null;
  let tierName: string | null = null;
  if (tier) {
    tierId = tier.id;
    tierName = tier.name;
    const tierPrice = parseFloat(input.memberType === "guest" ? tier.guestRate : tier.memberRate);
    if (tierPrice > 0) {
      breakdown.push({ source: "tier", label: `Tier: ${tier.name}`, before: price, after: tierPrice, detail: { tierId: tier.id } });
      price = tierPrice;
    }
  }

  const refBase = price > 0 ? price : basePrice;

  const sorted = [...ctx.modifiers].sort((a, b) => b.priority - a.priority);
  for (const mod of sorted) {
    if (modifierMatches(mod, {
      utilizationPct, leadTimeHours,
      weatherCondition: input.weatherCondition ?? null,
      courseId: input.courseId, memberType: input.memberType,
    })) {
      const before = price;
      price = applyModifier(price, mod);
      breakdown.push({
        source: "modifier",
        label: `${mod.kind}: ${mod.name} (${mod.adjustmentType === "percent" ? `${parseFloat(mod.adjustmentValue) > 0 ? "+" : ""}${mod.adjustmentValue}%` : `${parseFloat(mod.adjustmentValue) > 0 ? "+" : ""}${mod.adjustmentValue}`})`,
        before, after: price,
        detail: { modifierId: mod.id, kind: mod.kind, utilizationPct, leadTimeHours },
      });
    }
  }

  // Task #1004 — admin-built rules apply after modifiers but before caps so
  // an aggressive +20% rule still respects the configured ceiling.
  price = applyRules(price);

  if (refBase > 0) {
    price = clampToCaps(price, refBase, floorPct, ceilingPct, breakdown);
  }
  price = Math.round(price * 100) / 100;

  const isDeal = basePrice > 0 && price < basePrice * dealThresholdPct;
  const dealBadge = isDeal ? `Save ${Math.round((1 - price / basePrice) * 100)}%` : null;

  return {
    basePrice, finalPrice: price, currency: legacyRules?.currency ?? "INR",
    tierId, tierName, isDeal, dealBadge, breakdown,
  };
}

export async function resolveEffectivePrice(input: ResolvePriceInput): Promise<ResolvedPrice> {
  const ctx = await loadPricingContext(input.orgId);
  return resolveEffectivePriceWith(input, ctx);
}

/** Helper for booking flow — returns memberRate/guestRate strings the existing code expects. */
export async function resolveBookingRates(opts: {
  orgId: number; courseId: number; slotDate: Date; slotTime: string;
  capacity: number; bookedCount: number;
}): Promise<{ memberRate: string; guestRate: string; memberPricing: ResolvedPrice; guestPricing: ResolvedPrice }> {
  const memberPricing = await resolveEffectivePrice({ ...opts, memberType: "member" });
  const guestPricing = await resolveEffectivePrice({ ...opts, memberType: "guest" });
  return {
    memberRate: memberPricing.finalPrice.toFixed(2),
    guestRate: guestPricing.finalPrice.toFixed(2),
    memberPricing, guestPricing,
  };
}
