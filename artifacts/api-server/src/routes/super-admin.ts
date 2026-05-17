import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  organizationsTable, appUsersTable, orgMembershipsTable,
  tournamentsTable, playersTable, leaguesTable, teeBookingsTable,
  subscriptionPlanConfigsTable, orgPlanOverridesTable,
  memberAuditLogTable, watchPositionMetricsTable,
  manualEntryAlertPageHistoryTable,
} from "@workspace/db";
import { eq, count, sql, and, ilike, or, asc, desc, inArray, SQL } from "drizzle-orm";
import { TIER_DISPLAY, getTierDisplay, isSubscriptionTier, SUBSCRIPTION_TIERS, type SubscriptionTier } from "../lib/subscriptionTiers";
import { getAllTierConfigs, invalidatePlanConfigCache, getHardcodedDefault } from "../lib/planConfigLoader";
import { getCaddiePromptMetricsSummary } from "../lib/caddiePromptMetrics";
import {
  getWatchPositionMetricsSummary,
  getTopSessionsForBucket,
  getRecentWatchPositionSamples,
  muteWatchSession,
  listActiveMutedSessionsFromDb,
  getPersistedWatchSessionMuteExpiryMs,
  deletePersistedWatchSessionMute,
  dropLocalWatchSessionMute,
  sendWatchGpsOpsAlertTestPage,
  recordWatchGpsOpsAlertTestPage,
  getWatchGpsOpsAlertTestPageHistory,
  WATCH_SESSION_MUTE_MAX_TTL_MS,
} from "../lib/watchPositionMetrics";
import { recordMemberAudit } from "../lib/auditMember";
import {
  getManualEntryAlertHealthSummary,
  listManualEntryAlertRows,
  getManualEntryAlertSilentRecipients,
  buildManualEntryAlertsCsv,
  buildManualEntryAlertSilentRecipientsCsv,
  MANUAL_ENTRY_ALERT_CSV_MAX_ROWS,
  parseManualEntryAlertRowsQuery,
} from "../lib/manualEntryAlertHealth";
import { getBadgeShareRollupAdminSummary } from "../lib/badgeShareRollup";
import { getProfileShareRollupAdminSummary } from "../lib/profileShareRollup";
import {
  getBadgeShareRollupOpsAlertChatTargetsStatus,
  sendBadgeShareRollupOpsAlertTestPage,
} from "../lib/badgeShareRollupOpsAlert";
import {
  loadLastProfileShareRollupOpsAlertAt,
  loadRecentProfileShareRollupOpsAlerts,
  getProfileShareRollupOpsAlertCooldownHours,
} from "../lib/profileShareRollupOpsAlert";
import {
  getManualEntryAlertHealthOpsAlertChatTargetsStatus,
  sendManualEntryAlertHealthOpsAlertChatTestPage,
} from "../lib/manualEntryAlertHealthOpsAlert";
import { verifyPlanMigrationAckToken } from "../lib/plan-migration-ack-token";
import { notifySuperAdminsOfPlanMigration } from "../lib/planMigrationDigest";
import {
  listLegacySlugMappings,
  upsertLegacySlugMapping,
  deleteLegacySlugMapping,
} from "../lib/legacySlugMappings";
import {
  resolveOpsAlertConfig,
  updateOpsAlertSettings,
  listOpsAlertSettingsHistory,
  recordOpsAlertTestSent,
  countOpsAlertSettingsHistory,
  OPS_ALERT_HISTORY_MAX_LIMIT,
} from "../lib/opsAlertSettings";
import {
  runNotifyExhaustionOpsAlertJob,
  getNotifyRetryExhaustionChatTargetsStatus,
  getNotifyRetryExhaustionOpsAlertChatTargetsStatus,
  sendNotifyRetryExhaustionOpsAlertTestPage,
} from "../lib/notifyExhaustionOpsAlert";
import {
  getManualEntryAlertHealthCooldownStatus,
  sendManualEntryAlertHealthOpsAlertTestPage,
} from "../lib/manualEntryAlertHealthOpsAlert";
import { resolveOpsAlertChatTargetsStatus } from "../lib/opsAlertChat";
import {
  countUnmeasuredLegacyVideos,
  runLegacyVideoBackfillBatch,
  LEGACY_BACKFILL_BATCH_SIZE,
} from "../lib/legacyVideoBackfill";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireSuperAdmin(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Authentication required." });
    return false;
  }
  const user = req.user as { role?: string };
  if (user?.role !== "super_admin") {
    res.status(403).json({ error: "Super admin access required." });
    return false;
  }
  return true;
}

