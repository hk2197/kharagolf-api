/**
 * Dynamic Pricing & Yield Management API — Task #367
 * All routes scoped under /organizations/:orgId/tee-pricing
 *
 *   GET    /config                         Get org dynamic pricing config (caps/floors/enabled)
 *   PUT    /config                         Upsert config; toggling enabled writes audit
 *   GET    /tiers                          List pricing tiers
 *   POST   /tiers                          Create tier
 *   PATCH  /tiers/:id                      Update tier
 *   DELETE /tiers/:id                      Delete tier
 *   POST   /tiers/:id/activate             Activate (isActive=true) + audit
 *   POST   /tiers/:id/deactivate           Deactivate + audit (rollback)
 *   GET    /modifiers                      List demand modifiers
 *   POST   /modifiers                      Create
 *   PATCH  /modifiers/:id                  Update
 *   DELETE /modifiers/:id                  Delete
 *   POST   /preview                        Preview effective price for a slot/window
 *   POST   /preview-calendar               Preview price grid (date range × times)
 *   GET    /effective-price                Resolve effective price for a single slot
 *   GET    /audit                          Audit log
 *   GET    /yield-report                   Yield report (revenue, fill, uplift)
 */
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, pool } from "@workspace/db";
import {
  teeDynamicPricingTiersTable,
  teeDynamicPricingModifiersTable,
  teeDynamicPricingConfigTable,
  teeDynamicPricingCourseElasticityTable,
  teeDynamicPricingAuditTable,
  teeDynamicPricingRulesTable,
  teePricingForecastsTable,
  courseTeeSlotTable,
  teeBookingsTable,
  forecastAccuracyEmailSchedulesTable,
  forecastAccuracyEmailRunsTable,
  organizationsTable,
  orgMembershipsTable,
  appUsersTable,
  coursesTable,
} from "@workspace/db";
import { and, eq, desc, sql, lte, gte, inArray, isNull, isNotNull } from "drizzle-orm";
import {
  buildForecastAccuracyScheduleEmailContent,
  sendForecastAccuracyScheduleEmail,
} from "../lib/mailer";
import { requireOrgAdmin } from "../lib/permissions";
import {
  resolveEffectivePrice,
  resolveEffectivePriceWith,
  loadPricingContext,
  evaluateRule,
  evaluateTier,
  evaluateModifier,
  pickBestTier,
  type PricingContext,
  type TierRow,
  type ModifierRow,
  type PricingRuleRow,
  type PricingMemberType,
  type PricingBreakdownStep,
  type RuleMatchFailure,
  type TierMatchFailure,
  type ModifierMatchFailure,
} from "../lib/dynamicPricing";
import { logger } from "../lib/logger";
import { getDailyForecast, type DailyForecast as DailyWeatherForecast } from "../lib/weather";

const router: IRouter = Router({ mergeParams: true });

function getActorId(req: Request): number | null {
  return req.user?.id ? Number(req.user.id) : null;
}

async function logAudit(orgId: number, actorUserId: number | null, action: string, entityType: string, entityId: number | null, payload: unknown, notes?: string) {
  try {
    await db.insert(teeDynamicPricingAuditTable).values({
      organizationId: orgId, actorUserId, action, entityType, entityId,
      payload: payload as object, notes: notes ?? null,
    });
  } catch (err) {
    logger.warn({ err }, "[teePricing] audit insert failed");
  }
}

// Clamp the elasticity coefficient to a sane range. Demand elasticity for
// recreational golf is typically reported between -0.3 and -1.5; we accept a
// wider band but reject extreme values that would produce nonsensical demand.
// Members are typically far less price-sensitive than walk-in guests, so we
// expose distinct defaults per segment. Hoisted above the route definitions
// so both the org-config handler and the per-course override handler
// (Task #822) can reuse the same clamp + defaults.
const DEFAULT_MEMBER_ELASTICITY = -0.2;
const DEFAULT_GUEST_ELASTICITY = -0.7;
function clampElasticity(raw: unknown, fallback: number): number {
  const n = typeof raw === "number" ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-3, Math.min(0, n));
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-pricing/config", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [cfg] = await db.select().from(teeDynamicPricingConfigTable).where(eq(teeDynamicPricingConfigTable.organizationId, orgId));
  res.json(cfg ?? {
    organizationId: orgId, enabled: false,
    priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
    defaultMemberElasticity: "-0.20", defaultGuestElasticity: "-0.70",
  });
});

router.put("/organizations/:orgId/tee-pricing/config", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { enabled, priceFloorPct, priceCeilingPct, dealBadgeThresholdPct, defaultMemberElasticity, defaultGuestElasticity } = req.body;
  const [prev] = await db.select().from(teeDynamicPricingConfigTable).where(eq(teeDynamicPricingConfigTable.organizationId, orgId));
  const fields = {
    enabled: enabled === true,
    priceFloorPct: priceFloorPct != null ? String(priceFloorPct) : "0.50",
    priceCeilingPct: priceCeilingPct != null ? String(priceCeilingPct) : "2.00",
    dealBadgeThresholdPct: dealBadgeThresholdPct != null ? String(dealBadgeThresholdPct) : "0.85",
    defaultMemberElasticity: defaultMemberElasticity != null
      ? String(clampElasticity(defaultMemberElasticity, DEFAULT_MEMBER_ELASTICITY))
      : (prev?.defaultMemberElasticity ?? "-0.20"),
    defaultGuestElasticity: defaultGuestElasticity != null
      ? String(clampElasticity(defaultGuestElasticity, DEFAULT_GUEST_ELASTICITY))
      : (prev?.defaultGuestElasticity ?? "-0.70"),
  };
  const [cfg] = await db.insert(teeDynamicPricingConfigTable).values({
    organizationId: orgId, ...fields,
  }).onConflictDoUpdate({
    target: teeDynamicPricingConfigTable.organizationId,
    set: { ...fields, updatedAt: new Date() },
  }).returning();
  await logAudit(orgId, getActorId(req),
    prev?.enabled !== fields.enabled ? (fields.enabled ? "config.activated" : "config.deactivated") : "config.updated",
    "config", null, { previous: prev, next: cfg });
  res.json(cfg);
});

// ─── PER-COURSE ELASTICITY OVERRIDES (Task #822) ────────────────────────────
//
// The org-level config above carries the default member/guest elasticities
// the forecast falls back to. Resort, municipal, and members-only courses
// behave very differently though, so admins can layer per-course overrides
// on top via these endpoints. Either segment may be NULL on a row, in which
// case that segment inherits the org default for forecasts on that course.

router.get("/organizations/:orgId/tee-pricing/course-elasticity", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rows = await db.select().from(teeDynamicPricingCourseElasticityTable)
    .where(eq(teeDynamicPricingCourseElasticityTable.organizationId, orgId))
    .orderBy(teeDynamicPricingCourseElasticityTable.courseId);
  res.json(rows);
});

router.put("/organizations/:orgId/tee-pricing/course-elasticity/:courseId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  if (!Number.isFinite(courseId)) { { res.status(400).json({ error: "courseId required" }); return; } }
  const { memberElasticity, guestElasticity } = req.body ?? {};
  // null/undefined means "inherit org default for this segment"; numbers are
  // clamped to the same [-3, 0] band the org-level fields use.
  const member = memberElasticity == null
    ? null
    : String(clampElasticity(memberElasticity, DEFAULT_MEMBER_ELASTICITY));
  const guest = guestElasticity == null
    ? null
    : String(clampElasticity(guestElasticity, DEFAULT_GUEST_ELASTICITY));
  const [prev] = await db.select().from(teeDynamicPricingCourseElasticityTable)
    .where(and(
      eq(teeDynamicPricingCourseElasticityTable.organizationId, orgId),
      eq(teeDynamicPricingCourseElasticityTable.courseId, courseId),
    ));
  const [row] = await db.insert(teeDynamicPricingCourseElasticityTable).values({
    organizationId: orgId, courseId,
    memberElasticity: member, guestElasticity: guest,
  }).onConflictDoUpdate({
    target: [teeDynamicPricingCourseElasticityTable.organizationId, teeDynamicPricingCourseElasticityTable.courseId],
    set: { memberElasticity: member, guestElasticity: guest, updatedAt: new Date() },
  }).returning();
  await logAudit(orgId, getActorId(req),
    prev ? "course_elasticity.updated" : "course_elasticity.created",
    "course_elasticity", courseId, { previous: prev ?? null, next: row });
  res.json(row);
});

router.delete("/organizations/:orgId/tee-pricing/course-elasticity/:courseId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [prev] = await db.select().from(teeDynamicPricingCourseElasticityTable)
    .where(and(
      eq(teeDynamicPricingCourseElasticityTable.organizationId, orgId),
      eq(teeDynamicPricingCourseElasticityTable.courseId, courseId),
    ));
  if (!prev) { { res.status(404).json({ error: "Override not found" }); return; } }
  await db.delete(teeDynamicPricingCourseElasticityTable)
    .where(and(
      eq(teeDynamicPricingCourseElasticityTable.organizationId, orgId),
      eq(teeDynamicPricingCourseElasticityTable.courseId, courseId),
    ));
  await logAudit(orgId, getActorId(req), "course_elasticity.deleted", "course_elasticity", courseId, prev);
  res.json({ success: true });
});

// ─── TIERS ──────────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-pricing/tiers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rows = await db.select().from(teeDynamicPricingTiersTable)
    .where(eq(teeDynamicPricingTiersTable.organizationId, orgId))
    .orderBy(desc(teeDynamicPricingTiersTable.priority), teeDynamicPricingTiersTable.name);
  res.json(rows);
});