// GET /super-admin/dashboard — platform-wide KPIs
router.get("/super-admin/dashboard", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const [totalClubs] = await db.select({ count: count() }).from(organizationsTable);
  const [activeClubs] = await db.select({ count: count() }).from(organizationsTable).where(eq(organizationsTable.isActive, true));
  const [totalUsers] = await db.select({ count: count() }).from(appUsersTable);
  const [totalTournaments] = await db.select({ count: count() }).from(tournamentsTable);
  const [activeTournaments] = await db.select({ count: count() }).from(tournamentsTable).where(sql`${tournamentsTable.status} = 'active'`);

  const tierBreakdown = await db
    .select({ tier: organizationsTable.subscriptionTier, count: count() })
    .from(organizationsTable)
    .groupBy(organizationsTable.subscriptionTier);

  const tierCounts: Record<string, number> = {};
  for (const row of tierBreakdown) {
    tierCounts[row.tier] = Number(row.count);
  }

  const mrr = Object.entries(tierCounts).reduce((sum, [tier, cnt]) => {
    const price = TIER_DISPLAY[tier as SubscriptionTier]?.priceMonthly ?? 0;
    return sum + price * cnt;
  }, 0);

  // Booking stats for current month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [bookingsThisMonth] = await db
    .select({ count: count() })
    .from(teeBookingsTable)
    .where(and(
      sql`${teeBookingsTable.status} = 'confirmed'`,
      sql`${teeBookingsTable.createdAt} >= ${monthStart}`,
    ));

  const [bookingRevenueRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(total_amount), 0)` })
    .from(teeBookingsTable)
    .where(and(
      sql`${teeBookingsTable.status} = 'confirmed'`,
      sql`${teeBookingsTable.createdAt} >= ${monthStart}`,
      sql`${teeBookingsTable.totalAmount} IS NOT NULL`,
    ));

  // Bookings per club this month
  const bookingsByClub = await db
    .select({
      organizationId: teeBookingsTable.organizationId,
      orgName: organizationsTable.name,
      count: count(),
      revenue: sql<string>`COALESCE(SUM(${teeBookingsTable.totalAmount}::numeric), 0)::text`,
    })
    .from(teeBookingsTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, teeBookingsTable.organizationId))
    .where(and(
      sql`${teeBookingsTable.status} = 'confirmed'`,
      sql`${teeBookingsTable.createdAt} >= ${monthStart}`,
    ))
    .groupBy(teeBookingsTable.organizationId, organizationsTable.name)
    .orderBy(sql`count(*) DESC`)
    .limit(10);

  res.json({
    totalClubs: Number(totalClubs?.count ?? 0),
    activeClubs: Number(activeClubs?.count ?? 0),
    totalUsers: Number(totalUsers?.count ?? 0),
    totalTournaments: Number(totalTournaments?.count ?? 0),
    activeTournaments: Number(activeTournaments?.count ?? 0),
    tierBreakdown: tierCounts,
    estimatedMrr: mrr,
    bookingsThisMonth: Number(bookingsThisMonth?.count ?? 0),
    bookingRevenueThisMonth: parseFloat(bookingRevenueRow?.total ?? "0"),
    bookingsByClub,
  });
});

// GET /super-admin/clubs — paginated list with search and tier filter
router.get("/super-admin/clubs", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const { search, tier, status, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const offset = (pageNum - 1) * limitNum;

  // Build conditions array typed as SQL expressions
  const conditions: SQL[] = [];

  if (isSubscriptionTier(tier)) {
    conditions.push(eq(organizationsTable.subscriptionTier, tier));
  }
  if (status === "active") {
    conditions.push(eq(organizationsTable.isActive, true));
  } else if (status === "suspended") {
    conditions.push(eq(organizationsTable.isActive, false));
  }

  const searchCondition: SQL | undefined = search
    ? or(ilike(organizationsTable.name, `%${search}%`), ilike(organizationsTable.slug, `%${search}%`))
    : undefined;

  const whereClause: SQL | undefined =
    searchCondition && conditions.length > 0 ? and(searchCondition, ...conditions)
    : searchCondition ? searchCondition
    : conditions.length > 0 ? and(...conditions)
    : undefined;

  const orgs = await db
    .select({
      id: organizationsTable.id,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      logoUrl: organizationsTable.logoUrl,
      primaryColor: organizationsTable.primaryColor,
      subscriptionTier: organizationsTable.subscriptionTier,
      subscriptionStatus: organizationsTable.subscriptionStatus,
      isActive: organizationsTable.isActive,
      contactEmail: organizationsTable.contactEmail,
      createdAt: organizationsTable.createdAt,
    })
    .from(organizationsTable)
    .where(whereClause)
    .orderBy(organizationsTable.createdAt)
    .limit(limitNum)
    .offset(offset);

  const results = await Promise.all(
    orgs.map(async (org) => {
      const [memberCount] = await db
        .select({ count: count() })
        .from(orgMembershipsTable)
        .where(eq(orgMembershipsTable.organizationId, org.id));
      const [tournamentCount] = await db
        .select({ count: count() })
        .from(tournamentsTable)
        .where(eq(tournamentsTable.organizationId, org.id));
      const [activeTCount] = await db
        .select({ count: count() })
        .from(tournamentsTable)
        .where(and(eq(tournamentsTable.organizationId, org.id), sql`${tournamentsTable.status} = 'active'`));
      return {
        ...org,
        memberCount: Number(memberCount?.count ?? 0),
        tournamentCount: Number(tournamentCount?.count ?? 0),
        activeTournaments: Number(activeTCount?.count ?? 0),
      };
    }),
  );

  const [totalRow] = await db
    .select({ count: count() })
    .from(organizationsTable)
    .where(whereClause);

  res.json({
    clubs: results,
    total: Number(totalRow?.count ?? 0),
    page: pageNum,
    limit: limitNum,
  });
});

// GET /super-admin/clubs/:orgId — detailed view of one club
router.get("/super-admin/clubs/:orgId", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }

  const [memberCount] = await db.select({ count: count() }).from(orgMembershipsTable).where(eq(orgMembershipsTable.organizationId, orgId));
  const [tournamentCount] = await db.select({ count: count() }).from(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId));
  const [activeTCount] = await db
    .select({ count: count() })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.organizationId, orgId), sql`${tournamentsTable.status} = 'active'`));
  const [leagueCount] = await db.select({ count: count() }).from(leaguesTable).where(eq(leaguesTable.organizationId, orgId));
  const [userCount] = await db.select({ count: count() }).from(appUsersTable).where(eq(appUsersTable.organizationId, orgId));

  const configs = await getAllTierConfigs();
  const tierLimits = configs[org.subscriptionTier as SubscriptionTier];
  const tierDisplay = getTierDisplay(org.subscriptionTier);

  res.json({
    ...org,
    memberCount: Number(memberCount?.count ?? 0),
    tournamentCount: Number(tournamentCount?.count ?? 0),
    activeTournaments: Number(activeTCount?.count ?? 0),
    leagueCount: Number(leagueCount?.count ?? 0),
    userCount: Number(userCount?.count ?? 0),
    tierLimits,
    tierDisplay,
  });
});

// POST /super-admin/clubs — create a club directly (enterprise onboarding)
router.post("/super-admin/clubs", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const { name, slug, description, logoUrl, primaryColor, contactEmail, contactPhone, address, website, subscriptionTier } = req.body;

  if (!name || !slug) {
    res.status(400).json({ error: "name and slug are required" });
    return;
  }

  if (subscriptionTier != null && !isSubscriptionTier(subscriptionTier)) {
    res.status(400).json({ error: `Invalid subscription tier. Must be one of: ${SUBSCRIPTION_TIERS.join(", ")}` });
    return;
  }

  const safeSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const tier: SubscriptionTier = isSubscriptionTier(subscriptionTier) ? subscriptionTier : "free";

  try {
    const [org] = await db
      .insert(organizationsTable)
      .values({
        name,
        slug: safeSlug,
        description,
        logoUrl,
        primaryColor: primaryColor ?? "#1e4d2b",
        contactEmail,
        contactPhone,
        address,
        website,
        subscriptionTier: tier,
        // Super admin creates clubs already activated
        subscriptionStatus: tier === "free" ? "free" : "active",
        isActive: true,
      })
      .returning();
    res.status(201).json(org);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique")) {
      res.status(409).json({ error: "A club with this slug already exists." });
    } else {
      res.status(500).json({ error: "Failed to create club." });
    }
  }
});

// PATCH /super-admin/clubs/:orgId/tier — change a club's subscription tier
router.patch("/super-admin/clubs/:orgId/tier", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const { subscriptionTier } = req.body;
  if (!isSubscriptionTier(subscriptionTier)) {
    res.status(400).json({ error: `Invalid subscription tier. Must be one of: ${SUBSCRIPTION_TIERS.join(", ")}` });
    return;
  }

  const [org] = await db
    .update(organizationsTable)
    .set({
      subscriptionTier,
      subscriptionStatus: subscriptionTier === "free" ? "free" : "active",
      updatedAt: new Date(),
    })
    .where(eq(organizationsTable.id, orgId))
    .returning();

  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }
  res.json({ ok: true, org });
});

// POST /super-admin/clubs/:orgId/re-migrate — Task #1308.
// Manually re-run the plan migration for a club (e.g. force-reset a club whose
// tier has drifted, or re-apply a tier after a corrected legacy slug mapping).
//
// Why a dedicated endpoint instead of `PATCH /clubs/:orgId/tier`?
//   - PATCH /tier is for ad-hoc tier edits (sales upgrades, internal demos)
//     and intentionally does NOT raise a Plan Migration audit row.
//   - This endpoint is the admin-facing equivalent of the legacy SQL
//     migration (Task #514) and the Stripe-webhook auto-downgrade
//     (Task #1133): it persists the tier change AND fans out the realtime
//     email + push to every super admin via
//     `notifySuperAdminsOfPlanMigration()`. That keeps every writer of
//     `entity = 'organization_subscription_tier'` / `action = 'migrate'`
//     rows on the same alert path so super admins never have to wait for
//     the hourly digest cron tick (Task #1308).
router.post("/super-admin/clubs/:orgId/re-migrate", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const { targetTier, reason } = req.body as { targetTier?: unknown; reason?: unknown };
  if (!isSubscriptionTier(targetTier)) {
    res.status(400).json({ error: `Invalid targetTier. Must be one of: ${SUBSCRIPTION_TIERS.join(", ")}` });
    return;
  }

  const [org] = await db
    .select({
      id: organizationsTable.id,
      subscriptionTier: organizationsTable.subscriptionTier,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));

  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }

  const fromTier = org.subscriptionTier as string | null;

  // Persist the tier change FIRST so the audit row written by the helper
  // reflects the settled state. Mirrors the order used by the Stripe
  // webhook auto-downgrade path in routes/webhooks.ts.
  await db
    .update(organizationsTable)
    .set({
      subscriptionTier: targetTier,
      subscriptionStatus: targetTier === "free" ? "free" : "active",
      pendingSubscriptionTier: null,
      updatedAt: new Date(),
    })
    .where(eq(organizationsTable.id, orgId));

  const trimmedReason = typeof reason === "string" && reason.trim().length > 0
    ? reason.trim()
    : "Manual plan re-migration by super admin";

  // The helper records the audit row AND fires the realtime email + push.
  // We deliberately do NOT write the audit row ourselves — Task #1308
  // requires every admin-triggered re-migration to flow through this helper
  // so super admins always get the same alert experience.
  const result = await notifySuperAdminsOfPlanMigration({
    organizationId: orgId,
    fromTier,
    toTier: targetTier,
    reason: trimmedReason,
    // Task #1906 — admin-triggered re-runs surface as "Manual" in the
    // panel chip and use a calmer email subject + push title than the
    // unknown-tier auto-reset path, since they aren't a slug-mapping
    // bug worth investigating.
    triggerReason: "manual",
    req,
  });

  res.json({
    ok: true,
    organizationId: orgId,
    fromTier,
    toTier: targetTier,
    auditRecorded: result.auditRecorded,
    recipientsAttempted: result.recipientsAttempted,
    recipientsEmailed: result.recipientsEmailed,
    pushAttempted: result.pushAttempted,
    pushSent: result.pushSent,
  });
});

// PATCH /super-admin/clubs/:orgId/suspend — suspend or unsuspend a club
router.patch("/super-admin/clubs/:orgId/suspend", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const { suspend } = req.body as { suspend: boolean };
  if (typeof suspend !== "boolean") {
    res.status(400).json({ error: "'suspend' must be a boolean" });
    return;
  }

  const [org] = await db
    .update(organizationsTable)
    .set({ isActive: !suspend, updatedAt: new Date() })
    .where(eq(organizationsTable.id, orgId))
    .returning();

  if (!org) { { res.status(404).json({ error: "Club not found" }); return; } }
  res.json({ ok: true, isActive: org.isActive });
});

// GET /super-admin/tiers — return tier definitions with limits and prices (legacy compat)
router.get("/super-admin/tiers", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const configs = await getAllTierConfigs();
  const tiers = (Object.keys(TIER_DISPLAY) as SubscriptionTier[]).map((tier) => ({
    tier,
    ...TIER_DISPLAY[tier],
    priceMonthly: configs[tier].priceMonthly,
    limits: configs[tier],
  }));
  res.json(tiers);
});

// GET /super-admin/plans — all 4 plan configs from DB
router.get("/super-admin/plans", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const configs = await getAllTierConfigs();
  const plans = (["free", "starter", "pro", "enterprise"] as SubscriptionTier[]).map((tier) => ({
    ...configs[tier],
    tier,
    label: TIER_DISPLAY[tier].label,
    currency: TIER_DISPLAY[tier].currency,
    description: TIER_DISPLAY[tier].description,
  }));
  res.json(plans);
});

// PATCH /super-admin/plans/:tier — update a plan config
router.patch("/super-admin/plans/:tier", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const { tier } = (req.params as Record<string, string>);
  const validTiers: SubscriptionTier[] = ["free", "starter", "pro", "enterprise"];
  if (!validTiers.includes(tier as SubscriptionTier)) {
    res.status(400).json({ error: "Invalid tier" });
    return;
  }

  const {
    priceMonthly, maxActiveTournaments, maxMembers, maxLeagues,
    sponsorLogos, advancedAnalytics, prioritySupport, mobileApp,
    marketplace, aiRulesAssistant, whsScoring, duesBilling,
    shopLockerAccess, whiteLabel, customDomain,
  } = req.body;

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  if (priceMonthly !== undefined) updateData.priceMonthly = Number(priceMonthly);
  if (maxActiveTournaments !== undefined) updateData.maxActiveTournaments = maxActiveTournaments === null ? null : Number(maxActiveTournaments);
  if (maxMembers !== undefined) updateData.maxMembers = maxMembers === null ? null : Number(maxMembers);
  if (maxLeagues !== undefined) updateData.maxLeagues = maxLeagues === null ? null : Number(maxLeagues);
  if (sponsorLogos !== undefined) updateData.sponsorLogos = Boolean(sponsorLogos);
  if (advancedAnalytics !== undefined) updateData.advancedAnalytics = Boolean(advancedAnalytics);
  if (prioritySupport !== undefined) updateData.prioritySupport = Boolean(prioritySupport);
  if (mobileApp !== undefined) updateData.mobileApp = Boolean(mobileApp);
  if (marketplace !== undefined) updateData.marketplace = Boolean(marketplace);
  if (aiRulesAssistant !== undefined) updateData.aiRulesAssistant = Boolean(aiRulesAssistant);
  if (whsScoring !== undefined) updateData.whsScoring = Boolean(whsScoring);
  if (duesBilling !== undefined) updateData.duesBilling = Boolean(duesBilling);
  if (shopLockerAccess !== undefined) updateData.shopLockerAccess = Boolean(shopLockerAccess);
  if (whiteLabel !== undefined) updateData.whiteLabel = Boolean(whiteLabel);
  if (customDomain !== undefined) updateData.customDomain = Boolean(customDomain);

  try {
    // Fetch existing config to use as baseline for partial updates — prevents corrupting
    // boolean defaults on first edit when the seed row may already exist
    const [existingConfig] = await db
      .select()
      .from(subscriptionPlanConfigsTable)
      .where(eq(subscriptionPlanConfigsTable.tier, tier as SubscriptionTier));

    // Baseline: existing DB row OR canonical hardcoded default (HARDCODED_FALLBACK).
    // Using HARDCODED_FALLBACK ensures partial first-time edits (e.g. price-only update)
    // don't accidentally zero-out boolean features like free.mobileApp.
    const hd = getHardcodedDefault(tier as SubscriptionTier);
    const baseline = {
      priceMonthly: existingConfig?.priceMonthly ?? hd.priceMonthly,
      maxActiveTournaments: existingConfig?.maxActiveTournaments !== undefined ? existingConfig.maxActiveTournaments : hd.maxActiveTournaments,
      maxMembers: existingConfig?.maxMembers !== undefined ? existingConfig.maxMembers : hd.maxMembers,
      maxLeagues: existingConfig?.maxLeagues !== undefined ? existingConfig.maxLeagues : hd.maxLeagues,
      sponsorLogos: existingConfig?.sponsorLogos ?? hd.sponsorLogos,
      advancedAnalytics: existingConfig?.advancedAnalytics ?? hd.advancedAnalytics,
      prioritySupport: existingConfig?.prioritySupport ?? hd.prioritySupport,
      mobileApp: existingConfig?.mobileApp ?? hd.mobileApp,
      marketplace: existingConfig?.marketplace ?? hd.marketplace,
      aiRulesAssistant: existingConfig?.aiRulesAssistant ?? hd.aiRulesAssistant,
      whsScoring: existingConfig?.whsScoring ?? hd.whsScoring,
      duesBilling: existingConfig?.duesBilling ?? hd.duesBilling,
      shopLockerAccess: existingConfig?.shopLockerAccess ?? hd.shopLockerAccess,
      whiteLabel: existingConfig?.whiteLabel ?? hd.whiteLabel,
      customDomain: existingConfig?.customDomain ?? hd.customDomain,
    };

    const insertValues = { ...baseline, tier: tier as SubscriptionTier, ...updateData };

    await db
      .insert(subscriptionPlanConfigsTable)
      .values(insertValues)
      .onConflictDoUpdate({ target: subscriptionPlanConfigsTable.tier, set: updateData });

    invalidatePlanConfigCache();
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Legacy plan slug mappings (Task #1131) — editable mapping consulted by the
// Plan Migration audit panel to suggest a restore tier for non-standard slugs.
// ──────────────────────────────────────────────────────────────────────────

// GET /super-admin/legacy-slug-mappings — list every mapping
router.get("/super-admin/legacy-slug-mappings", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const mappings = await listLegacySlugMappings();
    res.json({ mappings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[legacy-slug-mappings] list failed");
    res.status(500).json({ error: msg });
  }
});

// PUT /super-admin/legacy-slug-mappings/:slug — create or update a mapping
router.put("/super-admin/legacy-slug-mappings/:slug", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const { tier, notes } = req.body ?? {};
  const user = req.user as { id?: number } | undefined;
  try {
    const result = await upsertLegacySlugMapping({
      slug: (req.params as Record<string, string>).slug,
      tier,
      notes: typeof notes === "string" ? notes : null,
      userId: user?.id ?? null,
    });
    if (!result.ok) {
      const map: Record<string, { status: number; error: string }> = {
        invalid_slug: { status: 400, error: "A slug is required." },
        invalid_tier: { status: 400, error: "Tier must be one of free, starter, pro, enterprise." },
        reserved_slug: { status: 400, error: "Slug is already a recognised tier — no mapping needed." },
      };
      const { status, error } = map[result.error.kind] ?? { status: 400, error: "Invalid input." };
      res.status(status).json({ error });
      return;
    }
    res.json({ mapping: result.mapping });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[legacy-slug-mappings] upsert failed");
    res.status(500).json({ error: msg });
  }
});

// DELETE /super-admin/legacy-slug-mappings/:slug — remove a mapping
router.delete("/super-admin/legacy-slug-mappings/:slug", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const removed = await deleteLegacySlugMapping((req.params as Record<string, string>).slug);
    if (!removed) {
      res.status(404).json({ error: "Mapping not found." });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[legacy-slug-mappings] delete failed");
    res.status(500).json({ error: msg });
  }
});

// GET /super-admin/ops-alert-settings — Task #1305.
// Return the resolved threshold + lookback window for the
// retry-exhaustion ops alert, plus enough provenance for the UI to
// show "currently inheriting from env" vs "DB override".
router.get("/super-admin/ops-alert-settings", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const config = await resolveOpsAlertConfig();
    // Task #2057 — also surface whether the notify-retry exhaustion
    // alert's Slack / PagerDuty channels are wired, so the Ops Alert
    // card can render the same configured/unconfigured badges + "Send
    // test page" button as the watch-GPS panel. Sanitized status only
    // (booleans), never the webhook URL or routing key.
    const chatTargets = getNotifyRetryExhaustionOpsAlertChatTargetsStatus();
    res.json({ config, chatTargets });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[ops-alert-settings] read failed");
    res.status(500).json({ error: msg });
  }
});

// GET /super-admin/ops-alert-settings/history — Task #1546 + #1924.
// Return audit entries (newest first) for the ops alert tunables.
//
// Task #1924 — what used to be a hardcoded 10-row response is now
// paginated + filterable so admins can page through the full table
// during a postmortem instead of being stuck on the most recent
// handful. Query params (all optional):
//   - limit:    page size (1..OPS_ALERT_HISTORY_MAX_LIMIT, default 10)
//   - offset:   number of rows to skip after filters apply (default 0)
//   - from:     inclusive lower bound on `changedAt` (ISO timestamp)
//   - to:       inclusive upper bound on `changedAt` (ISO timestamp)
//   - editorId: restrict to a specific app user id; pass `none` to
//               match the system / unattributed rows where
//               `changed_by_user_id` is NULL.
//
// Returns `{ entries, total, limit, offset }` so the UI can render an
// "X of Y" footer and disable Next on the last page.
router.get("/super-admin/ops-alert-settings/history", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const parseIntParam = (raw: unknown): number | null | "invalid" => {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return "invalid";
    return n;
  };
  const parseDateParam = (raw: unknown): Date | null | "invalid" => {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim();
    if (s === "") return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "invalid";
    return d;
  };

  const limitParsed = parseIntParam(req.query.limit);
  if (limitParsed === "invalid") {
    res.status(400).json({ error: "limit must be an integer." });
    return;
  }
  const offsetParsed = parseIntParam(req.query.offset);
  if (offsetParsed === "invalid") {
    res.status(400).json({ error: "offset must be an integer." });
    return;
  }
  if (typeof offsetParsed === "number" && offsetParsed < 0) {
    res.status(400).json({ error: "offset must be non-negative." });
    return;
  }
  const fromParsed = parseDateParam(req.query.from);
  if (fromParsed === "invalid") {
    res.status(400).json({ error: "from must be an ISO timestamp." });
    return;
  }
  const toParsed = parseDateParam(req.query.to);
  if (toParsed === "invalid") {
    res.status(400).json({ error: "to must be an ISO timestamp." });
    return;
  }
  if (fromParsed && toParsed && fromParsed.getTime() > toParsed.getTime()) {
    res.status(400).json({ error: "from must be on or before to." });
    return;
  }

  // editorId accepts a positive integer for "this user" or the
  // sentinel string "none" for "system / unattributed". Omit to skip.
  let editorUserIdOpt: { editorUserId: number | null } | Record<string, never> = {};
  const editorRaw = req.query.editorId;
  if (editorRaw !== undefined && editorRaw !== null) {
    const s = String(editorRaw).trim();
    if (s !== "") {
      if (s === "none") {
        editorUserIdOpt = { editorUserId: null };
      } else {
        const n = Number(s);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
          res.status(400).json({ error: "editorId must be a positive integer or 'none'." });
          return;
        }
        editorUserIdOpt = { editorUserId: n };
      }
    }
  }

  const limit = limitParsed ?? 10;
  const offset = offsetParsed ?? 0;
  const clampedLimit = Math.max(1, Math.min(limit, OPS_ALERT_HISTORY_MAX_LIMIT));
  const filterOpts = {
    fromDate: fromParsed,
    toDate: toParsed,
    ...editorUserIdOpt,
  };

  try {
    const [entries, total] = await Promise.all([
      listOpsAlertSettingsHistory({
        limit: clampedLimit,
        offset,
        ...filterOpts,
      }),
      countOpsAlertSettingsHistory(filterOpts),
    ]);
    res.json({ entries, total, limit: clampedLimit, offset });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[ops-alert-settings-history] read failed");
    res.status(500).json({ error: msg });
  }
});

// PATCH /super-admin/ops-alert-settings — Task #1305.
// Partial-update the singleton settings row. For each tunable:
//   - Pass a positive integer to set an override.
//   - Pass `null` to clear the override (cron falls back to env / default).
//   - Omit the field to leave the existing stored value untouched.
router.patch("/super-admin/ops-alert-settings", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const user = req.user as { id?: number } | undefined;
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Coerce empty strings to null so the UI can clear a field by emptying
  // the input — express.json gives us strings when the form submits
  // controlled inputs, and we don't want a silent "0" coercion.
  const coerce = (key: string): number | null | undefined => {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return undefined;
    const raw = body[key];
    if (raw === null) return null;
    if (typeof raw === "string" && raw.trim() === "") return null;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string") {
      const n = Number(raw);
      return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
  };

  // Task #1664 — coerce all six tunable fields. The original two
  // (retry-exhaustion threshold + window hours) plus the four
  // manual-entry alert health knobs share one PATCH endpoint because
  // the super-admin UI surfaces them in one card.
  const threshold = coerce("notifyExhaustionThreshold");
  const windowHours = coerce("notifyExhaustionWindowHours");
  const meRate = coerce("manualEntryRateThresholdPct");
  const meMinSample = coerce("manualEntryMinSample");
  const meConsecZero = coerce("manualEntryConsecutiveZero");
  const meCooldown = coerce("manualEntryCooldownHours");
  // Task #2081 — three additional manual-entry tunables. Lookback
  // hours + recipient lookup limit reuse the same numeric `coerce`
  // helper above; dry-run is a boolean so it has its own block below.
  const meLookback = coerce("manualEntryLookbackHours");
  const meRecipientLookupLimit = coerce("manualEntryRecipientLookupLimit");

  const numericFields: Array<{ name: string; value: number | null | undefined }> = [
    { name: "notifyExhaustionThreshold", value: threshold },
    { name: "notifyExhaustionWindowHours", value: windowHours },
    { name: "manualEntryRateThresholdPct", value: meRate },
    { name: "manualEntryMinSample", value: meMinSample },
    { name: "manualEntryConsecutiveZero", value: meConsecZero },
    { name: "manualEntryCooldownHours", value: meCooldown },
    { name: "manualEntryLookbackHours", value: meLookback },
    { name: "manualEntryRecipientLookupLimit", value: meRecipientLookupLimit },
  ];
  for (const f of numericFields) {
    if (f.value !== undefined && f.value !== null && Number.isNaN(f.value)) {
      res.status(400).json({ error: `${f.name} must be a positive integer or null.` });
      return;
    }
  }

  // Task #2081 — coerce the dry-run boolean. Accepts `true` / `false`
  // / `null` / `"true"` / `"false"` / `0` / `1` so a JSON form binding
  // and a controlled checkbox can both clear or set it. An empty
  // string clears the override (consistent with the numeric coerce
  // helper above).
  let meDryRun: boolean | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "manualEntryDryRun")) {
    const raw = body.manualEntryDryRun;
    if (raw === null) {
      meDryRun = null;
    } else if (typeof raw === "boolean") {
      meDryRun = raw;
    } else if (typeof raw === "string") {
      const v = raw.trim().toLowerCase();
      if (v === "") meDryRun = null;
      else if (v === "true" || v === "1" || v === "yes" || v === "on") meDryRun = true;
      else if (v === "false" || v === "0" || v === "no" || v === "off") meDryRun = false;
      else {
        res.status(400).json({ error: "manualEntryDryRun must be a boolean or null." });
        return;
      }
    } else if (typeof raw === "number") {
      if (raw === 0) meDryRun = false;
      else if (raw === 1) meDryRun = true;
      else {
        res.status(400).json({ error: "manualEntryDryRun must be a boolean or null." });
        return;
      }
    } else {
      res.status(400).json({ error: "manualEntryDryRun must be a boolean or null." });
      return;
    }
  }

  // Task #1910 — coerce the recipients override. The UI sends:
  //   - an array of strings to set the override (we lowercase / dedupe in the lib),
  //   - `null` to clear the override (cron falls back to env),
  //   - the field omitted entirely to leave the existing override untouched.
  // Strings are also accepted (comma/newline separated) so a future
  // textarea-style form binding doesn't have to JSON-encode client side.
  let recipientsField: string[] | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, "notifyExhaustionRecipients")) {
    const raw = body.notifyExhaustionRecipients;
    if (raw === null) {
      recipientsField = null;
    } else if (Array.isArray(raw)) {
      recipientsField = raw.map((s) => (typeof s === "string" ? s : ""));
    } else if (typeof raw === "string") {
      recipientsField = raw.split(/[,\n]/);
    } else {
      res.status(400).json({ error: "notifyExhaustionRecipients must be an array of email addresses or null." });
      return;
    }
  }

  try {
    const result = await updateOpsAlertSettings({
      ...(threshold !== undefined ? { notifyExhaustionThreshold: threshold } : {}),
      ...(windowHours !== undefined ? { notifyExhaustionWindowHours: windowHours } : {}),
      ...(meRate !== undefined ? { manualEntryRateThresholdPct: meRate } : {}),
      ...(meMinSample !== undefined ? { manualEntryMinSample: meMinSample } : {}),
      ...(meConsecZero !== undefined ? { manualEntryConsecutiveZero: meConsecZero } : {}),
      ...(meCooldown !== undefined ? { manualEntryCooldownHours: meCooldown } : {}),
      ...(meLookback !== undefined ? { manualEntryLookbackHours: meLookback } : {}),
      ...(meDryRun !== undefined ? { manualEntryDryRun: meDryRun } : {}),
      ...(meRecipientLookupLimit !== undefined ? { manualEntryRecipientLookupLimit: meRecipientLookupLimit } : {}),
      ...(recipientsField !== undefined ? { notifyExhaustionRecipients: recipientsField } : {}),
      userId: user?.id ?? null,
    });
    if (!result.ok) {
      const map: Record<string, string> = {
        invalid_threshold: "Threshold must be a positive integer.",
        invalid_window_hours: "Window hours must be a positive integer.",
        invalid_manual_entry_rate_threshold_pct: "Manual-entry rate threshold must be an integer between 1 and 100.",
        invalid_manual_entry_min_sample: "Manual-entry min sample must be a positive integer.",
        invalid_manual_entry_consecutive_zero: "Manual-entry consecutive-zero count must be a positive integer.",
        invalid_manual_entry_cooldown_hours: "Manual-entry cooldown hours must be a positive integer.",
        // Task #2081
        invalid_manual_entry_lookback_hours: "Manual-entry lookback hours must be a positive integer.",
        invalid_manual_entry_dry_run: "Manual-entry dry-run must be true, false, or null.",
        invalid_manual_entry_recipient_lookup_limit: "Manual-entry recipient lookup limit must be a positive integer.",
        invalid_notify_exhaustion_recipients: "Recipient list must contain valid email addresses (max 50).",
      };
      res.status(400).json({ error: map[result.error.kind] ?? "Invalid input." });
      return;
    }
    res.json({ config: result.config });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[ops-alert-settings] update failed");
    res.status(500).json({ error: msg });
  }
});

// POST /super-admin/ops-alert-settings/test — Task #1547.
// Manual delivery check for the retry-exhaustion ops alert. Sends a
// clearly-labelled "TEST" email to every recipient in OPS_ALERT_EMAILS
// using a synthetic summary (no DB scan, no threshold check) so admins
// can confirm the configured recipients receive ops alerts before
// relying on a tuned threshold. Crucially the test send does NOT
// consume the daily dedup stamp — a real exhaustion later today will
// still alert.
//
// Task #1917 — when the request body includes a non-empty
// `overrideRecipient` email, the test email is delivered ONLY to that
// address (still flagged isTest=true) and chat dispatch is skipped, so
// an admin can preview the email on their own inbox without paging the
// live OPS_ALERT_EMAILS recipients or the on-call Slack / PagerDuty
// channels.
//
// Mirrors the loose RFC-5322-ish shape used elsewhere — strict enough to
// reject obvious typos ("not-an-email", missing TLD) without rejecting
// legitimate addresses; SMTP delivery itself remains the source of
// truth for whether the address is actually reachable.
const OVERRIDE_RECIPIENT_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post("/super-admin/ops-alert-settings/test", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const user = req.user as { id?: number } | undefined;

  // Parse + validate the optional override recipient. We tolerate a
  // missing body (existing callers send no payload) and treat blank
  // strings as "no override" so the UI can always send the field
  // through without ceremony.
  const body = (req.body ?? {}) as { overrideRecipient?: unknown };
  let overrideRecipient: string | null = null;
  if (body.overrideRecipient !== undefined && body.overrideRecipient !== null) {
    if (typeof body.overrideRecipient !== "string") {
      res.status(400).json({
        error: "overrideRecipient must be a string.",
        reason: "invalid_override_recipient",
      });
      return;
    }
    const trimmed = body.overrideRecipient.trim();
    if (trimmed !== "") {
      if (!OVERRIDE_RECIPIENT_REGEX.test(trimmed)) {
        res.status(400).json({
          error: "Override recipient is not a valid email address.",
          reason: "invalid_override_recipient",
        });
        return;
      }
      overrideRecipient = trimmed;
    }
  }

  try {
    const result = await runNotifyExhaustionOpsAlertJob({
      isTest: true,
      ...(overrideRecipient ? { overrideRecipient } : {}),
    });
    if (result.reason === "no_recipients") {
      res.status(400).json({
        error: "OPS_ALERT_EMAILS is unset or empty — no test recipients are configured.",
        reason: "no_recipients",
      });
      return;
    }
    if (!result.alerted) {
      res.status(502).json({
        error: "Test email could not be sent. Check the API server logs and the email provider configuration.",
        recipients: result.recipients,
      });
      return;
    }
    logger.info(
      {
        recipients: result.recipients,
        userId: user?.id ?? null,
        overrideRecipient: overrideRecipient ?? undefined,
      },
      "[ops-alert-settings] test alert sent",
    );

    // Task #1916 — stamp the singleton row so the super-admin Ops Alert
    // card can render "Last test sent <relative time> ago to N
    // recipient(s)" and stop encouraging duplicate test sends. The
    // stamp is best-effort: a transient DB blip here must not mask the
    // successful test delivery from the admin who just clicked Send.
    try {
      await recordOpsAlertTestSent({
        recipientCount: result.recipients,
        userId: user?.id ?? null,
      });
    } catch (stampErr) {
      logger.warn(
        { err: stampErr, recipients: result.recipients, userId: user?.id ?? null },
        "[ops-alert-settings] failed to stamp last-test-sent metadata; test email itself succeeded",
      );
    }

    res.json({
      ok: true,
      recipients: result.recipients,
      ...(overrideRecipient ? { overrideRecipient } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[ops-alert-settings] test send failed");
    res.status(500).json({ error: msg });
  }
});

// GET /super-admin/ops-alert-settings/chat-targets — Task #2055.
// Sanitised view of which Slack / PagerDuty chat-channels are wired up
// for the ops-alert flows that the super-admin Ops Alert card cares
// about (the notification-retry exhaustion alert, plus the watch GPS
// spike alert for completeness — same shared-fallback shape, same
// "configured before pressing test" question). The response is shaped
// so the UI can render a "Slack ✓ (shared) / PagerDuty ✗" badge next
// to the email recipient list, making it obvious BEFORE pressing
// "Send test alert" whether chat will fire.
//
// Secret values themselves are never returned — only:
//   - status: "configured" | "missing" per channel
//   - source: "dedicated" | "shared" | null per channel (which env
//     variable resolved it; null when the channel is missing)
//   - dedicatedEnvVar / sharedEnvVar names so the UI can name the
//     exact env var an admin needs to set when a channel is missing
router.get("/super-admin/ops-alert-settings/chat-targets", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    res.json({
      flows: {
        notifyRetryExhaustion: getNotifyRetryExhaustionChatTargetsStatus(),
        watchGps: resolveOpsAlertChatTargetsStatus({
          slackEnvVar: "OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK",
          pagerDutyEnvVar: "OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY",
        }),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "[ops-alert-settings-chat-targets] read failed");
    res.status(500).json({ error: msg });
  }
});

// GET /super-admin/clubs/:orgId/overrides — get per-club overrides
router.get("/super-admin/clubs/:orgId/overrides", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const [override] = await db
    .select()
    .from(orgPlanOverridesTable)
    .where(eq(orgPlanOverridesTable.organizationId, orgId));

  const configs = await getAllTierConfigs();
  const [org] = await db.select({ subscriptionTier: organizationsTable.subscriptionTier }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
  const tierConfig = org ? configs[org.subscriptionTier as SubscriptionTier] : null;

  res.json({
    override: override ?? null,
    tierDefaults: tierConfig,
  });
});

// PATCH /super-admin/clubs/:orgId/overrides — partial-update per-club overrides
// Only fields explicitly present in request body are changed; omitted fields retain their current DB value.
router.patch("/super-admin/clubs/:orgId/overrides", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const user = req.user as { id?: number };
  const setByUserId = user?.id ?? null;

  const { clearAll } = req.body;

  if (clearAll) {
    await db.delete(orgPlanOverridesTable).where(eq(orgPlanOverridesTable.organizationId, orgId));
    res.json({ ok: true, cleared: true });
    return;
  }

  // Fetch existing override to enable true partial update (omitted fields are NOT cleared)
  const [existing] = await db
    .select()
    .from(orgPlanOverridesTable)
    .where(eq(orgPlanOverridesTable.organizationId, orgId));

  const body = req.body as Record<string, unknown>;

  // Helper: pick from body if present, otherwise keep existing value, else null
  const pick = <K extends string>(key: K, existing: Record<string, unknown> | undefined) =>
    key in body ? body[key] : (existing?.[key] ?? null);

  const pickNum = (key: string, existingRow: Record<string, unknown> | undefined) => {
    const v = pick(key, existingRow);
    return v === null || v === undefined ? null : Number(v);
  };

  const ex = existing as Record<string, unknown> | undefined;

  const values = {
    organizationId: orgId,
    overrideMaxTournaments: pickNum("overrideMaxTournaments", ex),
    overrideMaxMembers: pickNum("overrideMaxMembers", ex),
    overrideMaxLeagues: pickNum("overrideMaxLeagues", ex),
    overrideSponsorLogos: pick("overrideSponsorLogos", ex) as boolean | null,
    overrideAdvancedAnalytics: pick("overrideAdvancedAnalytics", ex) as boolean | null,
    overridePrioritySupport: pick("overridePrioritySupport", ex) as boolean | null,
    overrideMobileApp: pick("overrideMobileApp", ex) as boolean | null,
    overrideMarketplace: pick("overrideMarketplace", ex) as boolean | null,
    overrideAiRulesAssistant: pick("overrideAiRulesAssistant", ex) as boolean | null,
    overrideWhsScoring: pick("overrideWhsScoring", ex) as boolean | null,
    overrideDuesBilling: pick("overrideDuesBilling", ex) as boolean | null,
    overrideShopLockerAccess: pick("overrideShopLockerAccess", ex) as boolean | null,
    overrideWhiteLabel: pick("overrideWhiteLabel", ex) as boolean | null,
    overrideCustomDomain: pick("overrideCustomDomain", ex) as boolean | null,
    overrideReason: pick("overrideReason", ex) as string | null,
    overrideSetByUserId: setByUserId,
    overrideExpiresAt: (() => {
      const raw = "overrideExpiresAt" in body ? body.overrideExpiresAt : ex?.overrideExpiresAt;
      return raw ? new Date(raw as string) : null;
    })(),
    updatedAt: new Date(),
  };

  const updateSet = { ...values } as Record<string, unknown>;
  delete updateSet.organizationId;

  await db
    .insert(orgPlanOverridesTable)
    .values(values)
    .onConflictDoUpdate({
      target: orgPlanOverridesTable.organizationId,
      set: updateSet,
    });

  res.json({ ok: true });
});

// GET /super-admin/plan-migration-audit — list rows from member_audit_log where
// the legacy-tier migration (Task #514) reset an org to Free. Use ?includeAcknowledged=1
// to also return rows the support team already reviewed. Task #1314 adds two
// optional filters for narrowing a long backlog:
//   ?acknowledgedByUserId=<int>   — only rows ack'd by that reviewer
//   ?acknowledgedVia=email|dashboard — only rows ack'd via that source
// Both reviewer/via filters imply the row is acknowledged, so they
// auto-include acknowledged rows even when includeAcknowledged is not set.
router.get("/super-admin/plan-migration-audit", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const {
    includeAcknowledged: includeAckRaw,
    page = "1",
    limit = "100",
    acknowledgedByUserId: ackByRaw,
    acknowledgedVia: ackViaRaw,
    sort: sortRaw,
  } = req.query as Record<string, string>;
  const includeAcknowledged = includeAckRaw === "1" || includeAckRaw === "true";
  const ackByUserId = ackByRaw && /^\d+$/.test(ackByRaw) ? parseInt(ackByRaw) : null;
  const ackVia: "email" | "dashboard" | null =
    ackViaRaw === "email" || ackViaRaw === "dashboard" ? ackViaRaw : null;
  // Task #1929 — sort the panel list by row age so the oldest stale rows
  // surface first and the colour ramp added by Task #1550 actually drives
  // triage order. Default is "oldest first" because that's the whole point
  // of the panel; "newest" is preserved as an opt-in for occasional
  // chronological scans. Anything unrecognised falls back to the default.
  const sort: "oldest" | "newest" = sortRaw === "newest" ? "newest" : "oldest";
  const pageNum = Math.max(1, parseInt(page) || 1);
  const limitNum = Math.min(500, Math.max(1, parseInt(limit) || 100));
  const offset = (pageNum - 1) * limitNum;

  const conditions: SQL[] = [
    eq(memberAuditLogTable.entity, "organization_subscription_tier"),
    eq(memberAuditLogTable.action, "migrate"),
  ];
  // Filtering by reviewer or via implies the row is acknowledged, so don't
  // double-exclude acknowledged rows in that case — otherwise the filters
  // would always return zero results unless "Show acknowledged" was on.
  const effectiveIncludeAck = includeAcknowledged || ackByUserId !== null || ackVia !== null;
  if (!effectiveIncludeAck) {
    // Tolerate both jsonb boolean true and the string 'true' so the filter is
    // resilient if older / hand-written rows store the flag in either shape.
    conditions.push(sql`(${memberAuditLogTable.metadata}->>'acknowledged') IS DISTINCT FROM 'true'`);
  }
  if (ackByUserId !== null) {
    conditions.push(
      sql`${memberAuditLogTable.metadata}->>'acknowledgedByUserId' ~ '^[0-9]+$'
          AND (${memberAuditLogTable.metadata}->>'acknowledgedByUserId')::int = ${ackByUserId}`,
    );
  }
  if (ackVia === "email") {
    conditions.push(sql`(${memberAuditLogTable.metadata}->>'acknowledgedVia') = 'email'`);
  } else if (ackVia === "dashboard") {
    // Dashboard = acknowledged AND not flagged as email. This matches the
    // frontend's derivation rule (which treats older rows that pre-date the
    // 'acknowledgedVia' field as having come from the dashboard).
    conditions.push(sql`(${memberAuditLogTable.metadata}->>'acknowledged') = 'true'`);
    conditions.push(sql`(${memberAuditLogTable.metadata}->>'acknowledgedVia') IS DISTINCT FROM 'email'`);
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select({
      id: memberAuditLogTable.id,
      organizationId: memberAuditLogTable.organizationId,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
      currentTier: organizationsTable.subscriptionTier,
      fieldChanges: memberAuditLogTable.fieldChanges,
      reason: memberAuditLogTable.reason,
      metadata: memberAuditLogTable.metadata,
      createdAt: memberAuditLogTable.createdAt,
      acknowledgedByDisplayName: appUsersTable.displayName,
      acknowledgedByUsername: appUsersTable.username,
      // Task #1550 — surface the persisted "first digest dispatch"
      // timestamp (Task #1313) so the Plan Migration Audit panel can
      // render the same "first surfaced X ago" age cue that the email
      // uses, closing the loop between inbox-triage and panel-triage.
      firstDigestedAt: sql<string | null>`${memberAuditLogTable.metadata}->>'firstDigestedAt'`,
    })
    .from(memberAuditLogTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, memberAuditLogTable.organizationId))
    .leftJoin(
      appUsersTable,
      // Guard the cast: only attempt int conversion when the metadata value
      // is a non-empty all-digit string. This protects against malformed
      // legacy rows where the field might somehow be a non-numeric string,
      // which would otherwise blow up the entire query.
      sql`${memberAuditLogTable.metadata}->>'acknowledgedByUserId' ~ '^[0-9]+$'
          AND ${appUsersTable.id} = (${memberAuditLogTable.metadata}->>'acknowledgedByUserId')::int`,
    )
    .where(whereClause)
    // Task #1929 — order by the same age signal the panel renders next to
    // each row: the persisted `firstDigestedAt` from Task #1313, falling
    // back to `createdAt` for rows that have never been digested. ASC
    // surfaces the oldest stale rows first so the grey → amber → red
    // colour ramp from Task #1550 actually drives triage order; DESC
    // is preserved as the legacy "newest first" view. We tiebreak by
    // `id ASC` so paginated cursors are deterministic when many rows
    // share a coalesced timestamp.
    .orderBy(
      sort === "oldest"
        ? sql`COALESCE(NULLIF(${memberAuditLogTable.metadata}->>'firstDigestedAt', '')::timestamptz, ${memberAuditLogTable.createdAt}) ASC`
        : sql`COALESCE(NULLIF(${memberAuditLogTable.metadata}->>'firstDigestedAt', '')::timestamptz, ${memberAuditLogTable.createdAt}) DESC`,
      sort === "oldest" ? asc(memberAuditLogTable.id) : desc(memberAuditLogTable.id),
    )
    .limit(limitNum)
    .offset(offset);

  const [totalRow] = await db
    .select({ count: count() })
    .from(memberAuditLogTable)
    .where(whereClause);

  // Reviewer aggregates (Task #1553). These intentionally ignore the current
  // reviewer/via/includeAcknowledged filters so the dropdown can always show
  // "Jane Doe — 27" style totals across every acknowledged plan-migration row.
  // Otherwise filtering by one reviewer would collapse the dropdown to a
  // single name with a misleading count.
  const reviewerStatRows = await db
    .select({
      userId: sql<number>`(${memberAuditLogTable.metadata}->>'acknowledgedByUserId')::int`,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      count: count(),
    })
    .from(memberAuditLogTable)
    .leftJoin(
      appUsersTable,
      sql`${memberAuditLogTable.metadata}->>'acknowledgedByUserId' ~ '^[0-9]+$'
          AND ${appUsersTable.id} = (${memberAuditLogTable.metadata}->>'acknowledgedByUserId')::int`,
    )
    .where(
      and(
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
        sql`(${memberAuditLogTable.metadata}->>'acknowledged') = 'true'`,
        sql`${memberAuditLogTable.metadata}->>'acknowledgedByUserId' ~ '^[0-9]+$'`,
      ),
    )
    .groupBy(
      sql`(${memberAuditLogTable.metadata}->>'acknowledgedByUserId')::int`,
      appUsersTable.displayName,
      appUsersTable.username,
    );

  const reviewerStats = reviewerStatRows
    .filter((r) => r.userId != null)
    .map((r) => ({
      userId: Number(r.userId),
      name: r.displayName ?? r.username ?? `User #${r.userId}`,
      count: Number(r.count ?? 0),
    }));

  const isAck = (raw: unknown) => raw === true || raw === "true";

  const entries = rows.map((row) => {
    const tier = (row.fieldChanges as { tier?: { from?: unknown; to?: unknown } } | null)?.tier;
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      organizationId: row.organizationId,
      orgName: row.orgName,
      orgSlug: row.orgSlug,
      currentTier: row.currentTier,
      fromTier: tier?.from ?? null,
      toTier: tier?.to ?? null,
      reason: row.reason,
      createdAt: row.createdAt,
      acknowledged: isAck(meta.acknowledged),
      acknowledgedAt: (meta.acknowledgedAt as string | undefined) ?? null,
      acknowledgedByUserId: (meta.acknowledgedByUserId as number | undefined) ?? null,
      acknowledgedByName: row.acknowledgedByDisplayName ?? row.acknowledgedByUsername ?? null,
      acknowledgedVia: meta.acknowledgedVia === "email" ? "email" : isAck(meta.acknowledged) ? "dashboard" : null,
      // Task #1550 — null until the row has been included in at least one
      // dispatched digest. The panel falls back to `createdAt` for display
      // when this is null so newly created rows still get an age cue.
      firstDigestedAt: row.firstDigestedAt ?? null,
      // Task #1906 — categorical trigger so the panel can chip rows as
      // "Cancellation" / "Unknown tier" / "Manual" instead of forcing
      // super admins to read the free-text `reason` field. Null for
      // legacy rows that pre-date the metadata field.
      triggerReason:
        meta.triggerReason === "cancelled" || meta.triggerReason === "unknown_tier" || meta.triggerReason === "manual"
          ? (meta.triggerReason as "cancelled" | "unknown_tier" | "manual")
          : null,
    };
  });

  res.json({
    entries,
    total: Number(totalRow?.count ?? 0),
    page: pageNum,
    limit: limitNum,
    reviewerStats,
  });
});

// GET /super-admin/plan-migration-audit/stale-summary — Task #1930. Lightweight
// counter used by the super-admin nav to render a "stale rows" badge on the
// "Plan Migrations" button so admins notice from any page that there are
// rows needing triage, without paying the cost of loading the full table.
//
// "Stale" mirrors the amber/red bucket of the panel's `planMigrationFirstSurfaced`
// helper (and the digest email's `renderFirstSurfacedLine`): unacknowledged rows
// where the effective surfaced timestamp — `metadata->>'firstDigestedAt'`
// falling back to `created_at` for rows that haven't been digested yet — is
// at least 24 hours old. Keeping the threshold computation server-side means
// the panel and the badge stay in sync even if a clock-skewed client renders
// the page.
router.get("/super-admin/plan-migration-audit/stale-summary", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const [row] = await db
    .select({ count: count() })
    .from(memberAuditLogTable)
    .where(
      and(
        eq(memberAuditLogTable.entity, "organization_subscription_tier"),
        eq(memberAuditLogTable.action, "migrate"),
        sql`(${memberAuditLogTable.metadata}->>'acknowledged') IS DISTINCT FROM 'true'`,
        // COALESCE the persisted "first digest dispatch" stamp (Task #1313)
        // with `created_at` so newly created rows still age into the badge
        // even before the first daily digest dispatches. The cast is guarded
        // by an ISO-8601-shaped regex (`YYYY-MM-DDTHH:MM:SS…`) so a
        // malformed `firstDigestedAt` value — e.g. an empty string or a
        // hand-edited row containing free text — cannot crash the count
        // query. Anything that does not look like an ISO timestamp is
        // treated as "no stamp" and falls back to created_at, matching the
        // frontend helper's behaviour. The mailer (`renderFirstSurfacedLine`)
        // and the panel API (`firstDigestedAt` ?? `createdAt`) only ever
        // write ISO 8601 strings here, so the regex is strict on purpose.
        sql`COALESCE(
          CASE
            WHEN ${memberAuditLogTable.metadata}->>'firstDigestedAt' ~ '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}'
            THEN (${memberAuditLogTable.metadata}->>'firstDigestedAt')::timestamptz
            ELSE NULL
          END,
          ${memberAuditLogTable.createdAt}
        ) <= NOW() - INTERVAL '24 hours'`,
      ),
    );

  res.json({ staleCount: Number(row?.count ?? 0) });
});