// Task #1103 — sibling endpoint that returns the most recent
// `publish:tier-<id>` forecast snapshot per tier. The pricing UI uses
// this to surface a "last projection" badge inline on each tier card so
// admins can see what they promised at publish time without leaving the
// tier list. We pick the latest `active`-scenario row per label so the
// number reflects the post-publish projection (not the pre-publish
// draft) for that publish event.
router.get("/organizations/:orgId/tee-pricing/tiers/publish-snapshots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const result = await pool.query(`
    SELECT DISTINCT ON (label)
      label,
      scenario,
      horizon_days,
      window_start,
      window_end,
      projected_revenue,
      projected_avg_price,
      projected_seats_booked,
      projected_seats_total,
      created_at
    FROM tee_pricing_forecasts
    WHERE organization_id = $1
      AND scenario = 'active'
      AND label LIKE 'publish:tier-%'
    ORDER BY label, created_at DESC
  `, [orgId]);
  const snapshots: Record<string, {
    tierId: number;
    label: string;
    scenario: string;
    horizonDays: number;
    windowStart: string;
    windowEnd: string;
    projectedRevenue: number;
    projectedAvgPrice: number;
    projectedSeatsBooked: number;
    projectedSeatsTotal: number;
    createdAt: string;
  }> = {};
  const toDateStr = (v: unknown) => v instanceof Date ? v.toISOString().split("T")[0] : String(v);
  const toIso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v);
  for (const r of result.rows) {
    const m = String(r.label).match(/^publish:tier-(\d+)$/);
    if (!m) continue;
    const tierId = parseInt(m[1]);
    snapshots[String(tierId)] = {
      tierId,
      label: String(r.label),
      scenario: String(r.scenario),
      horizonDays: Number(r.horizon_days),
      windowStart: toDateStr(r.window_start),
      windowEnd: toDateStr(r.window_end),
      projectedRevenue: Number(r.projected_revenue),
      projectedAvgPrice: Number(r.projected_avg_price),
      projectedSeatsBooked: Number(r.projected_seats_booked),
      projectedSeatsTotal: Number(r.projected_seats_total),
      createdAt: toIso(r.created_at),
    };
  }
  res.json({ snapshots });
});

router.post("/organizations/:orgId/tee-pricing/tiers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body;
  if (!b.name) { { res.status(400).json({ error: "name required" }); return; } }
  const [tier] = await db.insert(teeDynamicPricingTiersTable).values({
    organizationId: orgId,
    courseId: b.courseId ?? null,
    name: b.name,
    description: b.description ?? null,
    daysOfWeek: Array.isArray(b.daysOfWeek) ? b.daysOfWeek : [0,1,2,3,4,5,6],
    startTime: b.startTime ?? null,
    endTime: b.endTime ?? null,
    seasonStart: b.seasonStart ?? null,
    seasonEnd: b.seasonEnd ?? null,
    memberType: b.memberType ?? "any",
    memberRate: String(b.memberRate ?? 0),
    guestRate: String(b.guestRate ?? 0),
    priority: b.priority ?? 0,
    isActive: b.isActive !== false,
  }).returning();
  await logAudit(orgId, getActorId(req), "tier.created", "tier", tier.id, tier);
  res.status(201).json(tier);
});

router.patch("/organizations/:orgId/tee-pricing/tiers/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body;
  const [prev] = await db.select().from(teeDynamicPricingTiersTable)
    .where(and(eq(teeDynamicPricingTiersTable.id, id), eq(teeDynamicPricingTiersTable.organizationId, orgId)));
  if (!prev) { { res.status(404).json({ error: "Tier not found" }); return; } }
  const [tier] = await db.update(teeDynamicPricingTiersTable).set({
    ...(b.courseId !== undefined && { courseId: b.courseId }),
    ...(b.name !== undefined && { name: b.name }),
    ...(b.description !== undefined && { description: b.description }),
    ...(b.daysOfWeek !== undefined && { daysOfWeek: b.daysOfWeek }),
    ...(b.startTime !== undefined && { startTime: b.startTime }),
    ...(b.endTime !== undefined && { endTime: b.endTime }),
    ...(b.seasonStart !== undefined && { seasonStart: b.seasonStart }),
    ...(b.seasonEnd !== undefined && { seasonEnd: b.seasonEnd }),
    ...(b.memberType !== undefined && { memberType: b.memberType }),
    ...(b.memberRate !== undefined && { memberRate: String(b.memberRate) }),
    ...(b.guestRate !== undefined && { guestRate: String(b.guestRate) }),
    ...(b.priority !== undefined && { priority: b.priority }),
    ...(b.isActive !== undefined && { isActive: b.isActive }),
    updatedAt: new Date(),
  }).where(and(eq(teeDynamicPricingTiersTable.id, id), eq(teeDynamicPricingTiersTable.organizationId, orgId))).returning();
  await logAudit(orgId, getActorId(req), "tier.updated", "tier", id, { previous: prev, next: tier });
  res.json(tier);
});

router.delete("/organizations/:orgId/tee-pricing/tiers/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [prev] = await db.select().from(teeDynamicPricingTiersTable)
    .where(and(eq(teeDynamicPricingTiersTable.id, id), eq(teeDynamicPricingTiersTable.organizationId, orgId)));
  if (!prev) { { res.status(404).json({ error: "Tier not found" }); return; } }
  await db.delete(teeDynamicPricingTiersTable)
    .where(and(eq(teeDynamicPricingTiersTable.id, id), eq(teeDynamicPricingTiersTable.organizationId, orgId)));
  await logAudit(orgId, getActorId(req), "tier.deleted", "tier", id, prev);
  res.json({ success: true });
});

router.post("/organizations/:orgId/tee-pricing/tiers/:id/activate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [tier] = await db.update(teeDynamicPricingTiersTable)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(teeDynamicPricingTiersTable.id, id), eq(teeDynamicPricingTiersTable.organizationId, orgId)))
    .returning();
  if (!tier) { { res.status(404).json({ error: "Tier not found" }); return; } }
  await logAudit(orgId, getActorId(req), "tier.activated", "tier", id, tier);
  // Task #954 — record a forecast snapshot at the moment of publish so we
  // can later score the projection against realised revenue. Best-effort:
  // a forecast persistence failure must not break the publish action.
  recordPublishForecast(orgId, getActorId(req), `publish:tier-${id}`, tier.courseId);
  res.json(tier);
});

router.post("/organizations/:orgId/tee-pricing/tiers/:id/deactivate", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [tier] = await db.update(teeDynamicPricingTiersTable)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(teeDynamicPricingTiersTable.id, id), eq(teeDynamicPricingTiersTable.organizationId, orgId)))
    .returning();
  if (!tier) { { res.status(404).json({ error: "Tier not found" }); return; } }
  await logAudit(orgId, getActorId(req), "tier.deactivated", "tier", id, tier, req.body?.notes ?? "Rollback");
  // Task #954 — same publish-time snapshot as activate above; deactivation
  // is also a published change to the live pricing rules.
  recordPublishForecast(orgId, getActorId(req), `publish:tier-${id}`, tier.courseId);
  res.json(tier);
});

// Task #1345 — preview which upcoming open slots in the next N days (default
// 7) would resolve to this tier as their base price. Mirrors the rule
// preview (Task #1163): we inject the tier into the pricing context
// (overriding any active row of the same id), force the dyn engine on
// just for this evaluation so admins can preview before flipping the
// engine switch, evaluate every open slot in the window, and return the
// slots whose breakdown contains a "tier" step matching this id.
router.post("/organizations/:orgId/tee-pricing/tiers/:id/preview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tierId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const days = Math.min(31, Math.max(1, Number(req.body?.days) || 7));
  const courseId: number | null = req.body?.courseId != null ? Number(req.body.courseId) : null;
  const memberType: PricingMemberType = req.body?.memberType === "guest" ? "guest" : "member";
  // Task #1606 — near-miss limit mirrors the rule preview (Task #1344). Junk
  // input falls back to the default of 5 rather than silently disabling the
  // section, which would surprise an admin debugging a tier.
  const rawTierLimit = req.body?.nearMissLimit;
  const parsedTierLimit = rawTierLimit != null ? Number(rawTierLimit) : 5;
  const nearMissLimit = Number.isFinite(parsedTierLimit)
    ? Math.min(25, Math.max(0, Math.floor(parsedTierLimit)))
    : 5;

  const [tier] = await db.select().from(teeDynamicPricingTiersTable).where(and(
    eq(teeDynamicPricingTiersTable.id, tierId),
    eq(teeDynamicPricingTiersTable.organizationId, orgId),
  ));
  if (!tier) { { res.status(404).json({ error: "Tier not found" }); return; } }

  const ctx = await loadPricingContext(orgId);
  const tierRow: TierRow = {
    id: tier.id,
    name: tier.name,
    courseId: tier.courseId,
    daysOfWeek: tier.daysOfWeek,
    startTime: tier.startTime,
    endTime: tier.endTime,
    seasonStart: tier.seasonStart,
    seasonEnd: tier.seasonEnd,
    memberType: tier.memberType as TierRow["memberType"],
    memberRate: tier.memberRate,
    guestRate: tier.guestRate,
    priority: tier.priority,
  };
  // Replace any active version of the same tier in ctx, or inject if absent
  // (loadPricingContext drops inactive tiers). This lets admins preview a
  // tier still in draft before publishing it.
  ctx.tiers = [tierRow, ...ctx.tiers.filter(t => t.id !== tier.id)];
  // Force the engine on for this evaluation only — tiers are otherwise
  // skipped on the dyn-disabled fast path, which would defeat the
  // preview's whole purpose for orgs that haven't enabled the engine yet.
  if (ctx.config) ctx.config = { ...ctx.config, enabled: true };
  else ctx.config = {
    enabled: true, priceFloorPct: "0.50", priceCeilingPct: "2.00",
    dealBadgeThresholdPct: "0.85",
    defaultMemberElasticity: "-0.20", defaultGuestElasticity: "-0.70",
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonEnd = new Date(today);
  horizonEnd.setDate(horizonEnd.getDate() + days);

  const params: unknown[] = [orgId, today.toISOString().split("T")[0], horizonEnd.toISOString().split("T")[0]];
  let courseClause = "";
  if (courseId != null && Number.isFinite(courseId)) {
    params.push(courseId);
    courseClause = `AND s.course_id = $${params.length}`;
  }
  const slotsRes = await pool.query(`
    SELECT s.id, s.course_id, s.slot_date, s.slot_time, s.capacity,
      COALESCE((SELECT SUM(b.party_size) FROM tee_bookings b
        WHERE b.slot_id = s.id AND b.status IN ('confirmed','pending')), 0)::int AS booked
    FROM course_tee_slots s
    WHERE s.organization_id = $1
      AND s.slot_date >= $2::date AND s.slot_date < $3::date
      AND s.status = 'open'
      ${courseClause}
    ORDER BY s.slot_date, s.slot_time
  `, params);

  const now = Date.now();
  const matches: Array<{
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    basePrice: number; finalPrice: number; priceDelta: number; tierStepIndex: number;
    breakdown: PricingBreakdownStep[];
  }> = [];
  // Task #1606 — slots that *almost* matched. Includes (a) slots that failed
  // exactly one of the tier's own conditions (single-issue near-miss) and
  // (b) slots where the tier passed but a higher-priority tier won — both
  // are the cases admins are usually trying to debug when their tier shows
  // zero matches. Walk the slot list in date/time order and cap at
  // `nearMissLimit` so admins see the *closest* upcoming near-misses.
  const nearMisses: Array<{
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    failures: TierMatchFailure[];
  }> = [];

  for (const s of slotsRes.rows) {
    const slotDate = new Date(s.slot_date);
    const slotTime = String(s.slot_time);
    const capacity = Number(s.capacity) || 0;
    const booked = Number(s.booked) || 0;
    const slotCourseId = Number(s.course_id);
    const utilizationPct = capacity > 0 ? booked / capacity : 0;
    const slotDt = new Date(slotDate);
    const [hh, mm] = slotTime.split(":").map(Number);
    slotDt.setHours(hh, mm ?? 0, 0, 0);
    const leadTimeHours = Math.max(0, (slotDt.getTime() - now) / 3_600_000);

    const resolved = resolveEffectivePriceWith({
      orgId, courseId: slotCourseId, slotDate, slotTime,
      capacity, bookedCount: booked, memberType,
    }, ctx);
    const tierStepIndex = resolved.breakdown.findIndex(
      b => b.source === "tier" && (b.detail as { tierId?: number } | undefined)?.tierId === tierId
    );
    if (tierStepIndex >= 0) {
      const tierStep = resolved.breakdown[tierStepIndex];
      matches.push({
        slotId: Number(s.id),
        courseId: slotCourseId,
        slotDate: slotDate.toISOString().split("T")[0],
        slotTime,
        capacity, bookedCount: booked, utilizationPct, leadTimeHours,
        basePrice: resolved.basePrice,
        finalPrice: resolved.finalPrice,
        priceDelta: tierStep.after - tierStep.before,
        tierStepIndex,
        breakdown: resolved.breakdown,
      });
      continue;
    }

    if (nearMissLimit <= 0 || nearMisses.length >= nearMissLimit) continue;

    // Why didn't this slot match? First check the tier's own conditions.
    const evalResult = evaluateTier(tierRow, {
      slotDate, slotTime, courseId: slotCourseId, memberType,
    });
    let failures: TierMatchFailure[] = evalResult.failures;
    if (evalResult.matched) {
      // Tier passed its own conditions but the slot still doesn't carry our
      // tier in its breakdown — either a higher-priority tier won, or our
      // tier won but its rate is 0 for this member type (engine skips the
      // step in that case).
      const scopedTiers = ctx.tiers.filter(t => t.courseId === null || t.courseId === slotCourseId);
      const winner = pickBestTier(scopedTiers, slotDate, slotTime, slotCourseId, memberType);
      if (winner && winner.id !== tierRow.id) {
        failures = [{
          condition: "priorityLoss",
          expected: tierRow.priority,
          actual: { tierId: winner.id, tierName: winner.name, priority: winner.priority },
        }];
      } else {
        const rate = parseFloat(memberType === "guest" ? tierRow.guestRate : tierRow.memberRate);
        if (!(rate > 0)) {
          failures = [{ condition: "zeroRate", expected: memberType, actual: 0 }];
        }
      }
    }

    // Surface single-issue near-misses (both kinds — config near-misses and
    // priority-loss / zero-rate). Multi-failure slots are intentionally
    // excluded so the section stays signal-rich.
    if (failures.length === 1) {
      nearMisses.push({
        slotId: Number(s.id),
        courseId: slotCourseId,
        slotDate: slotDate.toISOString().split("T")[0],
        slotTime,
        capacity, bookedCount: booked, utilizationPct, leadTimeHours,
        failures,
      });
    }
  }

  res.json({
    tier: tierRow,
    days,
    memberType,
    courseId,
    slotsConsidered: slotsRes.rows.length,
    matchCount: matches.length,
    matches,
    nearMissLimit,
    nearMisses,
  });
});

// Task #954 — Fire-and-forget snapshot of the post-publish pricing state.
// Computes a forecast over the active (now post-publish) rules and persists
// both an active and a draft row so accuracy can be scored later. Errors
// are swallowed and logged so a transient failure cannot break a publish.
function recordPublishForecast(orgId: number, actorId: number | null, label: string, courseId: number | null) {
  computeForecast(orgId, { persistDraft: true, label, courseId }, actorId)
    .catch(err => logger.warn({ err, orgId, label }, "[teePricing] post-publish forecast snapshot failed"));
}

// ─── MODIFIERS ──────────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-pricing/modifiers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rows = await db.select().from(teeDynamicPricingModifiersTable)
    .where(eq(teeDynamicPricingModifiersTable.organizationId, orgId))
    .orderBy(desc(teeDynamicPricingModifiersTable.priority), teeDynamicPricingModifiersTable.name);
  res.json(rows);
});

// Task #1257 — sibling of `tiers/publish-snapshots` that returns the most
// recent `publish:modifier-<id>` active-scenario forecast snapshot per
// modifier. The pricing UI uses this to surface a "last projection" badge
// inline on each demand-modifier card so admins can see what they
// promised when they last toggled a modifier without having to dig into
// the Forecast Accuracy tab. We pick the latest `active`-scenario row
// per label so the number reflects the post-publish projection (not the
// pre-publish draft) for that publish event.
router.get("/organizations/:orgId/tee-pricing/modifiers/publish-snapshots", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const result = await pool.query(`
    SELECT DISTINCT ON (label)
      label,
      scenario,
      horizon_days,
      window_start,
      window_end,
      projected_revenue,
      projected_avg_price,
      projected_seats_booked,
      projected_seats_total,
      created_at
    FROM tee_pricing_forecasts
    WHERE organization_id = $1
      AND scenario = 'active'
      AND label LIKE 'publish:modifier-%'
    ORDER BY label, created_at DESC
  `, [orgId]);
  const snapshots: Record<string, {
    modifierId: number;
    label: string;
    scenario: string;
    horizonDays: number;
    windowStart: string;
    windowEnd: string;
    projectedRevenue: number;
    projectedAvgPrice: number;
    projectedSeatsBooked: number;
    projectedSeatsTotal: number;
    createdAt: string;
  }> = {};
  const toDateStr = (v: unknown) => v instanceof Date ? v.toISOString().split("T")[0] : String(v);
  const toIso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v);
  for (const r of result.rows) {
    const m = String(r.label).match(/^publish:modifier-(\d+)$/);
    if (!m) continue;
    const modifierId = parseInt(m[1]);
    snapshots[String(modifierId)] = {
      modifierId,
      label: String(r.label),
      scenario: String(r.scenario),
      horizonDays: Number(r.horizon_days),
      windowStart: toDateStr(r.window_start),
      windowEnd: toDateStr(r.window_end),
      projectedRevenue: Number(r.projected_revenue),
      projectedAvgPrice: Number(r.projected_avg_price),
      projectedSeatsBooked: Number(r.projected_seats_booked),
      projectedSeatsTotal: Number(r.projected_seats_total),
      createdAt: toIso(r.created_at),
    };
  }
  res.json({ snapshots });
});

router.post("/organizations/:orgId/tee-pricing/modifiers", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body;
  if (!b.name || !b.kind) { { res.status(400).json({ error: "name and kind required" }); return; } }
  const [mod] = await db.insert(teeDynamicPricingModifiersTable).values({
    organizationId: orgId,
    courseId: b.courseId ?? null,
    name: b.name,
    kind: b.kind,
    thresholdMin: b.thresholdMin != null ? String(b.thresholdMin) : null,
    thresholdMax: b.thresholdMax != null ? String(b.thresholdMax) : null,
    weatherCondition: b.weatherCondition ?? null,
    adjustmentType: b.adjustmentType ?? "percent",
    adjustmentValue: String(b.adjustmentValue ?? 0),
    applyTo: b.applyTo ?? "any",
    priority: b.priority ?? 0,
    isActive: b.isActive !== false,
  }).returning();
  await logAudit(orgId, getActorId(req), "modifier.created", "modifier", mod.id, mod);
  // Task #954 — creating an active modifier is a publish event; snapshot
  // the post-publish forecast so accuracy can be scored later. Inactive
  // (draft) modifiers don't affect live pricing, so skip those.
  if (mod.isActive) {
    recordPublishForecast(orgId, getActorId(req), `publish:modifier-${mod.id}`, mod.courseId);
  }
  res.status(201).json(mod);
});

router.patch("/organizations/:orgId/tee-pricing/modifiers/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body;
  const [prev] = await db.select().from(teeDynamicPricingModifiersTable)
    .where(and(eq(teeDynamicPricingModifiersTable.id, id), eq(teeDynamicPricingModifiersTable.organizationId, orgId)));
  if (!prev) { { res.status(404).json({ error: "Modifier not found" }); return; } }
  const [mod] = await db.update(teeDynamicPricingModifiersTable).set({
    ...(b.courseId !== undefined && { courseId: b.courseId }),
    ...(b.name !== undefined && { name: b.name }),
    ...(b.kind !== undefined && { kind: b.kind }),
    ...(b.thresholdMin !== undefined && { thresholdMin: b.thresholdMin != null ? String(b.thresholdMin) : null }),
    ...(b.thresholdMax !== undefined && { thresholdMax: b.thresholdMax != null ? String(b.thresholdMax) : null }),
    ...(b.weatherCondition !== undefined && { weatherCondition: b.weatherCondition }),
    ...(b.adjustmentType !== undefined && { adjustmentType: b.adjustmentType }),
    ...(b.adjustmentValue !== undefined && { adjustmentValue: String(b.adjustmentValue) }),
    ...(b.applyTo !== undefined && { applyTo: b.applyTo }),
    ...(b.priority !== undefined && { priority: b.priority }),
    ...(b.isActive !== undefined && { isActive: b.isActive }),
    updatedAt: new Date(),
  }).where(and(eq(teeDynamicPricingModifiersTable.id, id), eq(teeDynamicPricingModifiersTable.organizationId, orgId))).returning();
  await logAudit(orgId, getActorId(req), "modifier.updated", "modifier", id, { previous: prev, next: mod });
  // Task #954 — a modifier update that lands in the active state is a
  // publish event; snapshot the post-publish forecast so accuracy can
  // be scored. We also snapshot when a previously-active modifier is
  // turned off, since that change also affects realised pricing.
  if (mod.isActive || prev.isActive) {
    recordPublishForecast(orgId, getActorId(req), `publish:modifier-${id}`, mod.courseId);
  }
  res.json(mod);
});

router.delete("/organizations/:orgId/tee-pricing/modifiers/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [prev] = await db.select().from(teeDynamicPricingModifiersTable)
    .where(and(eq(teeDynamicPricingModifiersTable.id, id), eq(teeDynamicPricingModifiersTable.organizationId, orgId)));
  if (!prev) { { res.status(404).json({ error: "Modifier not found" }); return; } }
  await db.delete(teeDynamicPricingModifiersTable)
    .where(and(eq(teeDynamicPricingModifiersTable.id, id), eq(teeDynamicPricingModifiersTable.organizationId, orgId)));
  await logAudit(orgId, getActorId(req), "modifier.deleted", "modifier", id, prev);
  res.json({ success: true });
});

// Task #1345 — preview which upcoming open slots in the next N days (default
// 7) include this modifier in their price breakdown. Mirrors the rule
// preview (Task #1163) and the tier preview above: we inject the modifier
// into the pricing context (overriding any active row of the same id),
// force the dyn engine on so admins can preview before flipping the
// engine switch, evaluate every open slot in the window, and return only
// slots whose breakdown contains a "modifier" step matching this id.
//
// Task #1607 — weather modifiers can't match real slots because course tee
// slots don't carry weather conditions; the live engine attaches them at
// evaluation time. To make preview useful for "rain discount"-style rules,
// admins can pass `simulateWeather` (any string) to evaluate every slot as
// if that condition were observed. When the modifier's kind is "weather"
// and `simulateWeather` is omitted, we default to the modifier's own
// configured condition so admins see matches out of the box. Passing an
// explicit empty string opts out (no simulation) so admins can verify the
// realistic "no weather data attached" scenario.
//
// Task #1994 — weather modifiers can also opt into a per-day forecast
// simulation by sending `useForecast: true`. Each slot is then evaluated
// under the daily Open-Meteo forecast for *its* course on its date,
// instead of one global condition for every day. The response surfaces
// the forecast strip alongside the matches so admins can see "next 7 days
// includes rain on 2 days — your rule would fire on those slots". When
// `useForecast` is true, an explicit `simulateWeather` still wins (so
// admins can override for what-if testing), and a forecast outage falls
// back to the modifier's own condition so the preview keeps working.
router.post("/organizations/:orgId/tee-pricing/modifiers/:id/preview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const modifierId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const days = Math.min(31, Math.max(1, Number(req.body?.days) || 7));
  const courseId: number | null = req.body?.courseId != null ? Number(req.body.courseId) : null;
  const memberType: PricingMemberType = req.body?.memberType === "guest" ? "guest" : "member";
  // Task #1606 — near-miss limit mirrors the rule + tier preview defaults.
  const rawModLimit = req.body?.nearMissLimit;
  const parsedModLimit = rawModLimit != null ? Number(rawModLimit) : 5;
  const nearMissLimit = Number.isFinite(parsedModLimit)
    ? Math.min(25, Math.max(0, Math.floor(parsedModLimit)))
    : 5;
  const simulateWeatherRaw = req.body?.simulateWeather;
  const simulateWeatherProvided = typeof simulateWeatherRaw === "string";
  const useForecastRequested = req.body?.useForecast === true;

  const [mod] = await db.select().from(teeDynamicPricingModifiersTable).where(and(
    eq(teeDynamicPricingModifiersTable.id, modifierId),
    eq(teeDynamicPricingModifiersTable.organizationId, orgId),
  ));
  if (!mod) { { res.status(404).json({ error: "Modifier not found" }); return; } }

  // Resolve the effective *global* simulated weather condition:
  //   - if the body param was provided (even ""), honour it verbatim
  //     and skip forecast mode (admin override always wins)
  //   - otherwise, when forecast mode is OFF, default to the modifier's
  //     own configured condition for weather modifiers, or null
  // Empty-string ("") means "no condition attached" — useful for verifying
  // the realistic preview where slots carry no weather data.
  let simulatedWeather: string | null = null;
  const useForecast = useForecastRequested && mod.kind === "weather" && !simulateWeatherProvided;
  if (simulateWeatherProvided) {
    simulatedWeather = simulateWeatherRaw.trim() === "" ? null : simulateWeatherRaw.trim();
  } else if (mod.kind === "weather" && !useForecast) {
    simulatedWeather = mod.weatherCondition ?? null;
  }

  const ctx = await loadPricingContext(orgId);
  const modRow: ModifierRow = {
    id: mod.id,
    name: mod.name,
    courseId: mod.courseId,
    kind: mod.kind as ModifierRow["kind"],
    thresholdMin: mod.thresholdMin,
    thresholdMax: mod.thresholdMax,
    weatherCondition: mod.weatherCondition,
    adjustmentType: mod.adjustmentType as ModifierRow["adjustmentType"],
    adjustmentValue: mod.adjustmentValue,
    applyTo: mod.applyTo as ModifierRow["applyTo"],
    priority: mod.priority,
  };
  // Replace any active version of the same modifier in ctx, or inject if
  // absent (loadPricingContext drops inactive modifiers). This lets admins
  // preview a modifier still in draft before publishing it.
  ctx.modifiers = [modRow, ...ctx.modifiers.filter(m => m.id !== mod.id)];
  // Force the engine on for this evaluation only — modifiers are otherwise
  // skipped on the dyn-disabled fast path, which would defeat the
  // preview's whole purpose for orgs that haven't enabled the engine yet.
  if (ctx.config) ctx.config = { ...ctx.config, enabled: true };
  else ctx.config = {
    enabled: true, priceFloorPct: "0.50", priceCeilingPct: "2.00",
    dealBadgeThresholdPct: "0.85",
    defaultMemberElasticity: "-0.20", defaultGuestElasticity: "-0.70",
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonEnd = new Date(today);
  horizonEnd.setDate(horizonEnd.getDate() + days);

  const params: unknown[] = [orgId, today.toISOString().split("T")[0], horizonEnd.toISOString().split("T")[0]];
  let courseClause = "";
  if (courseId != null && Number.isFinite(courseId)) {
    params.push(courseId);
    courseClause = `AND s.course_id = $${params.length}`;
  }
  const slotsRes = await pool.query(`
    SELECT s.id, s.course_id, s.slot_date, s.slot_time, s.capacity,
      COALESCE((SELECT SUM(b.party_size) FROM tee_bookings b
        WHERE b.slot_id = s.id AND b.status IN ('confirmed','pending')), 0)::int AS booked
    FROM course_tee_slots s
    WHERE s.organization_id = $1
      AND s.slot_date >= $2::date AND s.slot_date < $3::date
      AND s.status = 'open'
      ${courseClause}
    ORDER BY s.slot_date, s.slot_time
  `, params);

  // Task #1994 — when forecast mode is on, fetch the daily forecast for
  // every distinct course in the slot result so each slot is evaluated
  // under *its* own day's expected condition. We cap to the first 10
  // courses to bound Open-Meteo calls when a "all courses" preview spans
  // a large portfolio; the cache (1h TTL) absorbs repeat opens. The
  // returned strip is keyed by courseId so the UI can render "Mon: rain,
  // Tue: clear, …" alongside each course's matches.
  type ForecastStrip = {
    courseId: number;
    courseName: string | null;
    days: DailyWeatherForecast[];
  };
  const forecastByCourse = new Map<number, Map<string, string | null>>();
  const forecastStrips: ForecastStrip[] = [];
  let forecastUnavailable = false;
  let forecastReason: string | null = null;

  if (useForecast) {
    const slotCourseIds = Array.from(new Set(slotsRes.rows.map(r => Number(r.course_id))));
    const forecastCourseIds = slotCourseIds.slice(0, 10);
    if (forecastCourseIds.length === 0) {
      forecastUnavailable = true;
      forecastReason = "no upcoming open slots in this window";
    } else {
      const courseRows = await db.select({
        id: coursesTable.id,
        name: coursesTable.name,
        latitude: coursesTable.latitude,
        longitude: coursesTable.longitude,
      }).from(coursesTable).where(inArray(coursesTable.id, forecastCourseIds));

      const courseLoc = new Map<number, { lat: number; lng: number; name: string | null }>();
      for (const c of courseRows) {
        const lat = c.latitude !== null ? parseFloat(String(c.latitude)) : NaN;
        const lng = c.longitude !== null ? parseFloat(String(c.longitude)) : NaN;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          courseLoc.set(c.id, { lat, lng, name: c.name ?? null });
        }
      }

      // Open-Meteo's daily endpoint supports up to 16 days; clamp the
      // request to that ceiling. Anything beyond `days` is ignored by
      // the slot loop because we only look up the slot's own date.
      const forecastDays = Math.min(16, days);
      await Promise.all(forecastCourseIds.map(async cid => {
        const loc = courseLoc.get(cid);
        if (!loc) return;
        try {
          const fc = await getDailyForecast(loc.lat, loc.lng, forecastDays);
          if (fc.length === 0) return;
          const dayMap = new Map<string, string | null>();
          for (const d of fc) dayMap.set(d.date, d.condition);
          forecastByCourse.set(cid, dayMap);
          forecastStrips.push({ courseId: cid, courseName: loc.name, days: fc });
        } catch (err) {
          logger.warn({ err, courseId: cid }, "[teePricing] forecast fetch failed");
        }
      }));

      if (forecastByCourse.size === 0) {
        // Forecast service returned no usable data for any course. Fall
        // back to the modifier's own configured condition so the preview
        // still shows matches — admins want a useful preview even if the
        // upstream weather service is down.
        forecastUnavailable = true;
        const reasons: string[] = [];
        const missingLatLng = forecastCourseIds.filter(id => !courseLoc.has(id));
        if (missingLatLng.length === forecastCourseIds.length) {
          reasons.push("no course in this preview has lat/lng configured");
        } else if (missingLatLng.length > 0) {
          reasons.push(`${missingLatLng.length} course(s) missing lat/lng`);
        }
        if (courseLoc.size > 0 && forecastByCourse.size === 0) {
          reasons.push("forecast service returned no data");
        }
        forecastReason = reasons.join("; ") || "forecast unavailable";
        if (mod.weatherCondition) simulatedWeather = mod.weatherCondition;
      }
    }
  }

  const now = Date.now();
  const matches: Array<{
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    basePrice: number; finalPrice: number; priceDelta: number; modifierStepIndex: number;
    /** Task #1994 — condition the engine evaluated this slot under (forecast or override). */
    weatherConditionUsed: string | null;
    breakdown: PricingBreakdownStep[];
  }> = [];
  // Task #1606 — near-miss section: slots that failed exactly one of the
  // modifier's conditions (course scope, applyTo segment, threshold band,
  // weather match). Walk the slot list in date/time order and cap so admins
  // see the *closest* upcoming near-misses.
  const nearMisses: Array<{
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    failures: ModifierMatchFailure[];
  }> = [];

  // Forecast-mode wins over the global override (when forecast data
  // exists for that slot's course/day). Falls back to `simulatedWeather`
  // — which already encodes "modifier's own condition" for the no-forecast
  // fallback path above — when the slot has no per-day forecast.
  const slotWeatherFor = (slotCourseId: number, slotDateStr: string): string | null => {
    if (useForecast && !forecastUnavailable) {
      const dayMap = forecastByCourse.get(slotCourseId);
      if (dayMap) return dayMap.get(slotDateStr) ?? null;
      return null;
    }
    return simulatedWeather;
  };

  for (const s of slotsRes.rows) {
    const slotDate = new Date(s.slot_date);
    const slotTime = String(s.slot_time);
    const capacity = Number(s.capacity) || 0;
    const booked = Number(s.booked) || 0;
    const slotCourseId = Number(s.course_id);
    const utilizationPct = capacity > 0 ? booked / capacity : 0;
    const slotDt = new Date(slotDate);
    const [hh, mm] = slotTime.split(":").map(Number);
    slotDt.setHours(hh, mm ?? 0, 0, 0);
    const leadTimeHours = Math.max(0, (slotDt.getTime() - now) / 3_600_000);
    const slotDateStr = slotDate.toISOString().split("T")[0];
    const slotWeather = slotWeatherFor(slotCourseId, slotDateStr);

    const resolved = resolveEffectivePriceWith({
      orgId, courseId: slotCourseId, slotDate, slotTime,
      capacity, bookedCount: booked, memberType,
      // Task #1607 — inject the simulated weather condition so weather
      // modifiers can match in preview. Real slots don't carry weather
      // until the live engine attaches it; simulating lets admins verify
      // a "rain discount" before publishing.
      // Task #1994 — in forecast mode this is the per-day forecast
      // condition for the slot's course, so different days can match
      // different rules without requiring one global override.
      weatherCondition: slotWeather,
    }, ctx);
    const modifierStepIndex = resolved.breakdown.findIndex(
      b => b.source === "modifier" && (b.detail as { modifierId?: number } | undefined)?.modifierId === modifierId
    );
    if (modifierStepIndex >= 0) {
      const modStep = resolved.breakdown[modifierStepIndex];
      matches.push({
        slotId: Number(s.id),
        courseId: slotCourseId,
        slotDate: slotDateStr,
        slotTime,
        capacity, bookedCount: booked, utilizationPct, leadTimeHours,
        basePrice: resolved.basePrice,
        finalPrice: resolved.finalPrice,
        priceDelta: modStep.after - modStep.before,
        modifierStepIndex,
        weatherConditionUsed: slotWeather,
        breakdown: resolved.breakdown,
      });
      continue;
    }

    if (nearMissLimit <= 0 || nearMisses.length >= nearMissLimit) continue;

    // Task #1995 — pass the same simulated weather we use in the live
    // resolution above. Hardcoding null here meant weather-modifier
    // near-misses always reported "weather data missing", even when the
    // admin had supplied a real condition (e.g. previewing "clear" against
    // a "rain" modifier should surface a `weatherMismatch`, not a
    // `weatherMissing`). Sharing `simulatedWeather` keeps the near-miss
    // evaluation in lockstep with the price resolution path.
    const evalResult = evaluateModifier(modRow, {
      utilizationPct, leadTimeHours,
      weatherCondition: simulatedWeather,
      courseId: slotCourseId, memberType,
    });
    if (!evalResult.matched && evalResult.failures.length === 1) {
      nearMisses.push({
        slotId: Number(s.id),
        courseId: slotCourseId,
        slotDate: slotDateStr,
        slotTime,
        capacity, bookedCount: booked, utilizationPct, leadTimeHours,
        failures: evalResult.failures,
      });
    }
  }

  res.json({
    modifier: modRow,
    days,
    memberType,
    courseId,
    // Task #1607 — echo back what condition (if any) was applied so the UI
    // can display "evaluated as if condition = rain" alongside the matches.
    // Task #1994 — null when forecast mode is in effect (per-day conditions
    // come from `forecast.byCourse[].days[]` instead).
    simulatedWeather,
    // Task #1994 — forecast-mode metadata. `enabled` indicates the request
    // asked for forecast mode AND the modifier is a weather modifier.
    // `unavailable` is true when forecast mode was enabled but no usable
    // data was retrieved (no lat/lng, upstream outage, …) and the engine
    // fell back to `simulatedWeather`. `byCourse` is the per-course daily
    // strip the UI can render alongside the matches table.
    forecast: mod.kind === "weather" && useForecastRequested ? {
      enabled: useForecast,
      unavailable: forecastUnavailable,
      reason: forecastReason,
      source: "open-meteo" as const,
      byCourse: forecastStrips,
    } : null,
    slotsConsidered: slotsRes.rows.length,
    matchCount: matches.length,
    matches,
    nearMissLimit,
    nearMisses,
  });
});

// ─── PREVIEW & EFFECTIVE PRICE ──────────────────────────────────────────────

router.post("/organizations/:orgId/tee-pricing/preview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { courseId, slotDate, slotTime, capacity, bookedCount, memberType, weatherCondition } = req.body;
  if (!courseId || !slotDate || !slotTime) { { res.status(400).json({ error: "courseId, slotDate, slotTime required" }); return; } }
  const result = await resolveEffectivePrice({
    orgId, courseId: Number(courseId), slotDate: new Date(slotDate),
    slotTime, capacity, bookedCount,
    memberType: memberType === "guest" ? "guest" : "member",
    weatherCondition: weatherCondition ?? null,
  });
  res.json(result);
});

router.post("/organizations/:orgId/tee-pricing/preview-calendar", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { courseId, fromDate, toDate, times, memberType } = req.body;
  if (!courseId || !fromDate || !toDate || !Array.isArray(times)) {
    res.status(400).json({ error: "courseId, fromDate, toDate, times[] required" }); return;
  }
  const out: { date: string; rows: { time: string; price: number; basePrice: number; isDeal: boolean; tierName: string | null; dealBadge: string | null; breakdown: unknown[] }[] }[] = [];
  const start = new Date(fromDate + "T00:00:00");
  const end = new Date(toDate + "T00:00:00");
  const maxDays = 31;
  let day = 0;
  for (let d = new Date(start); d <= end && day < maxDays; d.setDate(d.getDate() + 1), day++) {
    const dayCopy = new Date(d);
    const rows = [];
    for (const t of times) {
      const r = await resolveEffectivePrice({
        orgId, courseId: Number(courseId), slotDate: dayCopy, slotTime: String(t),
        memberType: memberType === "guest" ? "guest" : "member",
      });
      rows.push({ time: String(t), price: r.finalPrice, basePrice: r.basePrice, isDeal: r.isDeal, tierName: r.tierName, dealBadge: r.dealBadge, breakdown: r.breakdown ?? [] });
    }
    out.push({ date: dayCopy.toISOString().split("T")[0], rows });
  }
  res.json({ calendar: out });
});

router.get("/organizations/:orgId/tee-pricing/effective-price", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  // Authentication required; tenant scope is enforced by the slot lookup below.
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required." }); return; } }
  const { slotId, memberType } = req.query as { slotId?: string; memberType?: string };
  if (!slotId) { { res.status(400).json({ error: "slotId required" }); return; } }
  const [slot] = await db.select().from(courseTeeSlotTable)
    .where(and(eq(courseTeeSlotTable.id, parseInt(slotId)), eq(courseTeeSlotTable.organizationId, orgId)));
  if (!slot) { { res.status(404).json({ error: "Slot not found" }); return; } }
  const [bookedRow] = await db.select({ booked: sql<number>`COALESCE(SUM(party_size),0)::int` })
    .from(teeBookingsTable)
    .where(and(eq(teeBookingsTable.slotId, slot.id), sql`${teeBookingsTable.status} IN ('confirmed','pending')`));
  const result = await resolveEffectivePrice({
    orgId, courseId: slot.courseId, slotDate: slot.slotDate, slotTime: slot.slotTime,
    capacity: slot.capacity, bookedCount: bookedRow?.booked ?? 0,
    memberType: memberType === "guest" ? "guest" : "member",
  });
  res.json(result);
});

// ─── FORECAST (DRAFT vs ACTIVE) ─────────────────────────────────────────────

interface ForecastTierInput {
  id?: number;
  name?: string;
  courseId?: number | null;
  daysOfWeek?: number[];
  startTime?: string | null;
  endTime?: string | null;
  seasonStart?: string | null;
  seasonEnd?: string | null;
  memberType?: "any" | "member" | "guest";
  memberRate?: string | number;
  guestRate?: string | number;
  priority?: number;
  isActive?: boolean;
}
interface ForecastModInput {
  id?: number;
  name?: string;
  courseId?: number | null;
  kind?: "utilization" | "lead_time" | "weather";
  thresholdMin?: string | number | null;
  thresholdMax?: string | number | null;
  weatherCondition?: string | null;
  adjustmentType?: "percent" | "flat";
  adjustmentValue?: string | number;
  applyTo?: "any" | "member" | "guest";
  priority?: number;
  isActive?: boolean;
}

function tierFromInput(t: ForecastTierInput, fallbackId = -1): TierRow {
  return {
    id: t.id ?? fallbackId,
    name: t.name ?? "Draft tier",
    courseId: t.courseId ?? null,
    daysOfWeek: Array.isArray(t.daysOfWeek) && t.daysOfWeek.length > 0 ? t.daysOfWeek : [0,1,2,3,4,5,6],
    startTime: t.startTime ?? null,
    endTime: t.endTime ?? null,
    seasonStart: t.seasonStart ?? null,
    seasonEnd: t.seasonEnd ?? null,
    memberType: t.memberType ?? "any",
    memberRate: String(t.memberRate ?? "0"),
    guestRate: String(t.guestRate ?? "0"),
    priority: t.priority ?? 0,
  };
}
function modifierFromInput(m: ForecastModInput, fallbackId = -1): ModifierRow {
  return {
    id: m.id ?? fallbackId,
    name: m.name ?? "Draft modifier",
    courseId: m.courseId ?? null,
    kind: m.kind ?? "utilization",
    thresholdMin: m.thresholdMin != null ? String(m.thresholdMin) : null,
    thresholdMax: m.thresholdMax != null ? String(m.thresholdMax) : null,
    weatherCondition: m.weatherCondition ?? null,
    adjustmentType: m.adjustmentType ?? "percent",
    adjustmentValue: String(m.adjustmentValue ?? "0"),
    applyTo: m.applyTo ?? "any",
    priority: m.priority ?? 0,
  };
}

interface ForecastTotals {
  revenue: number;
  seatsBooked: number;
  seatsTotal: number;
  slots: number;
  avgPrice: number;
  utilizationPct: number;
}
interface DailyForecast {
  date: string;
  activeRevenue: number;
  draftRevenue: number;
  activeAvgPrice: number;
  draftAvgPrice: number;
  activeSeatsBooked: number;
  draftSeatsBooked: number;
  seatsTotal: number;
}

// (clampElasticity + DEFAULT_*_ELASTICITY are hoisted above the route
//  definitions so the config + per-course override handlers can reuse them.)

// Apply constant-elasticity demand response: q1 = q0 * (p1/p0)^elasticity.
// If active price is 0/missing, we cannot meaningfully estimate a ratio, so
// we leave demand unchanged.
function adjustDemand(baseSeats: number, activePrice: number, draftPrice: number, elasticity: number, capPerSegment: number): number {
  if (baseSeats <= 0) return 0;
  if (!(activePrice > 0) || !(draftPrice > 0)) return baseSeats;
  const ratio = draftPrice / activePrice;
  if (ratio === 1) return baseSeats;
  const factor = Math.pow(ratio, elasticity);
  const adjusted = baseSeats * factor;
  return Math.max(0, Math.min(capPerSegment, adjusted));
}

interface ForecastDraftInput {
  config?: {
    enabled?: boolean;
    priceFloorPct?: string | number;
    priceCeilingPct?: string | number;
    dealBadgeThresholdPct?: string | number;
  };
  tiers?: ForecastTierInput[];
  tierOverrides?: ForecastTierInput[];
  modifiers?: ForecastModInput[];
  modifierOverrides?: ForecastModInput[];
}
interface ForecastInput {
  horizonDays?: number | string;
  courseId?: number | string | null;
  draft?: ForecastDraftInput;
  elasticity?: number | string;
  memberElasticity?: number | string;
  guestElasticity?: number | string;
  persist?: boolean;
  persistDraft?: boolean;
  label?: string;
}

async function computeForecast(orgId: number, body: ForecastInput, actorId: number | null) {
  const horizonDays = [14, 30].includes(Number(body.horizonDays)) ? Number(body.horizonDays) : 14;
  const courseId: number | null = body.courseId != null ? parseInt(String(body.courseId)) : null;
  const draftBody: ForecastDraftInput = body.draft ?? {};

  {
    // 1. Build the active context (current production state).
    const activeCtx = await loadPricingContext(orgId);

    // Members and guests typically respond to price changes very differently
    // (Task #730). Accept either explicit per-segment elasticities or fall
    // back to the legacy single `elasticity` field (which then applies to
    // both segments) for backwards compatibility with older clients.
    // Only treat the legacy field as a usable fallback if it parses to a
    // real number; otherwise each segment should fall back to the org's
    // saved default (Task #729) — and finally to the per-segment system
    // default — rather than collapsing both to the member default.
    const legacyRaw = body.elasticity != null
      ? (typeof body.elasticity === "number" ? body.elasticity : parseFloat(String(body.elasticity)))
      : NaN;
    const legacyElasticity = Number.isFinite(legacyRaw)
      ? Math.max(-3, Math.min(0, legacyRaw))
      : null;
    const orgMemberDefault = activeCtx.config?.defaultMemberElasticity != null
      ? clampElasticity(activeCtx.config.defaultMemberElasticity, DEFAULT_MEMBER_ELASTICITY)
      : DEFAULT_MEMBER_ELASTICITY;
    const orgGuestDefault = activeCtx.config?.defaultGuestElasticity != null
      ? clampElasticity(activeCtx.config.defaultGuestElasticity, DEFAULT_GUEST_ELASTICITY)
      : DEFAULT_GUEST_ELASTICITY;

    // Task #822: when the forecast is scoped to a specific course, an
    // admin-saved per-course override takes precedence over the org-level
    // default for any segment whose column is non-null. Either segment
    // may stay NULL on the override row to inherit only one segment from
    // the org default.
    let courseMemberOverride: number | null = null;
    let courseGuestOverride: number | null = null;
    if (courseId != null && !Number.isNaN(courseId)) {
      const [override] = await db.select().from(teeDynamicPricingCourseElasticityTable)
        .where(and(
          eq(teeDynamicPricingCourseElasticityTable.organizationId, orgId),
          eq(teeDynamicPricingCourseElasticityTable.courseId, courseId),
        ));
      if (override?.memberElasticity != null) {
        courseMemberOverride = clampElasticity(override.memberElasticity, orgMemberDefault);
      }
      if (override?.guestElasticity != null) {
        courseGuestOverride = clampElasticity(override.guestElasticity, orgGuestDefault);
      }
    }
    const savedMemberDefault = courseMemberOverride ?? orgMemberDefault;
    const savedGuestDefault = courseGuestOverride ?? orgGuestDefault;

    const memberElasticity = body.memberElasticity != null
      ? clampElasticity(body.memberElasticity, savedMemberDefault)
      : (legacyElasticity ?? savedMemberDefault);
    const guestElasticity = body.guestElasticity != null
      ? clampElasticity(body.guestElasticity, savedGuestDefault)
      : (legacyElasticity ?? savedGuestDefault);

    // 2. Build the draft context by overlaying the request on the active state.
    //    - draft.tiers: full replacement set when provided (active+inactive flags honoured).
    //    - draft.tierOverrides: patch existing tiers / add new ephemeral ones by id.
    //    - draft.config: overrides config fields.
    const draftCtx: PricingContext = {
      legacyRules: activeCtx.legacyRules,
      config: activeCtx.config
        ? {
            ...activeCtx.config,
            ...(draftBody.config?.enabled !== undefined && { enabled: draftBody.config.enabled === true }),
            ...(draftBody.config?.priceFloorPct !== undefined && { priceFloorPct: String(draftBody.config.priceFloorPct) }),
            ...(draftBody.config?.priceCeilingPct !== undefined && { priceCeilingPct: String(draftBody.config.priceCeilingPct) }),
            ...(draftBody.config?.dealBadgeThresholdPct !== undefined && { dealBadgeThresholdPct: String(draftBody.config.dealBadgeThresholdPct) }),
          }
        : (draftBody.config
            ? {
                enabled: draftBody.config.enabled === true,
                priceFloorPct: String(draftBody.config.priceFloorPct ?? "0.50"),
                priceCeilingPct: String(draftBody.config.priceCeilingPct ?? "2.00"),
                dealBadgeThresholdPct: String(draftBody.config.dealBadgeThresholdPct ?? "0.85"),
                defaultMemberElasticity: String(orgMemberDefault),
                defaultGuestElasticity: String(orgGuestDefault),
              }
            : null),
      tiers: activeCtx.tiers,
      modifiers: activeCtx.modifiers,
      // Forecast scenario doesn't override rules — carry them over from the
      // active context so resolveEffectivePriceWith can iterate (Task #1004).
      rules: activeCtx.rules,
    };

    if (Array.isArray(draftBody.tiers)) {
      // Full replacement of the tier set; only honour rows with isActive !== false.
      draftCtx.tiers = (draftBody.tiers as ForecastTierInput[])
        .filter(t => t.isActive !== false)
        .map((t, i) => tierFromInput(t, -(i + 1)));
    } else if (Array.isArray(draftBody.tierOverrides)) {
      // Patch by id; ephemeral additions when id is missing/negative.
      const patches = draftBody.tierOverrides as ForecastTierInput[];
      const byId = new Map<number, TierRow>(activeCtx.tiers.map(t => [t.id, t]));
      let nextEphemeralId = -1;
      for (const p of patches) {
        if (p.id && byId.has(p.id)) {
          if (p.isActive === false) byId.delete(p.id);
          else byId.set(p.id, tierFromInput({ ...byId.get(p.id), ...p }, p.id));
        } else if (p.isActive !== false) {
          const id = nextEphemeralId--;
          byId.set(id, tierFromInput(p, id));
        }
      }
      draftCtx.tiers = Array.from(byId.values());
    }

    if (Array.isArray(draftBody.modifiers)) {
      draftCtx.modifiers = (draftBody.modifiers as ForecastModInput[])
        .filter(m => m.isActive !== false)
        .map((m, i) => modifierFromInput(m, -(i + 1)));
    } else if (Array.isArray(draftBody.modifierOverrides)) {
      // Patch by id; ephemeral additions when id is missing/negative.
      const patches = draftBody.modifierOverrides as ForecastModInput[];
      const byId = new Map<number, ModifierRow>(activeCtx.modifiers.map(m => [m.id, m]));
      let nextEphemeralId = -1;
      for (const p of patches) {
        if (p.id && byId.has(p.id)) {
          if (p.isActive === false) byId.delete(p.id);
          else byId.set(p.id, modifierFromInput({ ...byId.get(p.id), ...p }, p.id));
        } else if (p.isActive !== false) {
          const id = nextEphemeralId--;
          byId.set(id, modifierFromInput(p, id));
        }
      }
      draftCtx.modifiers = Array.from(byId.values());
    }

    // 3. Pull upcoming slots in the horizon window for the org/course.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const horizonEnd = new Date(today);
    horizonEnd.setDate(horizonEnd.getDate() + horizonDays);

    const slotParams: unknown[] = [orgId, today.toISOString().split("T")[0], horizonEnd.toISOString().split("T")[0]];
    let slotCourseClause = "";
    if (courseId != null && !Number.isNaN(courseId)) {
      slotParams.push(courseId);
      slotCourseClause = `AND course_id = $${slotParams.length}`;
    }
    const slotsRes = await pool.query(`
      SELECT id, course_id, slot_date, slot_time, capacity
      FROM course_tee_slots
      WHERE organization_id = $1
        AND slot_date >= $2::date AND slot_date < $3::date
        AND status = 'open'
        ${slotCourseClause}
      ORDER BY slot_date, slot_time
    `, slotParams);

    // 4. Historical demand: avg utilisation per (DOW, hour) over the last 90d
    //    plus member/guest mix from booking players.
    const histParams: unknown[] = [orgId];
    let histCourseClause = "";
    if (courseId != null && !Number.isNaN(courseId)) {
      histParams.push(courseId);
      histCourseClause = `AND s.course_id = $${histParams.length}`;
    }
    const histRes = await pool.query(`
      SELECT EXTRACT(DOW FROM s.slot_date)::int AS dow,
             SPLIT_PART(s.slot_time, ':', 1)::int AS hour,
             SUM(s.capacity)::int AS seats_total,
             COALESCE(SUM(b.party_size), 0)::int AS seats_booked
      FROM course_tee_slots s
      LEFT JOIN tee_bookings b ON b.slot_id = s.id AND b.status IN ('confirmed','completed')
      WHERE s.organization_id = $1
        AND s.slot_date >= (NOW() - INTERVAL '90 days')
        AND s.slot_date < NOW()
        ${histCourseClause}
      GROUP BY dow, hour
    `, histParams);

    const utilByBucket = new Map<string, number>();
    let totalSeats = 0, totalBooked = 0;
    for (const r of histRes.rows) {
      const seats = Number(r.seats_total) || 0;
      const booked = Number(r.seats_booked) || 0;
      totalSeats += seats; totalBooked += booked;
      if (seats > 0) utilByBucket.set(`${r.dow}:${r.hour}`, Math.min(1, booked / seats));
    }
    const fallbackUtil = totalSeats > 0 ? Math.min(1, totalBooked / totalSeats) : 0.5;

    // Member/guest mix from past 90d.
    const mixRes = await pool.query(`
      SELECT
        SUM(CASE WHEN p.player_type = 'member' THEN 1 ELSE 0 END)::int AS members,
        SUM(CASE WHEN p.player_type = 'guest'  THEN 1 ELSE 0 END)::int AS guests
      FROM tee_booking_players p
      JOIN tee_bookings b ON b.id = p.booking_id
      JOIN course_tee_slots s ON s.id = b.slot_id
      WHERE s.organization_id = $1
        AND s.slot_date >= (NOW() - INTERVAL '90 days')
        AND b.status IN ('confirmed','completed')
        ${histCourseClause}
    `, histParams);
    const mixRow = mixRes.rows[0] ?? { members: 0, guests: 0 };
    const memCount = Number(mixRow.members) || 0;
    const gstCount = Number(mixRow.guests) || 0;
    const memberShare = (memCount + gstCount) > 0 ? memCount / (memCount + gstCount) : 0.7;

    // 5. Walk the upcoming slots and simulate.
    const dailyMap = new Map<string, DailyForecast>();
    const totals = (): ForecastTotals => ({ revenue: 0, seatsBooked: 0, seatsTotal: 0, slots: 0, avgPrice: 0, utilizationPct: 0 });
    const active = totals(); const draft = totals();

    for (const s of slotsRes.rows) {
      const slotDate = new Date(s.slot_date);
      const slotTime = String(s.slot_time);
      const capacity = Number(s.capacity) || 0;
      const dow = slotDate.getDay();
      const hour = parseInt(slotTime.split(":")[0]);
      const util = utilByBucket.get(`${dow}:${hour}`) ?? fallbackUtil;
      const estBooked = Math.min(capacity, Math.round(capacity * util));
      const estMember = Math.round(estBooked * memberShare);
      const estGuest = estBooked - estMember;
      const capMember = Math.round(capacity * memberShare);
      const capGuest = capacity - capMember;

      const baseInput = {
        orgId, courseId: Number(s.course_id), slotDate, slotTime,
        capacity, bookedCount: estBooked,
      };
      const aMem = resolveEffectivePriceWith({ ...baseInput, memberType: "member" }, activeCtx).finalPrice;
      const aGst = resolveEffectivePriceWith({ ...baseInput, memberType: "guest" }, activeCtx).finalPrice;
      const dMem = resolveEffectivePriceWith({ ...baseInput, memberType: "member" }, draftCtx).finalPrice;
      const dGst = resolveEffectivePriceWith({ ...baseInput, memberType: "guest" }, draftCtx).finalPrice;

      // Apply price-elasticity of demand to the draft scenario per segment.
      // Active demand is held at the historical estimate; draft demand shifts
      // when the draft price differs from the active price.
      const dEstMember = adjustDemand(estMember, aMem, dMem, memberElasticity, capMember);
      const dEstGuest = adjustDemand(estGuest, aGst, dGst, guestElasticity, capGuest);
      const dEstBooked = Math.min(capacity, dEstMember + dEstGuest);

      const aRev = estMember * aMem + estGuest * aGst;
      const dRev = dEstMember * dMem + dEstGuest * dGst;

      active.revenue += aRev; active.seatsBooked += estBooked; active.seatsTotal += capacity; active.slots++;
      draft.revenue += dRev;  draft.seatsBooked += dEstBooked; draft.seatsTotal += capacity; draft.slots++;

      const dayKey = slotDate.toISOString().split("T")[0];
      const dr = dailyMap.get(dayKey) ?? { date: dayKey, activeRevenue: 0, draftRevenue: 0, activeAvgPrice: 0, draftAvgPrice: 0, activeSeatsBooked: 0, draftSeatsBooked: 0, seatsTotal: 0 };
      dr.activeRevenue += aRev; dr.draftRevenue += dRev;
      dr.activeSeatsBooked += estBooked; dr.draftSeatsBooked += dEstBooked;
      dr.seatsTotal += capacity;
      dailyMap.set(dayKey, dr);
    }

    // Derive per-day averages now that totals are summed.
    const daily = Array.from(dailyMap.values()).map(d => ({
      ...d,
      activeAvgPrice: d.activeSeatsBooked > 0 ? d.activeRevenue / d.activeSeatsBooked : 0,
      draftAvgPrice: d.draftSeatsBooked > 0 ? d.draftRevenue / d.draftSeatsBooked : 0,
    })).sort((a, b) => a.date.localeCompare(b.date));

    active.avgPrice = active.seatsBooked > 0 ? active.revenue / active.seatsBooked : 0;
    draft.avgPrice = draft.seatsBooked > 0 ? draft.revenue / draft.seatsBooked : 0;
    active.utilizationPct = active.seatsTotal > 0 ? active.seatsBooked / active.seatsTotal : 0;
    draft.utilizationPct = draft.seatsTotal > 0 ? draft.seatsBooked / draft.seatsTotal : 0;

    const deltaRevenue = draft.revenue - active.revenue;
    const deltaRevenuePct = active.revenue > 0 ? (deltaRevenue / active.revenue) * 100 : null;
    const deltaAvgPrice = draft.avgPrice - active.avgPrice;
    const deltaAvgPricePct = active.avgPrice > 0 ? (deltaAvgPrice / active.avgPrice) * 100 : null;

    const assumptions = {
      historicalSampleDays: 90,
      memberShare,
      fallbackUtilization: fallbackUtil,
      slotsConsidered: slotsRes.rows.length,
      memberElasticity,
      guestElasticity,
      // Where the elasticity values came from, so the admin UI can label
      // "course override" vs "org default" vs "request body" (Task #822).
      memberElasticitySource: body.memberElasticity != null
        ? "request"
        : (legacyElasticity != null
            ? "request_legacy"
            : (courseMemberOverride != null ? "course_override" : "org_default")),
      guestElasticitySource: body.guestElasticity != null
        ? "request"
        : (legacyElasticity != null
            ? "request_legacy"
            : (courseGuestOverride != null ? "course_override" : "org_default")),
      // Legacy field — kept for older clients that still read a single
      // coefficient. Reports the average of the two segment elasticities.
      elasticity: (memberElasticity + guestElasticity) / 2,
    };

    // Task #821 — persist the forecast snapshot so admins can later
    // compare projected vs realised revenue. The active scenario is
    // always recorded; the draft scenario is only persisted when the
    // caller explicitly opts in (e.g. publishing a draft) to avoid
    // logging every speculative what-if preview.
    let savedForecastId: number | null = null;
    let savedDraftForecastId: number | null = null;
    // Surfaced to the client so admins/dashboards can detect degraded
    // mode (e.g. show a banner when accuracy data is silently not being
    // recorded). Persistence is intentionally best-effort: a transient
    // DB hiccup must not break the forecast preview UI.
    let persistenceStatus: "ok" | "failed" = "ok";
    // Task #1263 — capture the per-day projected revenue computed above so
    // the drill-down endpoint can compare actuals against the day-level
    // expectation the forecaster actually produced instead of attributing
    // the projected total evenly across the horizon. Days with no
    // forecasted slots are omitted (the drill-down treats them as 0).
    const activeRevenueByDay = daily
      .map(d => ({ day: d.date, revenue: Number(d.activeRevenue.toFixed(2)) }));
    const draftRevenueByDay = daily
      .map(d => ({ day: d.date, revenue: Number(d.draftRevenue.toFixed(2)) }));
    try {
      const persist = body.persist === true;
      const persistDraft = body.persistDraft === true;
      const label: string | null = typeof body.label === "string" ? body.label : null;
      const windowStartStr = today.toISOString().split("T")[0];
      const windowEndStr = horizonEnd.toISOString().split("T")[0];
      // Always record the active baseline so accuracy can be measured
      // against the production pricing rules of the day. The draft
      // recording is opt-in via `persist` or `persistDraft`.
      const [activeRow] = await db.insert(teePricingForecastsTable).values({
        organizationId: orgId,
        courseId,
        actorUserId: actorId,
        scenario: "active",
        label,
        horizonDays,
        windowStart: windowStartStr,
        windowEnd: windowEndStr,
        projectedRevenue: active.revenue.toFixed(2),
        projectedAvgPrice: active.avgPrice.toFixed(2),
        projectedSeatsBooked: Math.round(active.seatsBooked),
        projectedSeatsTotal: Math.round(active.seatsTotal),
        projectedRevenueByDay: activeRevenueByDay,
        assumptions,
      }).returning({ id: teePricingForecastsTable.id });
      savedForecastId = activeRow.id;
      if (persist || persistDraft) {
        const [draftRow] = await db.insert(teePricingForecastsTable).values({
          organizationId: orgId,
          courseId,
          actorUserId: actorId,
          scenario: "draft",
          label,
          horizonDays,
          windowStart: windowStartStr,
          windowEnd: windowEndStr,
          projectedRevenue: draft.revenue.toFixed(2),
          projectedAvgPrice: draft.avgPrice.toFixed(2),
          projectedSeatsBooked: Math.round(draft.seatsBooked),
          projectedSeatsTotal: Math.round(draft.seatsTotal),
          projectedRevenueByDay: draftRevenueByDay,
          assumptions,
        }).returning({ id: teePricingForecastsTable.id });
        savedDraftForecastId = draftRow.id;
      }
    } catch (persistErr) {
      persistenceStatus = "failed";
      logger.warn({ err: persistErr }, "[teePricing] forecast persistence failed");
    }

    return {
      horizonDays,
      courseId,
      assumptions,
      active, draft,
      delta: {
        revenue: deltaRevenue,
        revenuePct: deltaRevenuePct,
        avgPrice: deltaAvgPrice,
        avgPricePct: deltaAvgPricePct,
        utilizationPct: draft.utilizationPct - active.utilizationPct,
      },
      daily,
      forecastId: savedForecastId,
      draftForecastId: savedDraftForecastId,
      persistenceStatus,
    };
  }
}

router.post("/organizations/:orgId/tee-pricing/forecast", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  try {
    const result = await computeForecast(orgId, req.body ?? {}, getActorId(req));
    res.json(result);
  } catch (err) {
    logger.error({ err }, "[teePricing] forecast failed");
    res.status(500).json({ error: "Failed to compute forecast" });
  }
});

// ─── FORECAST ACCURACY (Task #821) ──────────────────────────────────────────
//
// Joins persisted forecast snapshots whose window has fully elapsed against
// the actual booking revenue for the same window, and reports the absolute
// error and accuracy percentage so admins can calibrate how much weight to
// put on a draft's projection. Forecasts whose window has not yet ended are
// reported separately with `status: "pending"` and no accuracy figure.

interface ForecastAccuracyRow {
  forecastId: number;
  scenario: string;
  label: string | null;
  horizonDays: number;
  windowStart: string;
  windowEnd: string;
  courseId: number | null;
  createdAt: string;
  projectedRevenue: number;
  projectedAvgPrice: number;
  actualRevenue: number;
  actualAvgPrice: number;
  actualSeatsBooked: number;
  revenueError: number;
  revenueErrorPct: number | null;
  accuracyPct: number | null;
  accuracyBucket: "high" | "medium" | "low" | null;
  status: "complete" | "pending";
}

function bucketForAccuracy(pct: number): "high" | "medium" | "low" {
  if (pct >= 85) return "high";
  if (pct >= 70) return "medium";
  return "low";
}

router.get("/organizations/:orgId/tee-pricing/forecast-accuracy", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rawLimit = parseInt(String(req.query.limit ?? "50"));
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
  const courseIdQ = req.query.courseId ? parseInt(String(req.query.courseId)) : null;
  const scenarioFilter = typeof req.query.scenario === "string" ? req.query.scenario : null;
  const includePending = req.query.includePending === "true";
  // Task #1258 — when the admin clicks the "Last projection" badge on a
  // tier/modifier card we navigate them to this tab pre-filtered to the
  // matching `publish:tier-<id>` (or `publish:modifier-<id>`) label so they
  // don't have to hunt for the row by hand.
  const labelFilter = typeof req.query.label === "string" && req.query.label.trim() !== ""
    ? req.query.label.trim()
    : null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split("T")[0];

  try {
    const conds = [eq(teePricingForecastsTable.organizationId, orgId)];
    if (courseIdQ != null && !Number.isNaN(courseIdQ)) {
      conds.push(eq(teePricingForecastsTable.courseId, courseIdQ));
    }
    if (scenarioFilter === "active" || scenarioFilter === "draft") {
      conds.push(eq(teePricingForecastsTable.scenario, scenarioFilter));
    }
    if (labelFilter) {
      conds.push(eq(teePricingForecastsTable.label, labelFilter));
    }
    if (!includePending) {
      conds.push(lte(teePricingForecastsTable.windowEnd, todayStr));
    }
    const forecasts = await db.select().from(teePricingForecastsTable)
      .where(and(...conds))
      .orderBy(desc(teePricingForecastsTable.windowEnd), desc(teePricingForecastsTable.createdAt))
      .limit(limit);

    if (forecasts.length === 0) {
      res.json({ rows: [], summary: null });
      return;
    }

    // Pre-compute realised revenue per (windowStart, windowEnd, courseId)
    // by hitting the same booking aggregation logic as the yield report.
    const rows: ForecastAccuracyRow[] = [];
    for (const f of forecasts) {
      const isPending = f.windowEnd > todayStr;
      let actualRevenue = 0;
      let actualSeatsBooked = 0;
      if (!isPending) {
        const params: unknown[] = [orgId, f.windowStart, f.windowEnd];
        let courseClause = "";
        if (f.courseId != null) {
          params.push(f.courseId);
          courseClause = `AND s.course_id = $${params.length}`;
        }
        const realised = await pool.query(`
          SELECT
            COALESCE(SUM(b.total_amount::numeric), 0)::float AS revenue,
            COALESCE(SUM(b.party_size), 0)::int AS seats_booked
          FROM tee_bookings b
          JOIN course_tee_slots s ON s.id = b.slot_id
          WHERE s.organization_id = $1
            AND s.slot_date >= $2::date AND s.slot_date < $3::date
            AND b.status IN ('confirmed','completed')
            ${courseClause}
        `, params);
        actualRevenue = Number(realised.rows[0]?.revenue ?? 0);
        actualSeatsBooked = Number(realised.rows[0]?.seats_booked ?? 0);
      }
      const projectedRevenue = Number(f.projectedRevenue);
      const projectedAvgPrice = Number(f.projectedAvgPrice);
      const actualAvgPrice = actualSeatsBooked > 0 ? actualRevenue / actualSeatsBooked : 0;
      const revenueError = projectedRevenue - actualRevenue;
      let revenueErrorPct: number | null = null;
      let accuracyPct: number | null = null;
      let accuracyBucket: "high" | "medium" | "low" | null = null;
      if (!isPending && actualRevenue > 0) {
        revenueErrorPct = (revenueError / actualRevenue) * 100;
        accuracyPct = Math.max(0, 100 - Math.abs(revenueErrorPct));
        accuracyBucket = bucketForAccuracy(accuracyPct);
      } else if (!isPending && actualRevenue === 0 && projectedRevenue === 0) {
        // Both zero — trivially accurate.
        revenueErrorPct = 0;
        accuracyPct = 100;
        accuracyBucket = "high";
      } else if (!isPending && actualRevenue === 0 && projectedRevenue > 0) {
        // Projected revenue but nothing realised — worst-case miss. We
        // cannot express the error as a percentage of zero, but the
        // forecast was 100% wrong, so it should land in the low bucket
        // and be counted in the summary instead of being silently
        // dropped as null.
        revenueErrorPct = null;
        accuracyPct = 0;
        accuracyBucket = "low";
      }
      rows.push({
        forecastId: f.id,
        scenario: f.scenario,
        label: f.label,
        horizonDays: f.horizonDays,
        windowStart: String(f.windowStart),
        windowEnd: String(f.windowEnd),
        courseId: f.courseId,
        createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : String(f.createdAt),
        projectedRevenue,
        projectedAvgPrice,
        actualRevenue,
        actualAvgPrice,
        actualSeatsBooked,
        revenueError,
        revenueErrorPct,
        accuracyPct,
        accuracyBucket,
        status: isPending ? "pending" : "complete",
      });
    }

    // Roll up an overall summary: average accuracy, count by bucket.
    const completed = rows.filter(r => r.status === "complete" && r.accuracyPct != null);
    const summary = completed.length === 0 ? null : {
      sampleSize: completed.length,
      avgAccuracyPct: completed.reduce((s, r) => s + (r.accuracyPct ?? 0), 0) / completed.length,
      avgAbsoluteErrorPct: completed.reduce((s, r) => s + Math.abs(r.revenueErrorPct ?? 0), 0) / completed.length,
      bucketCounts: {
        high: completed.filter(r => r.accuracyBucket === "high").length,
        medium: completed.filter(r => r.accuracyBucket === "medium").length,
        low: completed.filter(r => r.accuracyBucket === "low").length,
      },
    };
    res.json({ rows, summary });
  } catch (err) {
    logger.error({ err }, "[teePricing] forecast accuracy failed");
    res.status(500).json({ error: "Failed to compute forecast accuracy" });
  }
});

// ─── AUDIT LOG ──────────────────────────────────────────────────────────────

// NOTE: the `/forecast-accuracy/:forecastId` drill-down handler used to live
// here, but it greedily matched any non-numeric trailing segment (e.g.
// `email-schedule`, `email-schedule/preview`) and silently shadowed the
// sibling routes registered further down. It has been moved to the bottom
// of this file — past every `forecast-accuracy/...` sub-path — so Express's
// first-match-wins ordering protects new siblings without anyone needing
// to remember this footgun. Add new `forecast-accuracy/<word>` routes
// ABOVE the drill-down block at the end of the file. See Task #1812.

router.get("/organizations/:orgId/tee-pricing/audit", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const limit = Math.min(parseInt(String(req.query.limit ?? "100")), 500);
  const rows = await db.select().from(teeDynamicPricingAuditTable)
    .where(eq(teeDynamicPricingAuditTable.organizationId, orgId))
    .orderBy(desc(teeDynamicPricingAuditTable.createdAt))
    .limit(limit);
  res.json(rows);
});

// ─── YIELD REPORT ───────────────────────────────────────────────────────────

router.get("/organizations/:orgId/tee-pricing/yield-report", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const { fromDate, toDate, courseId } = req.query as { fromDate?: string; toDate?: string; courseId?: string };
  if (!fromDate || !toDate) { { res.status(400).json({ error: "fromDate, toDate required" }); return; } }

  const params: unknown[] = [orgId, fromDate, toDate];
  let courseClause = "";
  let courseClauseUnaliased = "";
  if (courseId) {
    params.push(parseInt(courseId));
    courseClause = `AND s.course_id = $${params.length}`;
    courseClauseUnaliased = `AND course_id = $${params.length}`;
  }

  // Daily revenue, fill rate, average price.
  // seats_total is computed from the deduplicated slot table to avoid
  // overcounting capacity when a slot has multiple bookings.
  const dailySql = `
    WITH slot_caps AS (
      SELECT slot_date::date AS day, SUM(capacity)::int AS seats_total, COUNT(*)::int AS slots_total
      FROM course_tee_slots s
      WHERE s.organization_id = $1
        AND s.slot_date >= $2::date AND s.slot_date <= $3::date
        ${courseClause}
      GROUP BY day
    ),
    bookings_agg AS (
      SELECT s.slot_date::date AS day,
        COALESCE(SUM(b.party_size), 0)::int AS seats_booked,
        COALESCE(SUM(b.total_amount::numeric), 0)::float AS revenue
      FROM course_tee_slots s
      LEFT JOIN tee_bookings b ON b.slot_id = s.id AND b.status IN ('confirmed','completed')
      WHERE s.organization_id = $1
        AND s.slot_date >= $2::date AND s.slot_date <= $3::date
        ${courseClause}
      GROUP BY day
    )
    SELECT TO_CHAR(c.day, 'YYYY-MM-DD') AS day,
      c.slots_total,
      COALESCE(ba.seats_booked, 0) AS seats_booked,
      c.seats_total,
      COALESCE(ba.revenue, 0)::float AS revenue,
      CASE WHEN COALESCE(ba.seats_booked,0) > 0
           THEN (COALESCE(ba.revenue,0)::float / ba.seats_booked)
           ELSE 0 END AS avg_price_per_seat
    FROM slot_caps c
    LEFT JOIN bookings_agg ba ON ba.day = c.day
    ORDER BY c.day
  `;
  const summarySql = `
    SELECT
      COALESCE(SUM(b.total_amount::numeric), 0)::float AS revenue,
      COALESCE(SUM(b.party_size), 0)::int AS seats_booked,
      (SELECT SUM(capacity) FROM course_tee_slots
        WHERE organization_id = $1 AND slot_date >= $2::date AND slot_date <= $3::date
        ${courseClauseUnaliased})::int AS seats_total,
      COUNT(DISTINCT b.id) AS bookings,
      AVG(CASE WHEN b.party_size > 0 THEN b.total_amount::numeric / b.party_size ELSE NULL END)::float AS avg_price_per_seat
    FROM tee_bookings b
    JOIN course_tee_slots s ON s.id = b.slot_id
    WHERE s.organization_id = $1
      AND s.slot_date >= $2::date AND s.slot_date <= $3::date
      AND b.status IN ('confirmed','completed')
      ${courseClause}
  `;
  const tierSql = `
    SELECT t.id, t.name, COUNT(b.id) AS bookings, COALESCE(SUM(b.total_amount::numeric),0)::float AS revenue
    FROM tee_dynamic_pricing_tiers t
    LEFT JOIN course_tee_slots s ON (t.course_id IS NULL OR s.course_id = t.course_id)
      AND s.organization_id = t.organization_id
      AND s.slot_date >= $2::date AND s.slot_date <= $3::date
    LEFT JOIN tee_bookings b ON b.slot_id = s.id AND b.status IN ('confirmed','completed')
    WHERE t.organization_id = $1
    GROUP BY t.id, t.name
    ORDER BY revenue DESC
  `;
  // Baseline: revenue had no dynamic pricing been applied (use legacy
  // tee_pricing_rules member_rate as the per-seat baseline).
  const baselineSql = `
    SELECT
      COALESCE(SUM(b.party_size * COALESCE(pr.member_rate::numeric, 0)), 0)::float AS baseline_revenue,
      AVG(COALESCE(pr.member_rate::numeric, 0))::float AS baseline_avg_price_per_seat
    FROM tee_bookings b
    JOIN course_tee_slots s ON s.id = b.slot_id
    LEFT JOIN tee_pricing_rules pr ON pr.organization_id = s.organization_id
    WHERE s.organization_id = $1
      AND s.slot_date >= $2::date AND s.slot_date <= $3::date
      AND b.status IN ('confirmed','completed')
      ${courseClause}
  `;
  try {
    const [daily, summary, byTier, baseline] = await Promise.all([
      pool.query(dailySql, params),
      pool.query(summarySql, params),
      pool.query(tierSql, params.slice(0, 3)),
      pool.query(baselineSql, params),
    ]);
    const summaryRow = summary.rows[0] ?? {};
    const baselineRow = baseline.rows[0] ?? {};
    const revenue = Number(summaryRow.revenue ?? 0);
    const baselineRevenue = Number(baselineRow.baseline_revenue ?? 0);
    const uplift = revenue - baselineRevenue;
    const upliftPct = baselineRevenue > 0 ? (uplift / baselineRevenue) * 100 : null;
    res.json({
      summary: {
        ...summaryRow,
        baseline_revenue: baselineRevenue,
        baseline_avg_price_per_seat: Number(baselineRow.baseline_avg_price_per_seat ?? 0),
        uplift_revenue: uplift,
        uplift_pct: upliftPct,
      },
      daily: daily.rows,
      byTier: byTier.rows,
    });
  } catch (err) {
    logger.error({ err }, "[teePricing] yield report failed");
    res.status(500).json({ error: "Failed to generate yield report" });
  }
});

// ─── W2-G SIMPLE PRICING RULES (Task #1004) ─────────────────────────────────
//
// A lighter-weight alternative to tiers/modifiers — admins describe the
// condition (day/time/occupancy/lead-time) and a flat % delta. The rule is
// consulted by the booking pricing engine in lib/dynamicPricing.ts and the
// rule that fired is surfaced in the booking confirmation breakdown.

interface RuleConditionsBody {
  dayOfWeek?: unknown;
  timeRange?: unknown;
  occupancyMin?: unknown;
  leadTimeHoursMax?: unknown;
}

function sanitizeConditions(raw: unknown): {
  dayOfWeek?: number[];
  timeRange?: [string, string];
  occupancyMin?: number;
  leadTimeHoursMax?: number;
} {
  const c = (raw ?? {}) as RuleConditionsBody;
  const out: {
    dayOfWeek?: number[];
    timeRange?: [string, string];
    occupancyMin?: number;
    leadTimeHoursMax?: number;
  } = {};
  if (Array.isArray(c.dayOfWeek)) {
    const dow = (c.dayOfWeek as unknown[])
      .map(d => Number(d))
      .filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
    if (dow.length > 0) out.dayOfWeek = dow;
  }
  if (Array.isArray(c.timeRange) && c.timeRange.length === 2) {
    const [a, b] = c.timeRange as unknown[];
    if (typeof a === "string" && typeof b === "string" && /^\d{2}:\d{2}$/.test(a) && /^\d{2}:\d{2}$/.test(b)) {
      out.timeRange = [a, b];
    }
  }
  if (c.occupancyMin != null) {
    const n = Number(c.occupancyMin);
    if (Number.isFinite(n) && n >= 0 && n <= 1) out.occupancyMin = n;
  }
  if (c.leadTimeHoursMax != null) {
    const n = Number(c.leadTimeHoursMax);
    if (Number.isFinite(n) && n >= 0) out.leadTimeHoursMax = n;
  }
  return out;
}

router.get("/organizations/:orgId/tee-pricing/rules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rows = await db.select().from(teeDynamicPricingRulesTable)
    .where(eq(teeDynamicPricingRulesTable.organizationId, orgId))
    .orderBy(desc(teeDynamicPricingRulesTable.priority), teeDynamicPricingRulesTable.name);
  res.json(rows);
});

router.post("/organizations/:orgId/tee-pricing/rules", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body ?? {};
  if (!b.name) { { res.status(400).json({ error: "name required" }); return; } }
  const conditions = sanitizeConditions(b.conditions);
  const delta = Number(b.priceDeltaPct ?? 0);
  if (!Number.isFinite(delta)) { { res.status(400).json({ error: "priceDeltaPct must be a number" }); return; } }
  const [rule] = await db.insert(teeDynamicPricingRulesTable).values({
    organizationId: orgId,
    name: String(b.name),
    conditions,
    priceDeltaPct: String(delta),
    priority: Number.isInteger(b.priority) ? b.priority : 0,
    active: b.active !== false,
  }).returning();
  await logAudit(orgId, getActorId(req), "rule.created", "rule", rule.id, rule);
  res.status(201).json(rule);
});

router.patch("/organizations/:orgId/tee-pricing/rules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body ?? {};
  const [prev] = await db.select().from(teeDynamicPricingRulesTable)
    .where(and(eq(teeDynamicPricingRulesTable.id, id), eq(teeDynamicPricingRulesTable.organizationId, orgId)));
  if (!prev) { { res.status(404).json({ error: "Rule not found" }); return; } }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (b.name !== undefined) updates.name = String(b.name);
  if (b.conditions !== undefined) updates.conditions = sanitizeConditions(b.conditions);
  if (b.priceDeltaPct !== undefined) {
    const n = Number(b.priceDeltaPct);
    if (!Number.isFinite(n)) { { res.status(400).json({ error: "priceDeltaPct must be a number" }); return; } }
    updates.priceDeltaPct = String(n);
  }
  if (b.priority !== undefined && Number.isInteger(b.priority)) updates.priority = b.priority;
  if (b.active !== undefined) updates.active = !!b.active;
  const [rule] = await db.update(teeDynamicPricingRulesTable).set(updates)
    .where(and(eq(teeDynamicPricingRulesTable.id, id), eq(teeDynamicPricingRulesTable.organizationId, orgId)))
    .returning();
  await logAudit(orgId, getActorId(req), "rule.updated", "rule", id, { previous: prev, next: rule });
  res.json(rule);
});

// Task #1163 — preview which upcoming slots in the next N days (default 7)
// would actually trigger a given rule. We inject the rule into the pricing
// context (even if currently inactive, so admins can sanity-check before
// flipping it on), evaluate every open slot in the window, and return
// only those whose breakdown contains a "rule" step matching this rule id.
//
// Task #1344 — when a rule matches zero (or few) slots admins still need to
// know *why*. We additionally evaluate every non-matching slot through the
// structured `evaluateRule` helper and return up to N near-miss slots that
// failed exactly one condition, with the failure reason / expected / actual
// values attached. This turns the preview from a binary check into a real
// debugging tool that surfaces off-by-one DOW + time-zone bugs even when the
// match list is empty.
router.post("/organizations/:orgId/tee-pricing/rules/:id/preview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const ruleId = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const days = Math.min(31, Math.max(1, Number(req.body?.days) || 7));
  const courseId: number | null = req.body?.courseId != null ? Number(req.body.courseId) : null;
  const memberType: PricingMemberType = req.body?.memberType === "guest" ? "guest" : "member";
  // Default to 5 near-misses; clamp to [0, 25] so a malicious caller can't
  // force a huge response. 0 disables the near-miss section entirely.
  // Non-numeric / NaN inputs fall back to the default rather than silently
  // disabling the section (which would surprise admins debugging a rule).
  const rawLimit = req.body?.nearMissLimit;
  const parsedLimit = rawLimit != null ? Number(rawLimit) : 5;
  const nearMissLimit = Number.isFinite(parsedLimit)
    ? Math.min(25, Math.max(0, Math.floor(parsedLimit)))
    : 5;

  const [rule] = await db.select().from(teeDynamicPricingRulesTable).where(and(
    eq(teeDynamicPricingRulesTable.id, ruleId),
    eq(teeDynamicPricingRulesTable.organizationId, orgId),
  ));
  if (!rule) { { res.status(404).json({ error: "Rule not found" }); return; } }

  const ctx = await loadPricingContext(orgId);
  const ruleRow: PricingRuleRow = {
    id: rule.id,
    name: rule.name,
    conditions: (rule.conditions ?? {}) as PricingRuleRow["conditions"],
    priceDeltaPct: rule.priceDeltaPct,
    priority: rule.priority,
    active: rule.active,
  };
  // Replace any active version of the same rule in ctx, or inject if absent
  // (loadPricingContext drops inactive rules). This lets admins preview a
  // rule that's still being authored before publishing.
  ctx.rules = [ruleRow, ...ctx.rules.filter(r => r.id !== rule.id)];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const horizonEnd = new Date(today);
  horizonEnd.setDate(horizonEnd.getDate() + days);

  const params: unknown[] = [orgId, today.toISOString().split("T")[0], horizonEnd.toISOString().split("T")[0]];
  let courseClause = "";
  if (courseId != null && Number.isFinite(courseId)) {
    params.push(courseId);
    courseClause = `AND s.course_id = $${params.length}`;
  }
  const slotsRes = await pool.query(`
    SELECT s.id, s.course_id, s.slot_date, s.slot_time, s.capacity,
      COALESCE((SELECT SUM(b.party_size) FROM tee_bookings b
        WHERE b.slot_id = s.id AND b.status IN ('confirmed','pending')), 0)::int AS booked
    FROM course_tee_slots s
    WHERE s.organization_id = $1
      AND s.slot_date >= $2::date AND s.slot_date < $3::date
      AND s.status = 'open'
      ${courseClause}
    ORDER BY s.slot_date, s.slot_time
  `, params);

  const now = Date.now();
  const matches: Array<{
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    basePrice: number; finalPrice: number; priceDelta: number; ruleStepIndex: number;
    breakdown: PricingBreakdownStep[];
  }> = [];
  const nearMisses: Array<{
    slotId: number; courseId: number; slotDate: string; slotTime: string;
    capacity: number; bookedCount: number; utilizationPct: number; leadTimeHours: number;
    failures: RuleMatchFailure[];
  }> = [];

  for (const s of slotsRes.rows) {
    const slotDate = new Date(s.slot_date);
    const slotTime = String(s.slot_time);
    const capacity = Number(s.capacity) || 0;
    const booked = Number(s.booked) || 0;
    const utilizationPct = capacity > 0 ? booked / capacity : 0;
    const slotDt = new Date(slotDate);
    const [hh, mm] = slotTime.split(":").map(Number);
    slotDt.setHours(hh, mm ?? 0, 0, 0);
    const leadTimeHours = Math.max(0, (slotDt.getTime() - now) / 3_600_000);

    const resolved = resolveEffectivePriceWith({
      orgId, courseId: Number(s.course_id), slotDate, slotTime,
      capacity, bookedCount: booked, memberType,
    }, ctx);
    const ruleStepIndex = resolved.breakdown.findIndex(
      b => b.source === "rule" && (b.detail as { ruleId?: number } | undefined)?.ruleId === ruleId
    );
    if (ruleStepIndex >= 0) {
      const ruleStep = resolved.breakdown[ruleStepIndex];
      matches.push({
        slotId: Number(s.id),
        courseId: Number(s.course_id),
        slotDate: slotDate.toISOString().split("T")[0],
        slotTime,
        capacity, bookedCount: booked, utilizationPct, leadTimeHours,
        basePrice: resolved.basePrice,
        finalPrice: resolved.finalPrice,
        priceDelta: ruleStep.after - ruleStep.before,
        ruleStepIndex,
        breakdown: resolved.breakdown,
      });
      continue;
    }
    // Slot didn't match — explain why. We only collect near-misses (slots
    // failing exactly one condition) so the section stays signal-rich. We
    // walk the slot list in date/time order, so capping at `nearMissLimit`
    // gives admins the *closest* upcoming near-misses.
    if (nearMissLimit > 0 && nearMisses.length < nearMissLimit) {
      const evalResult = evaluateRule(ruleRow, { slotDate, slotTime, utilizationPct, leadTimeHours });
      if (!evalResult.matched && evalResult.failures.length === 1) {
        nearMisses.push({
          slotId: Number(s.id),
          courseId: Number(s.course_id),
          slotDate: slotDate.toISOString().split("T")[0],
          slotTime,
          capacity, bookedCount: booked, utilizationPct, leadTimeHours,
          failures: evalResult.failures,
        });
      }
    }
  }

  res.json({
    rule: ruleRow,
    days,
    memberType,
    courseId,
    slotsConsidered: slotsRes.rows.length,
    matchCount: matches.length,
    matches,
    nearMissLimit,
    nearMisses,
  });
});

router.delete("/organizations/:orgId/tee-pricing/rules/:id", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [prev] = await db.select().from(teeDynamicPricingRulesTable)
    .where(and(eq(teeDynamicPricingRulesTable.id, id), eq(teeDynamicPricingRulesTable.organizationId, orgId)));
  if (!prev) { { res.status(404).json({ error: "Rule not found" }); return; } }
  await db.delete(teeDynamicPricingRulesTable)
    .where(and(eq(teeDynamicPricingRulesTable.id, id), eq(teeDynamicPricingRulesTable.organizationId, orgId)));
  await logAudit(orgId, getActorId(req), "rule.deleted", "rule", id, prev);
  res.json({ success: true });
});

// ─── Forecast accuracy scheduled email (Task #1254) ──────────────────────────
//
// One schedule per organization that emails the forecast accuracy CSV (the
// same columns as the manual download in the Forecast Accuracy tab) on a
// weekly or monthly cadence. Mirrors the per-currency revenue pivot
// schedule (Task #669) so finance teams configure both with the same
// mental model and the schedule can be paused without losing recipients.

const FORECAST_ACCURACY_FREQUENCIES = new Set(["daily", "weekly", "monthly"]);
const FORECAST_ACCURACY_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function computeForecastAccuracyNextRunAt(frequency: string, from: Date = new Date()): Date {
  const next = new Date(from);
  if (frequency === "daily") next.setDate(next.getDate() + 1);
  else if (frequency === "weekly") next.setDate(next.getDate() + 7);
  else next.setDate(next.getDate() + 30);
  return next;
}

// Length (in days) of the elapsed period a digest covers when no
// `lastSentAt` exists yet — keeps the preview/send-now period span in
// sync with the cadence advance above.
function forecastAccuracyPeriodDays(frequency: string): number {
  if (frequency === "daily") return 1;
  if (frequency === "weekly") return 7;
  return 30;
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const FORECAST_ACCURACY_CSV_HEADERS = [
  "window_start",
  "window_end",
  "scenario",
  "label",
  "projected_revenue",
  "actual_revenue",
  "error_pct",
  "accuracy_pct",
  "bucket",
];

// Task #1476 — per-day companion sheet attached alongside the rolled-up
// digest. Lets ops triage which days inside an elapsed window drove the
// gap without opening the dashboard drill-down. Row order matches the
// rolled-up CSV (newest forecast first) so the two attachments line up
// when admins read them side-by-side.
const FORECAST_ACCURACY_PER_DAY_CSV_HEADERS = [
  "forecast_id",
  "window_start",
  "window_end",
  "scenario",
  "label",
  "day",
  "projected_revenue",
  "actual_revenue",
  "revenue_delta",
  "projection_source",
];

/**
 * Build the forecast accuracy CSV for a digest covering [from, to].
 *
 * Mirrors the columns of the manual download in the Forecast Accuracy tab
 * (see `downloadAccuracyCsv` in `dynamic-pricing.tsx`). Includes only
 * forecasts whose window has fully elapsed (windowEnd <= today) AND
 * windowEnd falls within the digest period — pending windows are
 * intentionally excluded so the CSV is reconciliation-ready.
 *
 * Task #1476 — also returns a per-day companion CSV that, for each
 * forecast in the digest, lists every day inside the elapsed window with
 * its projected revenue (from the `projected_revenue_by_day` snapshot)
 * and the actual revenue. Forecasts written before that column existed
 * fall back to an even flat-distribution across the horizon and are
 * tagged `projection_source=flat` so admins know which rows are
 * approximations.
 */
export async function buildForecastAccuracyCsv(opts: {
  orgId: number;
  from: Date | null;
  to: Date;
}): Promise<{ csv: string; perDayCsv: string; rowCount: number; perDayRowCount: number }> {
  const { orgId, from, to } = opts;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split("T")[0];
  const toStr = to.toISOString().split("T")[0];
  const fromStr = from ? from.toISOString().split("T")[0] : null;

  // Cap windowEnd at "today" so we never include pending/in-progress
  // windows (matching the manual download's default `includePending=false`).
  const upperBound = toStr < todayStr ? toStr : todayStr;

  const conds = [eq(teePricingForecastsTable.organizationId, orgId)];
  conds.push(lte(teePricingForecastsTable.windowEnd, upperBound));
  if (fromStr) conds.push(gte(teePricingForecastsTable.windowEnd, fromStr));

  const forecasts = await db.select().from(teePricingForecastsTable)
    .where(and(...conds))
    .orderBy(desc(teePricingForecastsTable.windowEnd), desc(teePricingForecastsTable.createdAt));

  const lines = [FORECAST_ACCURACY_CSV_HEADERS.join(",")];
  const perDayLines = [FORECAST_ACCURACY_PER_DAY_CSV_HEADERS.join(",")];
  let perDayRowCount = 0;

  for (const f of forecasts) {
    const params: unknown[] = [orgId, f.windowStart, f.windowEnd];
    let courseClause = "";
    if (f.courseId != null) {
      params.push(f.courseId);
      courseClause = `AND s.course_id = $${params.length}`;
    }
    const [realised, perDay] = await Promise.all([
      pool.query(`
        SELECT
          COALESCE(SUM(b.total_amount::numeric), 0)::float AS revenue
        FROM tee_bookings b
        JOIN course_tee_slots s ON s.id = b.slot_id
        WHERE s.organization_id = $1
          AND s.slot_date >= $2::date AND s.slot_date < $3::date
          AND b.status IN ('confirmed','completed')
          ${courseClause}
      `, params),
      // Per-day actual revenue across every day in the elapsed window
      // (including zero-booking days, so the per-day sheet has one row
      // per day even when revenue was 0). Mirrors the daily query in
      // the forecast-accuracy detail endpoint.
      pool.query(`
        WITH days AS (
          SELECT generate_series($2::date, ($3::date - INTERVAL '1 day')::date, '1 day')::date AS day
        ),
        bookings_agg AS (
          SELECT s.slot_date::date AS day,
            COALESCE(SUM(b.total_amount::numeric), 0)::float AS revenue
          FROM course_tee_slots s
          JOIN tee_bookings b ON b.slot_id = s.id AND b.status IN ('confirmed','completed')
          WHERE s.organization_id = $1
            AND s.slot_date >= $2::date AND s.slot_date < $3::date
            ${courseClause}
          GROUP BY day
        )
        SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
          COALESCE(ba.revenue, 0)::float AS revenue
        FROM days d
        LEFT JOIN bookings_agg ba ON ba.day = d.day
        ORDER BY d.day
      `, params),
    ]);
    const actualRevenue = Number(realised.rows[0]?.revenue ?? 0);
    const projectedRevenue = Number(f.projectedRevenue);
    const revenueError = projectedRevenue - actualRevenue;
    let revenueErrorPct: number | null = null;
    let accuracyPct: number | null = null;
    let accuracyBucket: "high" | "medium" | "low" | null = null;
    if (actualRevenue > 0) {
      revenueErrorPct = (revenueError / actualRevenue) * 100;
      accuracyPct = Math.max(0, 100 - Math.abs(revenueErrorPct));
      accuracyBucket = accuracyPct >= 85 ? "high" : accuracyPct >= 70 ? "medium" : "low";
    } else if (projectedRevenue === 0) {
      revenueErrorPct = 0;
      accuracyPct = 100;
      accuracyBucket = "high";
    } else {
      revenueErrorPct = null;
      accuracyPct = 0;
      accuracyBucket = "low";
    }
    lines.push([
      f.windowStart,
      f.windowEnd,
      f.scenario,
      f.label ?? "",
      projectedRevenue,
      actualRevenue,
      revenueErrorPct == null ? "" : revenueErrorPct.toFixed(2),
      accuracyPct == null ? "" : accuracyPct.toFixed(2),
      accuracyBucket ?? "",
    ].map(csvEscape).join(","));

    // Task #1476 — emit one per-day row per day in the elapsed window.
    // Use the `projected_revenue_by_day` snapshot when present;
    // otherwise distribute the projected total evenly across the
    // horizon (same fallback the drill-down uses for legacy forecasts
    // written before the column existed). The `projection_source`
    // column tells admins which rows are approximations.
    const dayRows: Array<{ day: string; revenue: number }> = perDay.rows.map(
      (r: { day: string; revenue: number }) => ({ day: String(r.day), revenue: Number(r.revenue) || 0 })
    );
    const storedByDayRaw = f.projectedRevenueByDay;
    const storedByDay: Map<string, number> | null = (() => {
      if (!Array.isArray(storedByDayRaw) || storedByDayRaw.length === 0) return null;
      const m = new Map<string, number>();
      for (const entry of storedByDayRaw) {
        if (entry && typeof entry === "object" && typeof entry.day === "string") {
          const rev = Number((entry as { revenue?: unknown }).revenue);
          if (Number.isFinite(rev)) m.set(entry.day, rev);
        }
      }
      return m.size > 0 ? m : null;
    })();
    const projectionSource: "snapshot" | "flat" = storedByDay ? "snapshot" : "flat";
    const horizonDays = f.horizonDays > 0 ? f.horizonDays : Math.max(1, dayRows.length);
    const projectedPerDayFlat = horizonDays > 0 ? projectedRevenue / horizonDays : 0;
    const projectionForDay = (dayStr: string): number => {
      if (storedByDay) return storedByDay.get(dayStr) ?? 0;
      return projectedPerDayFlat;
    };
    for (const row of dayRows) {
      const dayProjection = projectionForDay(row.day);
      perDayLines.push([
        f.id,
        f.windowStart,
        f.windowEnd,
        f.scenario,
        f.label ?? "",
        row.day,
        dayProjection.toFixed(2),
        row.revenue.toFixed(2),
        (row.revenue - dayProjection).toFixed(2),
        projectionSource,
      ].map(csvEscape).join(","));
      perDayRowCount += 1;
    }
  }

  return {
    csv: lines.join("\n"),
    perDayCsv: perDayLines.join("\n"),
    rowCount: forecasts.length,
    perDayRowCount,
  };
}

// Roles that count as "finance team" for the recipient picker. The org_role
// enum doesn't have a literal "finance" entry, so we surface treasurers
// here — the role tagged in `org_memberships` for finance contacts. Admins
// can still type any external accountant's email by hand into the textarea.
const FORECAST_ACCURACY_FINANCE_ROLES: ("treasurer")[] = ["treasurer"];

/**
 * List the finance-team members eligible to be added to the forecast
 * accuracy email schedule recipient list (Task #1471). Returns active
 * (non-erased) org members tagged with a finance-related role.
 *
 * Members with a usable email on file appear in `members` (the picker
 * dropdown). Members with NO email on file appear in `missingEmail` so
 * the UI can surface a "X treasurers can't be picked because they have
 * no email on file" hint with click-throughs to fix the underlying
 * member record (Task #1805) — otherwise admins just see them silently
 * absent from the dropdown and have no signal that "Bob Treasurer" is
 * missing because his account has no email.
 *
 * Admins still type raw emails for external accountants in the
 * recipients textarea — this endpoint just removes the "whose inbox is
 * finance@club.com?" memory tax for internal staff.
 */
router.get("/organizations/:orgId/tee-pricing/forecast-accuracy/email-schedule/finance-team-members", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rows = await db.select({
    userId: appUsersTable.id,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
    email: appUsersTable.email,
    role: orgMembershipsTable.role,
  })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      inArray(orgMembershipsTable.role, FORECAST_ACCURACY_FINANCE_ROLES),
      isNull(appUsersTable.erasedAt),
    ))
    .orderBy(appUsersTable.displayName, appUsersTable.email);

  // Dedupe pickable rows by email (a user could in theory have multiple
  // memberships in future, and we don't want the same email to appear
  // twice in the picker). Dedupe missing-email rows by userId — they have
  // no email to key on, but the same user shouldn't appear twice if they
  // somehow hold two finance memberships.
  const seenEmails = new Set<string>();
  const seenMissingUserIds = new Set<number>();
  const members = [] as Array<{ userId: number; displayName: string | null; email: string; role: string }>;
  const missingEmail = [] as Array<{ userId: number; displayName: string | null; username: string | null; role: string }>;
  for (const r of rows) {
    if (r.email) {
      const key = r.email.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      members.push({ userId: r.userId, displayName: r.displayName, email: r.email, role: r.role });
    } else {
      if (seenMissingUserIds.has(r.userId)) continue;
      seenMissingUserIds.add(r.userId);
      missingEmail.push({ userId: r.userId, displayName: r.displayName, username: r.username, role: r.role });
    }
  }

  res.json({ members, missingEmail, missingEmailCount: missingEmail.length });
});

router.get("/organizations/:orgId/tee-pricing/forecast-accuracy/email-schedule", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(forecastAccuracyEmailSchedulesTable)
    .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));

  const history = schedule
    ? await db.select().from(forecastAccuracyEmailRunsTable)
        .where(eq(forecastAccuracyEmailRunsTable.scheduleId, schedule.id))
        .orderBy(desc(forecastAccuracyEmailRunsTable.sentAt))
        .limit(50)
    : [];

  res.json({ schedule: schedule ?? null, history });
});

router.put("/organizations/:orgId/tee-pricing/forecast-accuracy/email-schedule", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const body = req.body as { frequency?: string; recipients?: unknown; enabled?: boolean };
  const frequency = String(body.frequency ?? "").toLowerCase();
  if (!FORECAST_ACCURACY_FREQUENCIES.has(frequency)) {
    res.status(400).json({ error: "frequency must be 'daily', 'weekly', or 'monthly'" }); return;
  }
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    const s = String(r ?? "").trim();
    if (!s) continue;
    if (!FORECAST_ACCURACY_EMAIL_RE.test(s)) { { res.status(400).json({ error: `invalid recipient email: ${s}` }); return; } }
    if (!recipients.includes(s)) recipients.push(s);
  }
  if (recipients.length === 0) {
    res.status(400).json({ error: "at least one recipient email is required" }); return;
  }
  if (recipients.length > 20) {
    res.status(400).json({ error: "no more than 20 recipients per schedule" }); return;
  }
  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);

  const now = new Date();
  const userId = getActorId(req);

  const [existing] = await db.select().from(forecastAccuracyEmailSchedulesTable)
    .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));

  let saved;
  if (existing) {
    const freqChanged = existing.frequency !== frequency;
    const reEnabled = !existing.enabled && enabled;
    const nextRunAt = (freqChanged || reEnabled || !existing.nextRunAt)
      ? computeForecastAccuracyNextRunAt(frequency, now)
      : existing.nextRunAt;
    const [row] = await db.update(forecastAccuracyEmailSchedulesTable).set({
      frequency, recipients, enabled, nextRunAt, updatedAt: now,
    }).where(eq(forecastAccuracyEmailSchedulesTable.id, existing.id)).returning();
    saved = row;
  } else {
    const [row] = await db.insert(forecastAccuracyEmailSchedulesTable).values({
      organizationId: orgId,
      frequency,
      recipients,
      enabled,
      nextRunAt: computeForecastAccuracyNextRunAt(frequency, now),
      createdByUserId: userId,
    }).returning();
    saved = row;
  }

  res.json({ schedule: saved });
});

router.delete("/organizations/:orgId/tee-pricing/forecast-accuracy/email-schedule", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;
  await db.delete(forecastAccuracyEmailSchedulesTable)
    .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
  res.json({ ok: true });
});

/**
 * Preview the *next* forecast accuracy email exactly as it would be sent
 * right now, without dispatching mail or recording a run. Lets admins
 * sanity-check the rendered subject/body and CSV row count before
 * committing recipients to the cadence.
 */
router.get("/organizations/:orgId/tee-pricing/forecast-accuracy/email-schedule/preview", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(forecastAccuracyEmailSchedulesTable)
    .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
  if (!schedule) { { res.status(404).json({ error: "No forecast accuracy schedule configured" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name, timezone: organizationsTable.bouncedDigestTimezone })
    .from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - forecastAccuracyPeriodDays(schedule.frequency) * 24 * 60 * 60 * 1000);

  const { csv, perDayCsv, rowCount, perDayRowCount } = await buildForecastAccuracyCsv({
    orgId, from: periodStart, to: now,
  });

  const { subject, html, filename, perDayFilename } = buildForecastAccuracyScheduleEmailContent({
    orgName: org?.name ?? "KHARAGOLF",
    frequency: schedule.frequency as "daily" | "weekly" | "monthly",
    periodStart,
    periodEnd: now,
    rowCount,
    perDayRowCount,
    timezone: org?.timezone ?? null,
  });

  // Sample of the CSV that would be attached so admins can spot a
  // missing window or off-by-one period right in the preview.
  const csvLines = csv.split("\n");
  const sampleRows = csvLines.slice(1, 11);
  // Task #1476 — also surface a sample of the companion per-day sheet
  // so admins can sanity-check the day-level projected vs actual rows
  // before committing recipients to the cadence.
  const perDayLines = perDayCsv.split("\n");
  const perDaySampleRows = perDayLines.slice(1, 11);

  res.json({
    subject,
    html,
    filename,
    perDayFilename,
    rowCount,
    perDayRowCount,
    recipients: Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [],
    frequency: schedule.frequency,
    periodStart: periodStart.toISOString(),
    periodEnd: now.toISOString(),
    csvSample: { header: csvLines[0] ?? "", rows: sampleRows, totalRows: rowCount, sampleSize: sampleRows.length },
    perDayCsvSample: { header: perDayLines[0] ?? "", rows: perDaySampleRows, totalRows: perDayRowCount, sampleSize: perDaySampleRows.length },
  });
});

router.post("/organizations/:orgId/tee-pricing/forecast-accuracy/email-schedule/send-now", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const [schedule] = await db.select().from(forecastAccuracyEmailSchedulesTable)
    .where(eq(forecastAccuracyEmailSchedulesTable.organizationId, orgId));
  if (!schedule) { { res.status(404).json({ error: "No forecast accuracy schedule configured" }); return; } }

  const result = await runOneForecastAccuracyEmailSchedule(schedule.id);
  res.json(result);
});

/**
 * Execute one forecast accuracy schedule end-to-end: build the CSV for the
 * elapsed period, email it to the configured recipients, record the run in
 * history, and advance the cadence. Shared by the cron poller and the
 * manual send-now endpoint.
 */
export async function runOneForecastAccuracyEmailSchedule(scheduleId: number): Promise<{
  status: "sent" | "failed" | "skipped";
  rowCount: number;
  recipients: string[];
  errorMessage?: string;
}> {
  const [schedule] = await db.select().from(forecastAccuracyEmailSchedulesTable)
    .where(eq(forecastAccuracyEmailSchedulesTable.id, scheduleId));
  if (!schedule) {
    return { status: "skipped", rowCount: 0, recipients: [], errorMessage: "schedule not found" };
  }

  const recipients = Array.isArray(schedule.recipients) ? (schedule.recipients as string[]) : [];
  const now = new Date();
  const periodStart = schedule.lastSentAt
    ?? new Date(now.getTime() - forecastAccuracyPeriodDays(schedule.frequency) * 24 * 60 * 60 * 1000);

  if (recipients.length === 0) {
    await db.insert(forecastAccuracyEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients,
      rowCount: 0,
      status: "skipped",
      errorMessage: "no recipients configured",
    });
    // Advance cadence so the cron doesn't re-skip every poll cycle and fill
    // the history table with duplicate skipped rows until an admin adds a
    // recipient. Mirrors the daily-empty skip path (Task #1804).
    await db.update(forecastAccuracyEmailSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeForecastAccuracyNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(forecastAccuracyEmailSchedulesTable.id, schedule.id));
    return { status: "skipped", rowCount: 0, recipients, errorMessage: "no recipients configured" };
  }

  const [org] = await db.select({ name: organizationsTable.name, timezone: organizationsTable.bouncedDigestTimezone })
    .from(organizationsTable).where(eq(organizationsTable.id, schedule.organizationId));

  const { csv, perDayCsv, rowCount, perDayRowCount } = await buildForecastAccuracyCsv({
    orgId: schedule.organizationId,
    from: periodStart,
    to: now,
  });

  // Daily cadence covers a much shorter elapsed window (1 day vs 7/30) and
  // will frequently land on days with no completed forecast windows. Skip
  // the email entirely instead of mailing finance a header-only CSV; mirrors
  // the empty-recipients 'skipped' contract above. Cadence still advances
  // so we don't re-skip on every poll cycle.
  if (schedule.frequency === "daily" && rowCount === 0) {
    await db.insert(forecastAccuracyEmailRunsTable).values({
      scheduleId: schedule.id,
      organizationId: schedule.organizationId,
      periodStart,
      periodEnd: now,
      recipients,
      rowCount: 0,
      status: "skipped",
      errorMessage: "no completed forecast windows in period",
    });
    await db.update(forecastAccuracyEmailSchedulesTable).set({
      lastSentAt: now,
      nextRunAt: computeForecastAccuracyNextRunAt(schedule.frequency, now),
      updatedAt: now,
    }).where(eq(forecastAccuracyEmailSchedulesTable.id, schedule.id));
    return { status: "skipped", rowCount: 0, recipients, errorMessage: "no completed forecast windows in period" };
  }

  let status: "sent" | "failed" = "sent";
  let errorMessage: string | undefined;

  try {
    await sendForecastAccuracyScheduleEmail({
      to: recipients,
      orgName: org?.name ?? "KHARAGOLF",
      frequency: schedule.frequency as "daily" | "weekly" | "monthly",
      periodStart,
      periodEnd: now,
      rowCount,
      csv,
      perDayCsv,
      perDayRowCount,
      timezone: org?.timezone ?? null,
    });
  } catch (err) {
    status = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ err, scheduleId: schedule.id }, "[forecast-accuracy-email] send failed");
  }

  await db.insert(forecastAccuracyEmailRunsTable).values({
    scheduleId: schedule.id,
    organizationId: schedule.organizationId,
    periodStart,
    periodEnd: now,
    recipients,
    rowCount,
    status,
    errorMessage,
  });

  // Advance cadence even on failure so we don't hammer a broken inbox every
  // poll cycle. Failures show up in history with the error message; the
  // next run will retry on the normal schedule.
  await db.update(forecastAccuracyEmailSchedulesTable).set({
    lastSentAt: now,
    nextRunAt: computeForecastAccuracyNextRunAt(schedule.frequency, now),
    updatedAt: now,
  }).where(eq(forecastAccuracyEmailSchedulesTable.id, schedule.id));

  return { status, rowCount, recipients, errorMessage };
}

/** Cron entry-point for forecast accuracy digests (Task #1254). */
export async function runDueForecastAccuracyEmailSchedules(): Promise<void> {
  const now = new Date();
  const due = await db.select({ id: forecastAccuracyEmailSchedulesTable.id })
    .from(forecastAccuracyEmailSchedulesTable)
    .where(and(
      eq(forecastAccuracyEmailSchedulesTable.enabled, true),
      lte(forecastAccuracyEmailSchedulesTable.nextRunAt, now),
    ));
  for (const row of due) {
    try {
      await runOneForecastAccuracyEmailSchedule(row.id);
    } catch (err) {
      logger.warn({ err, scheduleId: row.id }, "[forecast-accuracy-email] schedule poll error");
    }
  }
}

// ─── FORECAST ACCURACY DRILL-DOWN ───────────────────────────────────────────
//
// Drill-down detail for a single past forecast (Task #1097). Returns the
// stored projection metadata + assumptions alongside a per-day breakdown of
// projected vs actual revenue, plus the booking-volume / utilisation factors
// admins use to attribute the miss. Forecasts whose window has not yet
// elapsed return the daily structure with zeroed actuals so the UI can still
// render the projected baseline.
//
// CAREFUL — placement matters (Task #1812). The `:forecastId` segment will
// match ANY non-empty string Express sees, so this catch-all is registered
// LAST in the file, after every specific `forecast-accuracy/<word>` sibling
// (e.g. `/email-schedule`, `/email-schedule/preview`, `/email-schedule/send-now`,
// `/email-schedule/finance-team-members`). Express's first-match-wins routing
// then guarantees those siblings are reached first. New `forecast-accuracy/...`
// routes MUST be registered above this block. As a defense-in-depth the
// handler also calls `next()` for non-numeric segments so a misplaced new
// sibling above it would still fall through instead of 400ing.
router.get("/organizations/:orgId/tee-pricing/forecast-accuracy/:forecastId", async (req: Request, res: Response, next: NextFunction) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const forecastId = parseInt(String((req.params as Record<string, string>).forecastId));
  if (!Number.isFinite(forecastId)) return next();
  if (!await requireOrgAdmin(req, res, orgId)) return;

  try {
    const [f] = await db.select().from(teePricingForecastsTable)
      .where(and(
        eq(teePricingForecastsTable.id, forecastId),
        eq(teePricingForecastsTable.organizationId, orgId),
      ));
    if (!f) { { res.status(404).json({ error: "Forecast not found" }); return; } }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split("T")[0];
    const windowStartStr = String(f.windowStart);
    const windowEndStr = String(f.windowEnd);
    const isPending = windowEndStr > todayStr;

    const params: unknown[] = [orgId, windowStartStr, windowEndStr];
    let courseClause = "";
    if (f.courseId != null) {
      params.push(f.courseId);
      courseClause = `AND s.course_id = $${params.length}`;
    }

    const dailyRes = await pool.query(`
      WITH days AS (
        SELECT generate_series($2::date, ($3::date - INTERVAL '1 day')::date, '1 day')::date AS day
      ),
      slot_caps AS (
        SELECT s.slot_date::date AS day,
          SUM(s.capacity)::int AS seats_total,
          COUNT(*)::int AS slots_total
        FROM course_tee_slots s
        WHERE s.organization_id = $1
          AND s.slot_date >= $2::date AND s.slot_date < $3::date
          ${courseClause}
        GROUP BY day
      ),
      bookings_agg AS (
        SELECT s.slot_date::date AS day,
          COALESCE(SUM(b.party_size), 0)::int AS seats_booked,
          COUNT(DISTINCT b.id)::int AS bookings,
          COALESCE(SUM(b.total_amount::numeric), 0)::float AS revenue
        FROM course_tee_slots s
        JOIN tee_bookings b ON b.slot_id = s.id AND b.status IN ('confirmed','completed')
        WHERE s.organization_id = $1
          AND s.slot_date >= $2::date AND s.slot_date < $3::date
          ${courseClause}
        GROUP BY day
      )
      SELECT TO_CHAR(d.day, 'YYYY-MM-DD') AS day,
        COALESCE(c.seats_total, 0) AS seats_total,
        COALESCE(c.slots_total, 0) AS slots_total,
        COALESCE(ba.seats_booked, 0) AS seats_booked,
        COALESCE(ba.bookings, 0) AS bookings,
        COALESCE(ba.revenue, 0)::float AS revenue
      FROM days d
      LEFT JOIN slot_caps c ON c.day = d.day
      LEFT JOIN bookings_agg ba ON ba.day = d.day
      ORDER BY d.day
    `, params);

    const horizonDays = f.horizonDays > 0 ? f.horizonDays : Math.max(1, dailyRes.rows.length);
    const projectedRevenue = Number(f.projectedRevenue);

    // Task #1263 — use the per-day projection captured at snapshot time when
    // available so weekends, tier overrides, etc. show their real expected
    // revenue. Fall back to a flat distribution across the horizon for
    // forecasts written before this column existed (or when the snapshot
    // produced an empty array, which would otherwise mis-attribute the
    // projected total to no day at all).
    const storedByDayRaw = f.projectedRevenueByDay;
    const storedByDay: Map<string, number> | null = (() => {
      if (!Array.isArray(storedByDayRaw) || storedByDayRaw.length === 0) return null;
      const m = new Map<string, number>();
      for (const entry of storedByDayRaw) {
        if (entry && typeof entry === "object" && typeof entry.day === "string") {
          const rev = Number((entry as { revenue?: unknown }).revenue);
          if (Number.isFinite(rev)) m.set(entry.day, rev);
        }
      }
      return m.size > 0 ? m : null;
    })();
    const projectionSource: "snapshot" | "flat" = storedByDay ? "snapshot" : "flat";
    const projectedPerDayFlat = horizonDays > 0 ? projectedRevenue / horizonDays : 0;
    const projectionForDay = (dayStr: string): number => {
      if (storedByDay) return storedByDay.get(dayStr) ?? 0;
      return projectedPerDayFlat;
    };

    const daily = dailyRes.rows.map((row: { day: string; seats_total: number; slots_total: number; seats_booked: number; bookings: number; revenue: number }) => {
      const seatsTotal = Number(row.seats_total) || 0;
      const seatsBooked = Number(row.seats_booked) || 0;
      const revenue = Number(row.revenue) || 0;
      const bookings = Number(row.bookings) || 0;
      const slotsTotal = Number(row.slots_total) || 0;
      const utilizationPct = seatsTotal > 0 ? seatsBooked / seatsTotal : 0;
      const avgPricePerSeat = seatsBooked > 0 ? revenue / seatsBooked : 0;
      const dayStr = String(row.day);
      const dayIsPending = dayStr > todayStr;
      const dayProjection = projectionForDay(dayStr);
      return {
        day: dayStr,
        projectedRevenue: dayProjection,
        actualRevenue: dayIsPending ? 0 : revenue,
        actualBookings: dayIsPending ? 0 : bookings,
        actualSeatsBooked: dayIsPending ? 0 : seatsBooked,
        slotsTotal,
        seatsTotal,
        utilizationPct: dayIsPending ? 0 : utilizationPct,
        avgPricePerSeat: dayIsPending ? 0 : avgPricePerSeat,
        revenueDelta: dayIsPending ? 0 : (revenue - dayProjection),
        pending: dayIsPending,
      };
    });

    const totalsActualRevenue = daily.reduce((s, d) => s + d.actualRevenue, 0);
    const totalsActualSeatsBooked = daily.reduce((s, d) => s + d.actualSeatsBooked, 0);
    const totalsActualBookings = daily.reduce((s, d) => s + d.actualBookings, 0);
    const totalsSeatsTotal = daily.reduce((s, d) => s + d.seatsTotal, 0);
    const revenueError = projectedRevenue - totalsActualRevenue;
    const revenueErrorPct = totalsActualRevenue > 0 ? (revenueError / totalsActualRevenue) * 100 : null;
    let accuracyPct: number | null = null;
    if (!isPending) {
      if (totalsActualRevenue > 0) accuracyPct = Math.max(0, 100 - Math.abs(revenueErrorPct ?? 0));
      else if (projectedRevenue === 0) accuracyPct = 100;
      else accuracyPct = 0;
    }

    // Surface the day with the largest projected-vs-actual gap as the
    // "biggest miss" callout. Pending days are excluded.
    const completedDays = daily.filter(d => !d.pending);
    let biggestMiss: { day: string; revenueDelta: number } | null = null;
    if (completedDays.length > 0) {
      const sorted = [...completedDays].sort((a, b) => Math.abs(b.revenueDelta) - Math.abs(a.revenueDelta));
      biggestMiss = { day: sorted[0].day, revenueDelta: sorted[0].revenueDelta };
    }

    res.json({
      forecast: {
        id: f.id,
        scenario: f.scenario,
        label: f.label,
        horizonDays: f.horizonDays,
        windowStart: windowStartStr,
        windowEnd: windowEndStr,
        courseId: f.courseId,
        actorUserId: f.actorUserId,
        createdAt: f.createdAt instanceof Date ? f.createdAt.toISOString() : String(f.createdAt),
        projectedRevenue,
        projectedAvgPrice: Number(f.projectedAvgPrice),
        projectedSeatsBooked: f.projectedSeatsBooked,
        projectedSeatsTotal: f.projectedSeatsTotal,
        assumptions: f.assumptions ?? null,
      },
      totals: {
        projectedRevenue,
        actualRevenue: totalsActualRevenue,
        actualSeatsBooked: totalsActualSeatsBooked,
        actualBookings: totalsActualBookings,
        seatsTotal: totalsSeatsTotal,
        revenueError,
        revenueErrorPct,
        accuracyPct,
        utilizationPct: totalsSeatsTotal > 0 ? totalsActualSeatsBooked / totalsSeatsTotal : 0,
        avgPricePerSeat: totalsActualSeatsBooked > 0 ? totalsActualRevenue / totalsActualSeatsBooked : 0,
      },
      daily,
      biggestMiss,
      status: isPending ? "pending" : "complete",
      // Task #1263 — tells the UI whether the per-day projection comes from
      // the snapshot the forecaster recorded or from the legacy flat
      // distribution fallback (used for forecasts written before the
      // per-day column existed).
      projectionSource,
    });
  } catch (err) {
    logger.error({ err, forecastId }, "[teePricing] forecast accuracy detail failed");
    res.status(500).json({ error: "Failed to load forecast detail" });
  }
});

export default router;