// POST /super-admin/plan-migration-audit/:id/acknowledge — mark a migration audit row reviewed.
router.post("/super-admin/plan-migration-audit/:id/acknowledge", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const id = parseInt(String((req.params as Record<string, string>).id));
  if (isNaN(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const user = req.user as { id?: number };
  const acknowledgedByUserId = user?.id ?? null;
  const acknowledgedAt = new Date().toISOString();

  const ackPatch = sql`jsonb_build_object(
    'acknowledged', true,
    'acknowledgedAt', ${acknowledgedAt}::text,
    'acknowledgedByUserId', ${acknowledgedByUserId}::int
  )`;

  const [row] = await db
    .update(memberAuditLogTable)
    .set({
      metadata: sql`COALESCE(${memberAuditLogTable.metadata}, '{}'::jsonb) || ${ackPatch}`,
    })
    .where(and(
      eq(memberAuditLogTable.id, id),
      eq(memberAuditLogTable.entity, "organization_subscription_tier"),
      eq(memberAuditLogTable.action, "migrate"),
    ))
    .returning({ id: memberAuditLogTable.id });

  if (!row) { { res.status(404).json({ error: "Audit row not found" }); return; } }
  res.json({ ok: true });
});

// GET /super-admin/plan-migration-audit/:id/acknowledge-via-email — Task #980.
// One-click acknowledge link embedded in the digest email (Task #835).
//
// Auth: NOT a logged-in route. Authentication comes from a short-lived HMAC
// token issued by `plan-migration-ack-token.ts` and bound to the recipient
// super admin's user id. Single-use is enforced by only stamping rows whose
// metadata.acknowledged is not already 'true'; subsequent clicks render an
// "already acknowledged" page instead of reusing the token.
router.get("/super-admin/plan-migration-audit/:id/acknowledge-via-email", async (req: Request, res: Response) => {
  const id = parseInt(String((req.params as Record<string, string>).id));
  const tokenRaw = typeof req.query.token === "string" ? req.query.token : "";
  if (isNaN(id) || !tokenRaw) {
    res.status(400).type("html").send(renderAckHtml({
      title: "Invalid link",
      heading: "Invalid acknowledgement link",
      body: "This link is missing required information. Please open the Plan Migration Audit panel directly.",
    }));
    return;
  }

  const payload = verifyPlanMigrationAckToken(tokenRaw);
  if (!payload || payload.auditId !== id) {
    res.status(401).type("html").send(renderAckHtml({
      title: "Link expired",
      heading: "This acknowledgement link has expired",
      body: "Signed acknowledge links expire after 7 days. Please open the Plan Migration Audit panel and acknowledge from there.",
    }));
    return;
  }

  // Confirm the token's userId still belongs to a super admin — protects
  // against a former staff member's leaked link being usable forever.
  const [actor] = await db
    .select({ id: appUsersTable.id, role: appUsersTable.role, displayName: appUsersTable.displayName })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, payload.userId));
  if (!actor || actor.role !== "super_admin") {
    res.status(403).type("html").send(renderAckHtml({
      title: "Not allowed",
      heading: "This account can no longer acknowledge migration alerts",
      body: "Only current super admins can acknowledge plan-migration alerts. Please ask an active super admin to triage this row.",
    }));
    return;
  }

  const acknowledgedAt = new Date().toISOString();
  const ackPatch = sql`jsonb_build_object(
    'acknowledged', true,
    'acknowledgedAt', ${acknowledgedAt}::text,
    'acknowledgedByUserId', ${payload.userId}::int,
    'acknowledgedVia', 'email'::text
  )`;

  // Single-use enforcement: only update rows that are still unacknowledged.
  // A reused / shared link finds no matching row and falls through to the
  // "already acknowledged" branch below.
  const updated = await db
    .update(memberAuditLogTable)
    .set({
      metadata: sql`COALESCE(${memberAuditLogTable.metadata}, '{}'::jsonb) || ${ackPatch}`,
    })
    .where(and(
      eq(memberAuditLogTable.id, id),
      eq(memberAuditLogTable.entity, "organization_subscription_tier"),
      eq(memberAuditLogTable.action, "migrate"),
      sql`(COALESCE(${memberAuditLogTable.metadata}, '{}'::jsonb)->>'acknowledged') IS DISTINCT FROM 'true'`,
    ))
    .returning({ id: memberAuditLogTable.id });

  if (updated.length > 0) {
    logger.info(
      { auditId: id, acknowledgedByUserId: payload.userId, via: "email" },
      "[plan-migration-audit] acknowledged via email link",
    );
    res.type("html").send(renderAckHtml({
      title: "Acknowledged",
      heading: "✓ Acknowledged",
      body: `Audit row #${id} is now marked as reviewed by ${actor.displayName ?? "you"}. You can close this tab.`,
      success: true,
    }));
    return;
  }

  // Either the row was already acknowledged, or it doesn't exist / isn't a
  // migration row. Try to disambiguate so the message is useful.
  const [existing] = await db
    .select({ id: memberAuditLogTable.id, metadata: memberAuditLogTable.metadata })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.id, id),
      eq(memberAuditLogTable.entity, "organization_subscription_tier"),
      eq(memberAuditLogTable.action, "migrate"),
    ));

  if (!existing) {
    res.status(404).type("html").send(renderAckHtml({
      title: "Not found",
      heading: "Audit row not found",
      body: "This migration audit row no longer exists.",
    }));
    return;
  }

  const meta = (existing.metadata ?? {}) as Record<string, unknown>;
  const ackAt = typeof meta.acknowledgedAt === "string" ? meta.acknowledgedAt : null;
  res.type("html").send(renderAckHtml({
    title: "Already acknowledged",
    heading: "Already acknowledged",
    body: ackAt
      ? `This row was already acknowledged on ${new Date(ackAt).toLocaleString("en")}. No action needed.`
      : "This row was already acknowledged. No action needed.",
    success: true,
  }));
});

function renderAckHtml(opts: { title: string; heading: string; body: string; success?: boolean }): string {
  const accent = opts.success ? "#4ade80" : "#f59e0b";
  const safe = (s: string) => s.replace(/[&<>"']/g, c => (
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  ));
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${safe(opts.title)} — KHARAGOLF</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;background:#0a0a0a;color:#fff;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;">
  <div style="max-width:480px;width:100%;background:#111;border:1px solid #1f2937;border-radius:12px;padding:32px;">
    <div style="font-size:11px;letter-spacing:3px;color:${accent};text-transform:uppercase;font-weight:700;margin-bottom:8px;">Plan Migration Audit</div>
    <h1 style="margin:0 0 12px;font-size:22px;color:${accent};">${safe(opts.heading)}</h1>
    <p style="margin:0;color:#9ca3af;line-height:1.6;">${safe(opts.body)}</p>
  </div>
</body></html>`;
}

// GET /super-admin/caddie-prompt-metrics — rolling AI Caddie prompt size/cost stats.
// Backed by the durable `caddie_prompt_metrics` table (Task #845); each
// /portal/caddie/ask call writes a row, aggregates are computed over rolling
// 24h / 7d / 30d windows, and rows older than 90 days are swept by cron.
router.get("/super-admin/caddie-prompt-metrics", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const recentLimit = Math.max(1, Math.min(200, Number(req.query.recent) || 20));
  res.json(await getCaddiePromptMetricsSummary(recentLimit));
});

// GET /super-admin/watch-position-metrics — per-minute volume of watch GPS
// `position` messages (Task #877). Lets ops confirm the drop introduced by
// the watch-side debounce (Task #722) and catch a regression if a future
// change re-floods the channel. Backed by the durable `watch_position_metrics`
// table; rows older than 90 days are swept by cron.
router.get("/super-admin/watch-position-metrics", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const recentLimit = Math.max(1, Math.min(200, Number(req.query.recent) || 20));
  res.json(await getWatchPositionMetricsSummary(recentLimit));
});

// GET /super-admin/watch-position-metrics/top-sessions — Task #1195.
// Drill-down for a single chart bucket: returns the top sessions whose
// minute-rows fell inside [bucketStart, bucketStart + bucketSeconds), ordered
// by total messages desc. Powers the click-to-investigate flow on the Watch
// GPS position rate chart.
router.get("/super-admin/watch-position-metrics/top-sessions", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  // Express may give us `string | string[]` for repeated keys — normalize to
  // the first scalar so a malicious caller can't send `?bucketStart=…&bucketStart=…`
  // and trip the unwrapping logic below.
  const firstScalar = (v: unknown): string | undefined => {
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0] as string;
    return undefined;
  };
  const bucketStart = firstScalar(req.query.bucketStart);
  const bucketSeconds = firstScalar(req.query.bucketSeconds);
  const limit = firstScalar(req.query.limit);
  const startMs = bucketStart ? Date.parse(bucketStart) : NaN;
  const seconds = Number(bucketSeconds);
  if (!Number.isFinite(startMs)) {
    res.status(400).json({ error: "bucketStart must be an ISO timestamp" });
    return;
  }
  if (!Number.isFinite(seconds) || seconds <= 0) {
    res.status(400).json({ error: "bucketSeconds must be a positive number" });
    return;
  }
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const endMs = startMs + seconds * 1000;
  const sessions = await getTopSessionsForBucket(startMs, endMs, safeLimit);
  res.json({
    bucketStart: new Date(startMs).toISOString(),
    bucketEnd: new Date(endMs).toISOString(),
    sessions,
  });
});

// GET /super-admin/watch-position-metrics/session/:sessionId — Task #1392.
// Raw position payloads (timestamp / lat / lon / accuracy / battery mode) the
// given watch session has emitted recently. Backed by the shared
// `watch_position_samples` table (see `recordWatchPositionSample` in
// `watchPositionMetrics.ts`) so ops can drill in on a misbehaving session
// and decide whether the watch is stuck in a tight loop, drifting, or being
// faked, without grepping logs.
//
// Task #1676 — the samples were originally an in-process per-replica ring
// buffer; ops only saw them when their dashboard request happened to land
// on the same replica the WS socket was pinned to. The shared table makes
// the panel work the same from any replica.
router.get("/super-admin/watch-position-metrics/session/:sessionId", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const sessionId = String((req.params as Record<string, string>).sessionId ?? "").trim();
  // Defence-in-depth: sessionIds are randomUUIDs (~36 chars). Reject obvious
  // junk so a curious caller can't spam the table with bogus session ids.
  if (sessionId.length === 0 || sessionId.length > 128) {
    res.status(400).json({ error: "sessionId is required (max 128 chars)" });
    return;
  }
  const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const limit = Math.max(1, Math.min(100, Number(limitRaw) || 50));
  res.json(await getRecentWatchPositionSamples(sessionId, limit));
});

// POST /super-admin/watch-position-metrics/sessions/:sessionId/mute — Task #1393.
// One-click "mute this watch session" from the chart drill-down: persists
// the session to `watch_session_mutes` (Task #1679) and adds it to this
// replica's in-process block list so further `position` WS messages from
// that session are dropped (and not counted in metrics) until the mute's
// TTL expires. Task #2090 / #2120 fan the mute out to every replica via
// each one's periodic `syncMutedSessionsFromDb` tick (≈5s), so the watch
// no longer has to drop and reconnect for the silence to take effect
// fleet-wide. The action is recorded in the audit table so we have a
// paper trail of who silenced which user/tournament/session.
router.post("/super-admin/watch-position-metrics/sessions/:sessionId/mute", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const sessionId = String((req.params as Record<string, string>).sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  // Optional caller-supplied TTL in seconds; clamped server-side to the
  // hard ceiling defined in watchPositionMetrics so a stray request can't
  // pin a session indefinitely. Falsy / non-finite falls back to the
  // helper's default.
  const rawTtl = (req.body as Record<string, unknown> | undefined)?.ttlSeconds;
  let ttlMs: number | undefined;
  if (rawTtl != null) {
    const n = Number(rawTtl);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: "ttlSeconds must be a positive number" });
      return;
    }
    ttlMs = Math.min(WATCH_SESSION_MUTE_MAX_TTL_MS, Math.floor(n * 1000));
  }

  // Look up the most recent metric row for this session so the audit row
  // captures who/what we just silenced (the in-memory accumulator is
  // per-replica, but the table is the cross-replica source of truth).
  const [latest] = await db
    .select({
      userId: watchPositionMetricsTable.userId,
      tournamentId: watchPositionMetricsTable.tournamentId,
    })
    .from(watchPositionMetricsTable)
    .where(eq(watchPositionMetricsTable.sessionId, sessionId))
    .orderBy(desc(watchPositionMetricsTable.bucketMinute))
    .limit(1);

  if (!latest) {
    // Without any history we can't anchor the audit row (the table
    // requires a non-null `organization_id`) and the session is most
    // likely already gone; surface a clear 404 instead of silently
    // muting a sessionId no replica is tracking.
    res.status(404).json({ error: "No metrics recorded for that sessionId" });
    return;
  }

  // Resolve the organization that owns this session for the audit row.
  // Prefer the tournament's org (the watch was scoring a specific event);
  // fall back to the user's home org if the session was tournament-less.
  let organizationId: number | null = null;
  if (latest.tournamentId != null) {
    const [t] = await db
      .select({ organizationId: tournamentsTable.organizationId })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, latest.tournamentId))
      .limit(1);
    if (t) organizationId = t.organizationId;
  }
  if (organizationId == null) {
    const [u] = await db
      .select({ organizationId: appUsersTable.organizationId })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, latest.userId))
      .limit(1);
    if (u?.organizationId != null) organizationId = u.organizationId;
  }
  if (organizationId == null) {
    // Audit table requires organization_id NOT NULL; without one we'd be
    // silently dropping the paper-trail half of the task. Refuse the
    // mute rather than leave it un-audited.
    res.status(409).json({
      error: "Cannot resolve an organization for this session; mute requires audit context.",
    });
    return;
  }

  const { expiresAt, ttlMs: appliedTtlMs } = await muteWatchSession(sessionId, ttlMs);

  // recordMemberAudit swallows its own errors so a transient audit
  // failure can't block the mute; the warn log inside the helper is
  // enough to flag the rare DB hiccup.
  await recordMemberAudit({
    req,
    organizationId,
    clubMemberId: null,
    entity: "watch_session",
    entityId: null,
    action: "mute",
    reason: "Super admin muted a runaway watch session from the dashboard",
    metadata: {
      sessionId,
      userId: latest.userId,
      tournamentId: latest.tournamentId,
      ttlMs: appliedTtlMs,
      expiresAt: expiresAt.toISOString(),
    },
  });

  logger.info(
    {
      watchPosition: true,
      sessionId,
      userId: latest.userId,
      tournamentId: latest.tournamentId,
      organizationId,
      actorUserId: (req.user as { id?: number } | undefined)?.id,
      ttlMs: appliedTtlMs,
    },
    "[super-admin] muted watch session",
  );

  res.json({
    ok: true,
    sessionId,
    userId: latest.userId,
    tournamentId: latest.tournamentId,
    organizationId,
    ttlMs: appliedTtlMs,
    expiresAt: expiresAt.toISOString(),
  });
});

// GET /super-admin/watch-position-metrics/muted-sessions — Task #1678.
// Lists every watch session currently muted across the api-server fleet
// so ops can see what they (or another admin) silenced earlier. Each
// entry is enriched with the session's most-recent metric metadata
// (userId, tournamentId) and the actor name from the matching `mute`
// audit row, so the dashboard can surface "who muted it" without ops
// having to cross-reference the audit log by hand.
//
// Cross-replica view (Task #2090): reads directly from the persisted
// `watch_session_mutes` table — not the in-process `mutedSessions` map
// — so the panel returns the same answer regardless of which replica
// happened to handle the request. The previous per-replica behaviour
// only listed mutes recorded on *this* server, which made it impossible
// for ops to see (or lift) a mute applied via a different replica.
router.get("/super-admin/watch-position-metrics/muted-sessions", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const active = await listActiveMutedSessionsFromDb();
  if (active.length === 0) {
    res.json({ sessions: [] });
    return;
  }

  // Batch-fetch the most recent metric row per muted sessionId so we
  // get user/tournament context without N+1 queries. DISTINCT ON keeps
  // only the newest bucket per session. We use the drizzle query builder
  // here (not raw `db.execute`) because raw `sql` templates splat array
  // bindings into ($1, $2, ...) placeholders, which breaks when wrapped
  // in `ANY(...)::text[]`. The query builder's `inArray` correctly
  // expands an IN-list of placeholders.
  const sessionIds = active.map((m) => m.sessionId);
  const metricRows = await db
    .selectDistinctOn([watchPositionMetricsTable.sessionId], {
      sessionId: watchPositionMetricsTable.sessionId,
      userId: watchPositionMetricsTable.userId,
      tournamentId: watchPositionMetricsTable.tournamentId,
    })
    .from(watchPositionMetricsTable)
    .where(inArray(watchPositionMetricsTable.sessionId, sessionIds))
    .orderBy(watchPositionMetricsTable.sessionId, desc(watchPositionMetricsTable.bucketMinute));
  const metricBySession = new Map(metricRows.map((r) => [r.sessionId, r]));

  // Same DISTINCT ON pattern for the audit lookup. The `mute` endpoint
  // stashes the sessionId inside `metadata.sessionId`, not entityId, so
  // we filter on the JSONB key. We project the JSONB extract via a sql
  // expression so drizzle can apply DISTINCT ON to it.
  const auditSessionIdSql = sql<string>`${memberAuditLogTable.metadata}->>'sessionId'`;
  const auditRows = await db
    .selectDistinctOn([auditSessionIdSql], {
      sessionId: auditSessionIdSql.as("session_id"),
      actorUserId: memberAuditLogTable.actorUserId,
      actorName: memberAuditLogTable.actorName,
      actorRole: memberAuditLogTable.actorRole,
      createdAt: memberAuditLogTable.createdAt,
    })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.entity, "watch_session"),
      eq(memberAuditLogTable.action, "mute"),
      inArray(auditSessionIdSql, sessionIds),
    ))
    .orderBy(auditSessionIdSql, desc(memberAuditLogTable.createdAt));
  const auditBySession = new Map(auditRows.map((r) => [r.sessionId, r]));

  const now = Date.now();
  const sessions = active.map((m) => {
    const metric = metricBySession.get(m.sessionId);
    const audit = auditBySession.get(m.sessionId);
    return {
      sessionId: m.sessionId,
      userId: metric?.userId ?? null,
      tournamentId: metric?.tournamentId ?? null,
      mutedByUserId: audit?.actorUserId ?? null,
      mutedByName: audit?.actorName ?? null,
      mutedByRole: audit?.actorRole ?? null,
      mutedAt: audit?.createdAt
        ? new Date(audit.createdAt as unknown as string | Date).toISOString()
        : null,
      expiresAt: new Date(m.expiresAtMs).toISOString(),
      remainingMs: Math.max(0, m.expiresAtMs - now),
    };
  });

  res.json({ sessions });
});

// DELETE /super-admin/watch-position-metrics/sessions/:sessionId/mute — Task #1678.
// Lifts an active mute early so a watch session can resume sending
// `position` messages before the TTL expires. Mirrors the audit-context
// resolution from the POST mute endpoint so the `unmute` row anchors to
// the same organization.
//
// Task #2092 — accepts an optional free-text `reason` in the request
// body so ops can record *why* the mute is being lifted (e.g. "false
// positive — high-cadence drill") instead of the canned default. We cap
// the length so a mis-pasted dump can't blow past the audit row's text
// column, and fall back to the canned reason when the field is empty.
const UNMUTE_REASON_MAX_LENGTH = 500;
//
// Cross-replica behaviour (Task #2090): the "is it muted?" check and
// the actual delete both go through the persisted `watch_session_mutes`
// table, so ops can lift a mute applied on a *different* replica from
// any replica's dashboard. The originating replica drops its own
// in-memory entry inline (`dropLocalWatchSessionMute`) so its hot path
// stops dropping position messages immediately; every other replica
// converges within the next periodic resync tick (≈5s).
router.delete("/super-admin/watch-position-metrics/sessions/:sessionId/mute", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;

  const sessionId = String((req.params as Record<string, string>).sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  const rawReason =
    typeof (req.body as { reason?: unknown } | undefined)?.reason === "string"
      ? ((req.body as { reason: string }).reason)
      : "";
  const trimmedReason = rawReason.trim().slice(0, UNMUTE_REASON_MAX_LENGTH);
  const auditReason = trimmedReason.length > 0
    ? trimmedReason
    : "Super admin lifted a watch session mute from the dashboard";

  // Refuse if the session isn't actually muted in the persisted store —
  // return 404 so the dashboard knows the row is already stale and can
  // refresh, rather than silently writing an `unmute` audit row for a
  // no-op. The check spans every replica's mutes (Task #2090), not just
  // this one, so ops can lift a mute applied on any replica.
  const persistedExpiryMs = await getPersistedWatchSessionMuteExpiryMs(sessionId);
  if (persistedExpiryMs == null) {
    res.status(404).json({ error: "Session is not currently muted." });
    return;
  }

  // Look up the most recent metric row to anchor the audit context, same
  // approach the POST mute endpoint uses. Without history we can't write
  // an audit row (org_id is NOT NULL), so refuse rather than leave the
  // unmute un-audited.
  const [latest] = await db
    .select({
      userId: watchPositionMetricsTable.userId,
      tournamentId: watchPositionMetricsTable.tournamentId,
    })
    .from(watchPositionMetricsTable)
    .where(eq(watchPositionMetricsTable.sessionId, sessionId))
    .orderBy(desc(watchPositionMetricsTable.bucketMinute))
    .limit(1);

  if (!latest) {
    res.status(404).json({ error: "No metrics recorded for that sessionId" });
    return;
  }

  let organizationId: number | null = null;
  if (latest.tournamentId != null) {
    const [t] = await db
      .select({ organizationId: tournamentsTable.organizationId })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, latest.tournamentId))
      .limit(1);
    if (t) organizationId = t.organizationId;
  }
  if (organizationId == null) {
    const [u] = await db
      .select({ organizationId: appUsersTable.organizationId })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, latest.userId))
      .limit(1);
    if (u?.organizationId != null) organizationId = u.organizationId;
  }
  if (organizationId == null) {
    res.status(409).json({
      error: "Cannot resolve an organization for this session; unmute requires audit context.",
    });
    return;
  }

  // Awaited delete so the 200 response really means the row is gone —
  // the next dashboard fetch (which reads the persisted store) will
  // immediately reflect the change without depending on a fire-and-
  // forget that hasn't landed yet.
  await deletePersistedWatchSessionMute(sessionId);
  // Drop the in-memory entry on this replica so the hot path stops
  // dropping position messages right away. Every other replica picks
  // up the deleted row on its next periodic resync tick (≈5s).
  dropLocalWatchSessionMute(sessionId);

  await recordMemberAudit({
    req,
    organizationId,
    clubMemberId: null,
    entity: "watch_session",
    entityId: null,
    action: "unmute",
    reason: auditReason,
    metadata: {
      sessionId,
      userId: latest.userId,
      tournamentId: latest.tournamentId,
      // Task #2092 — flag whether the operator typed a custom reason so
      // the audit consumers can distinguish "ops explicitly justified
      // this" from the canned default.
      reasonSource: trimmedReason.length > 0 ? "operator" : "default",
    },
  });

  logger.info(
    {
      watchPosition: true,
      sessionId,
      userId: latest.userId,
      tournamentId: latest.tournamentId,
      organizationId,
      actorUserId: (req.user as { id?: number } | undefined)?.id,
    },
    "[super-admin] unmuted watch session",
  );

  res.json({
    ok: true,
    sessionId,
    userId: latest.userId,
    tournamentId: latest.tournamentId,
    organizationId,
  });
});

// POST /super-admin/watch-position-metrics/test-ops-alert-chat — Task #1653.
// Lets a super-admin fire a clearly-labelled test page through the same
// Slack / PagerDuty senders the real watch-GPS spike alert uses, so a typo
// in `OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK` / `OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY`
// surfaces NOW instead of silently swallowing the page when it actually
// matters. Returns per-channel `configured` / `attempted` / `ok` / `error`
// so the dashboard can render a green/yellow/red status per channel.
//
// 200 even when neither channel is configured: the response body still
// reports `attempted: false` for both, and the dashboard surfaces a "no
// channels configured" message — that's a more useful signal than a 4xx
// the operator has to guess at.
router.post("/super-admin/watch-position-metrics/test-ops-alert-chat", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const result = await sendWatchGpsOpsAlertTestPage();
  // Audit-log the test fire so we have a paper trail of who poked the
  // ops channels (these messages do hit on-call's phone).
  const actor = req.user as
    | { id?: number; displayName?: string | null; username?: string | null }
    | undefined;
  const actorUserId = typeof actor?.id === "number" ? actor.id : null;
  // Cache the operator's friendly name (Task #2056) so the dashboard's
  // "Last test page: 3h ago by …" line doesn't have to join app_users
  // and survives later renames. Mirrors `member_audit_log.actor_name`.
  const actorName =
    (actor?.displayName && actor.displayName.trim()) ||
    (actor?.username && actor.username.trim()) ||
    null;
  logger.info(
    {
      watchPosition: true,
      opsAlertWiringTest: true,
      actorUserId,
      slack: result.slack,
      pagerDuty: result.pagerDuty,
    },
    "[super-admin] fired watch GPS ops alert wiring test",
  );
  // Task #2056 — also persist to the audit table so the dashboard can
  // chart frequency over the last 30 days and surface the most recent
  // click under the wiring badges. Best-effort: an audit-write failure
  // doesn't fail the response (the operator already paged on-call).
  await recordWatchGpsOpsAlertTestPage({
    actorUserId,
    actorName,
    result,
  });
  res.json(result);
});

// GET /super-admin/watch-position-metrics/test-ops-alert-chat-history — Task #2056.
// Returns the most recent test-page audit row plus a per-day count
// series for the last 30 days so the dashboard can render
// "Last test page: 3h ago by …" plus a small frequency chart under the
// wiring badges.
router.get(
  "/super-admin/watch-position-metrics/test-ops-alert-chat-history",
  async (req: Request, res: Response) => {
    if (!requireSuperAdmin(req, res)) return;
    res.json(await getWatchGpsOpsAlertTestPageHistory());
  },
);

// POST /super-admin/ops-alert-settings/test-ops-alert-chat — Task #2057.
// Sibling of the watch-GPS test endpoint above for the notify-retry
// exhaustion alert. Fires a clearly-labelled `[TEST]` page through the
// same Slack / PagerDuty senders the real exhaustion alert uses, so a
// typo in `OPS_NOTIFY_RETRY_ALERT_*` (or the shared fallback) surfaces
// NOW instead of silently swallowing the page when it actually matters.
//
// Lives on the ops-alert-settings path (not the existing
// `/super-admin/ops-alert-settings/test` email path) so the route shape
// matches the per-flow chat-test pattern other panels use, and so the
// existing test-email button keeps its singleton-stamp side effects
// without this new chat-only test inheriting them.
router.post("/super-admin/ops-alert-settings/test-ops-alert-chat", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const result = await sendNotifyRetryExhaustionOpsAlertTestPage();
  logger.info(
    {
      opsAlertWiringTest: true,
      flow: "notify_retry_exhaustion",
      actorUserId: (req.user as { id?: number } | undefined)?.id,
      slack: result.slack,
      pagerDuty: result.pagerDuty,
    },
    "[super-admin] fired notify-retry exhaustion ops alert wiring test",
  );
  res.json(result);
});

// POST /super-admin/badge-share-rollup/test-ops-alert-chat — Task #2057.
// Sibling of the watch-GPS test endpoint above for the badge-share
// rollup stale alert. Same per-channel response shape so the dashboard
// can render a green/yellow/red badge per channel.
router.post("/super-admin/badge-share-rollup/test-ops-alert-chat", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const result = await sendBadgeShareRollupOpsAlertTestPage();
  logger.info(
    {
      opsAlertWiringTest: true,
      flow: "badge_share_rollup_stale",
      actorUserId: (req.user as { id?: number } | undefined)?.id,
      slack: result.slack,
      pagerDuty: result.pagerDuty,
    },
    "[super-admin] fired badge-share rollup ops alert wiring test",
  );
  res.json(result);
});

// POST /super-admin/manual-entry-alerts/test-ops-alert-chat — Task #2057.
// Sibling of the watch-GPS test endpoint above for the manual-entry
// alert health alert.
router.post("/super-admin/manual-entry-alerts/test-ops-alert-chat", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const result = await sendManualEntryAlertHealthOpsAlertChatTestPage();
  logger.info(
    {
      opsAlertWiringTest: true,
      flow: "manual_entry_alert_health",
      actorUserId: (req.user as { id?: number } | undefined)?.id,
      slack: result.slack,
      pagerDuty: result.pagerDuty,
    },
    "[super-admin] fired manual-entry alert health ops alert wiring test",
  );
  res.json(result);
});

// GET /super-admin/manual-entry-alerts/summary — windowed delivery health
// over the `manual_entry_alerts` audit rows (Task #1193). Lets ops spot a
// stale APNs cert / bouncing TD inboxes without waiting for a TD complaint.
router.get("/super-admin/manual-entry-alerts/summary", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  // Task #2057 — also surface whether the manual-entry alert health
  // alert's Slack / PagerDuty channels are wired so the dashboard can
  // render configured/unconfigured badges + the "Send test page"
  // button. Sanitized status only (booleans), never the webhook URL or
  // routing key.
  const [summary, chatTargets] = await Promise.all([
    getManualEntryAlertHealthSummary(),
    Promise.resolve(getManualEntryAlertHealthOpsAlertChatTargetsStatus()),
  ]);
  res.json({ ...summary, chatTargets });
});

// GET /super-admin/badge-share-rollup/summary — most recent rollup run
// summary plus current row counts in `badge_share_events` and
// `badge_share_daily_aggregates` so operators can confirm Task #1096
// is keeping the raw-event table bounded and notice if the cron stops
// firing. The `isStale` flag drives a loud warning in the UI when the
// last successful run is more than ~36 hours old (Task #1260).
router.get("/super-admin/badge-share-rollup/summary", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  // Task #2057 — also surface whether the badge-share rollup stale
  // alert's Slack / PagerDuty channels are wired so the badge-share
  // rollup panel can render configured/unconfigured badges + the
  // "Send test page" button. Sanitized status only (booleans), never
  // the webhook URL or routing key. The profile-share sibling endpoint
  // below intentionally does NOT expose `chatTargets` — there is no
  // separate ops alert wired for the profile-share rollup yet.
  const [summary, chatTargets] = await Promise.all([
    getBadgeShareRollupAdminSummary(),
    Promise.resolve(getBadgeShareRollupOpsAlertChatTargetsStatus()),
  ]);
  res.json({ ...summary, chatTargets });
});

// GET /super-admin/profile-share-rollup/summary — sibling endpoint for
// the `profile_share_events` rollup (Task #1259). Same response shape
// as the badge-share variant above so the UI can render both rollups
// in one shared panel (Task #1474).
//
// Task #2261 — Also surfaces the auto-pager (Task #1813) state — last
// time the watchdog actually emailed super-admins + on-call, plus the
// configured cooldown window — so the panel can render the same
// "Last ops alert: 2h ago — won't re-page for another 4h" line the
// badge-share variant got in Task #1814 and feed the new "Recent ops
// alerts" disclosure below it.
router.get("/super-admin/profile-share-rollup/summary", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const [summary, lastOpsAlertAt] = await Promise.all([
    getProfileShareRollupAdminSummary(),
    loadLastProfileShareRollupOpsAlertAt(),
  ]);
  const opsAlertCooldownMs =
    getProfileShareRollupOpsAlertCooldownHours() * 60 * 60 * 1000;
  res.json({
    ...summary,
    lastOpsAlertAt: lastOpsAlertAt ? lastOpsAlertAt.toISOString() : null,
    opsAlertCooldownMs,
  });
});

// GET /super-admin/profile-share-rollup/page-history — Task #2261.
// Returns the most recent on-call pages for the profile-share rollup
// stale auto-page job (Task #1813). The dashboard renders these as a
// "Recent ops alerts" feed alongside the rollup-health panel so a
// super-admin can tell at a glance: was anyone paged about this
// outage already, and when?
//
// Mirrors the badge-share sibling and the manual-entry-alert
// page-history endpoint (Task #1665) — `limit` defaults to 10 and is
// clamped to [1, 100], `offset` defaults to 0, so a typo on the
// dashboard query string can't pull every historic row in one shot.
router.get("/super-admin/profile-share-rollup/page-history", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  let limit = 10;
  if (typeof rawLimit === "string" && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: "Invalid value for limit" });
      return;
    }
    limit = Math.min(100, Math.max(1, Math.floor(n)));
  }
  const rawOffset = Array.isArray(req.query.offset) ? req.query.offset[0] : req.query.offset;
  let offset = 0;
  if (typeof rawOffset === "string" && rawOffset !== "") {
    const n = Number(rawOffset);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "Invalid value for offset" });
      return;
    }
    offset = Math.floor(n);
  }
  const rows = await loadRecentProfileShareRollupOpsAlerts({ limit, offset });
  res.json({ rows, limit, offset });
});

// Shared parser for the rows endpoints (JSON + CSV) lives in
// `manualEntryAlertHealth.ts` so the per-org rollup endpoint
// (Task #2068) can reuse it without duplicating validation rules.

router.get("/super-admin/manual-entry-alerts/rows", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const result = parseManualEntryAlertRowsQuery(req.query as Record<string, unknown>);
  if (!result.ok) {
    res.status(400).json({ error: `Invalid value for ${result.field}` });
    return;
  }
  res.json(await listManualEntryAlertRows(result.parsed));
});

// GET /super-admin/manual-entry-alerts/rows.csv — Task #1388.
// Exports the same filtered rows the JSON endpoint returns so ops can
// share a list of silent alerts with a tournament director or escalate
// to engineering. Accepts the same query params; pagination params are
// honoured but the upper bound is raised so a single download contains
// the full filtered set rather than just the visible page.
//
// Hard-capped at MANUAL_ENTRY_ALERT_CSV_MAX_ROWS to avoid an unbounded
// memory blow-up if a stale filter pulls a giant window. Header /
// escape / row-format helpers live in `manualEntryAlertHealth.ts`
// alongside `listManualEntryAlertRows` so the weekly silent-failures
// cron digest (Task #1663) emits an identical CSV format — including
// the Task #1658 status + reason columns the dashboard renders.
router.get("/super-admin/manual-entry-alerts/rows.csv", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const result = parseManualEntryAlertRowsQuery(req.query as Record<string, unknown>);
  if (!result.ok) {
    res.status(400).json({ error: `Invalid value for ${result.field}` });
    return;
  }

  // Override pagination so the CSV mirrors the *full* filtered set, not
  // just the dashboard's page-size slice. We still cap at a sane upper
  // bound to bound memory.
  const data = await listManualEntryAlertRows({
    ...result.parsed,
    limit: MANUAL_ENTRY_ALERT_CSV_MAX_ROWS,
    offset: 0,
    maxLimit: MANUAL_ENTRY_ALERT_CSV_MAX_ROWS,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="manual-entry-alerts-${stamp}.csv"`,
  );
  // Delivery-health rows reference player + tournament names — never let
  // an intermediary cache the export.
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(buildManualEntryAlertsCsv(data.rows));
});

// GET /super-admin/manual-entry-alerts/:id/silent-recipients — per-alert
// drill-down (Task #1386). Lists every (recipient, channel) attempt
// that didn't end in "sent" so ops can reach out individually or
// pinpoint a stale device token / bouncing inbox.
router.get("/super-admin/manual-entry-alerts/:id/silent-recipients", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = Number((req.params as Record<string, string>).id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid alert id" });
    return;
  }
  const result = await getManualEntryAlertSilentRecipients(Math.floor(id));
  if (!result) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  res.json(result);
});

// GET /super-admin/manual-entry-alerts/:id/silent-recipients.csv — CSV
// export of the per-alert drill-down (Task #2075). Mirrors the JSON
// route's shape so off-dashboard analyses (spreadsheets, BI, ad-hoc
// grep) carry the same `reconstructed` provenance flag the dashboard
// pill renders for Task #1672 backfill rows.
router.get("/super-admin/manual-entry-alerts/:id/silent-recipients.csv", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const id = Number((req.params as Record<string, string>).id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid alert id" });
    return;
  }
  const alertId = Math.floor(id);
  const result = await getManualEntryAlertSilentRecipients(alertId);
  if (!result) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  const csv = buildManualEntryAlertSilentRecipientsCsv(alertId, result.silentRecipients);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="manual-entry-alert-${alertId}-silent-recipients.csv"`,
  );
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(csv);
});

// GET /super-admin/manual-entry-alerts/page-history — Task #1665.
// Returns the most recent on-call pages for the manual-entry alert
// health auto-page job. The dashboard renders the first row as a
// banner ("Last paged: <when> — <breach kinds> — <N recipients>") so
// super-admins can tell whether on-call has already been notified
// about a current outage; the rest forms a short audit list.
//
// `limit` defaults to 10 and is clamped to [1, 100] so a typo on the
// dashboard query string can't pull every historic row in one shot.
router.get("/super-admin/manual-entry-alerts/page-history", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  let limit = 10;
  if (typeof rawLimit === "string" && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ error: "Invalid value for limit" });
      return;
    }
    limit = Math.min(100, Math.max(1, Math.floor(n)));
  }
  const rows = await db
    .select({
      id: manualEntryAlertPageHistoryTable.id,
      pagedAt: manualEntryAlertPageHistoryTable.pagedAt,
      breachKinds: manualEntryAlertPageHistoryTable.breachKinds,
      recipientCount: manualEntryAlertPageHistoryTable.recipientCount,
      recipientEmails: manualEntryAlertPageHistoryTable.recipientEmails,
      thresholdPct: manualEntryAlertPageHistoryTable.thresholdPct,
      cooldownHours: manualEntryAlertPageHistoryTable.cooldownHours,
      alertCount7d: manualEntryAlertPageHistoryTable.alertCount7d,
      anyDeliveryRate7d: manualEntryAlertPageHistoryTable.anyDeliveryRate7d,
      zeroDeliveryCount7d: manualEntryAlertPageHistoryTable.zeroDeliveryCount7d,
      // Task #2079 — surface the synthetic-test flag so the dashboard
      // banner / history list can label test rows separately.
      isTest: manualEntryAlertPageHistoryTable.isTest,
    })
    .from(manualEntryAlertPageHistoryTable)
    .orderBy(desc(manualEntryAlertPageHistoryTable.pagedAt))
    .limit(limit);
  // Numeric columns come back as strings from pg — coerce so the
  // dashboard can format without an extra parseFloat dance.
  res.json({
    rows: rows.map((r) => ({
      ...r,
      pagedAt: r.pagedAt instanceof Date ? r.pagedAt.toISOString() : r.pagedAt,
      thresholdPct: Number(r.thresholdPct),
      cooldownHours: Number(r.cooldownHours),
      anyDeliveryRate7d: Number(r.anyDeliveryRate7d),
    })),
  });
});

// GET /super-admin/manual-entry-alerts/cooldown-status — Task #2078.
// Tells the dashboard whether on-call paging is currently muted by an
// active cooldown window AND a fresh breach is firing. The dashboard
// renders a "cooldown active" pill on the page-history banner so admins
// can tell silence on the dashboard means "problem detected, paging
// suppressed" rather than "no problem".
//
// Returns `active=false` (with the live `breachKinds` for diagnostics)
// when no page history exists, when the cooldown has already elapsed,
// or when no breach currently fires.
router.get(
  "/super-admin/manual-entry-alerts/cooldown-status",
  async (req: Request, res: Response) => {
    if (!requireSuperAdmin(req, res)) return;
    res.json(await getManualEntryAlertHealthCooldownStatus());
  },
);

// POST /super-admin/manual-entry-alerts/test-page — Task #2079.
// Lets a super-admin verify on-call email routing on demand from the
// dashboard, without waiting for a real silent-alert breach. Re-uses
// the same recipient resolution + Resend wiring as the auto-page job
// (Task #1387) and persists a `manual_entry_alert_page_history` row
// with `is_test = true` so the dashboard banner / history list can
// label the synthetic page distinctly.
//
// Returns 200 with `{ ok: false, reason: "no_recipients" }` (vs. 4xx)
// when no super_admin email and no OPS_ALERT_EMAILS entry exist —
// this is a useful diagnostic the dashboard surfaces in the toast.
router.post("/super-admin/manual-entry-alerts/test-page", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const result = await sendManualEntryAlertHealthOpsAlertTestPage();
  const actor = req.user as { id?: number; username?: string | null } | undefined;
  logger.info(
    {
      manualEntryAlertHealth: true,
      opsAlertWiringTest: true,
      actorUserId: actor?.id ?? null,
      ok: result.ok,
      reason: result.reason ?? null,
      recipientsAttempted: result.recipientsAttempted,
      recipientsEmailed: result.recipientsEmailed,
      pageHistoryId: result.pageHistoryId,
    },
    "[super-admin] fired manual-entry alert health test page",
  );
  res.json(result);
});

// Task #1962 — One-shot legacy video duration backfill, surfaced as a
// super-admin button on the dashboard.
//
// Tasks #1323 and #1574 mean videos with NULL `duration_seconds`
// silently lose the trim window in the highlight editor. The CLI script
// (`scripts/backfillMediaDurations.ts`) has been around since Task #855
// but only the platform team can run it from the shell. This endpoint
// wraps the same probe in an HTTP-triggered job so producers can drain
// the legacy backlog from the admin UI.
//
// GET returns the count of rows still un-measured (= never tried). The
// dashboard polls this so the producer can see "X legacy videos still
// un-measured" tick down toward zero as they re-run the sweep.
router.get("/super-admin/legacy-videos/un-measured-count", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  const count = await countUnmeasuredLegacyVideos();
  res.json({ count, batchSize: LEGACY_BACKFILL_BATCH_SIZE });
});

// POST kicks off one batch of the sweep. Capped at LEGACY_BACKFILL_BATCH_SIZE
// rows per call so a runaway backlog can't pin the API server inside a
// single HTTP request — each probe downloads the object and runs ffprobe.
// The producer can keep clicking until `remaining` hits zero.
router.post("/super-admin/legacy-videos/probe", async (req: Request, res: Response) => {
  if (!requireSuperAdmin(req, res)) return;
  try {
    const result = await runLegacyVideoBackfillBatch();
    logger.info(
      { result },
      "[super-admin/legacy-videos] sweep complete",
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "[super-admin/legacy-videos] sweep failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
