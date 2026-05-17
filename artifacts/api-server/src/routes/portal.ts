import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { assertModeAllows, AiCaddieBlockedError, getEffectiveMode } from "../lib/aiCaddieMode.js";
import { computePlayerBaseline } from "../lib/playerBaseline.js";
import { inferClub } from "../lib/clubInference.js";
import { db, profileShareEventsTable, profileShareDailyAggregatesTable, badgeShareEventsTable, badgeShareDailyAggregatesTable, recapShareEventsTable, recapShareDailyAggregatesTable, appUsersTable, playersTable, tournamentsTable, scoresTable, leagueMembersTable, leaguesTable, leagueStandingsTable, organizationsTable, orgMembershipsTable, clubThemingTable, roundSubmissionsTable, roundSubmissionsExtTable, scorecardCorrectionsTable, scorecardFlagsTable, waitlistTable, withdrawalsTable, userNotificationPrefsTable, userNotificationKeyPrefsTable, notificationTypeRegistryTable, notificationAuditLogTable, achievementsTable, handicapHistoryTable, wearableConnectionsTable, holeDetailsTable, coursesTable, clubMembersTable, memberSubscriptionsTable, membershipTiersTable, deviceTokensTable, shotsTable, practiceSessionsTable, coachingTipImpressionsTable, prizeCategoriesTable, prizeAwardsTable, tournamentRoundsTable, mediaTable, handicapAdjustmentsTable, watchPairingChallengesTable, lockersTable, lockerAssignmentsTable, lockerWaitlistTable, generalPlayRoundsTable, generalPlayHoleScoresTable, flightsTable, playerFlightsTable, clubCarryDistancesTable, holePinPositionsTable, memberProfileExtTable, memberDocumentsTable, memberDocumentVersionsTable, memberConsentsTable, memberCommPrefsTable, memberFamilyLinksTable, memberMilestonesTable, memberDataRequestsTable, memberAccountChargesTable, memberLevyChargesTable, memberLeviesTable, memberLifecycleEventsTable, memberAuditLogTable, memberAccessCardsTable, memberMessagesTable, storeCreditAccountsTable, storeCreditTransactionsTable, caddieRecommendationsTable, caddieChatHistoryTable, bracketMatchesTable, matchPlayBracketTable, tournamentAnnouncementsTable, noticeBoardArticlesTable, noticeBoardReadsTable, handicapCaseNotificationsTable, handicapCasePeerReviewsTable, handicapReviewCasesTable, clubWalletWithdrawalsTable, feedPostsTable } from "@workspace/db";
import { eq, desc, and, sql, inArray, notInArray, asc, avg, min, max, count, gte, isNull, isNotNull, or, gt } from "drizzle-orm";
import { MEMBER_ADMIN_MEMBERSHIP_ROLES } from "@workspace/member-admin-roles";
import { randomBytes } from "crypto";
import { applyLevyChargePayment } from "./member-360";
import { getRazorpayClient, getRazorpayKeyId, verifyPaymentSignature, cancelRazorpaySubscription, type RazorpayPaymentLinkCreateOpts } from "../lib/razorpay";
import { createCheckoutOrder } from "../lib/checkout";
import { logger as baseLogger } from "../lib/logger";
import { looksLikeMailPrefetch } from "../lib/mailPrefetch.js";
import { objectStorageClient, ObjectStorageService } from "../lib/objectStorage";
import { sendTransactionalPush } from "../lib/comms";
import { sendBroadcastEmail, sendWithdrawalConfirmationEmail, sendWaitlistPromotionEmail, sendErasureStorageDigestMutedConfirmationEmail, sendPortalDigestMutedConfirmationEmail } from "../lib/mailer";
import { notifyDocumentPendingStaff } from "../lib/documentPendingStaffNotify";
import { signErasureDigestMuteRevertToken, type ErasureDigestMuteRevertChannels, signPortalDigestMuteRevertToken } from "../lib/bouncedDigestUnsubscribe";
import { PORTAL_DIGEST_MUTE_SPECS, type PortalDigestMuteSpec } from "../lib/portalDigestMuteRegistry";
import { resolveOrgBranding } from "../lib/clubTheming.js";
import { notifyDataRequest } from "../lib/dataRequestNotify";
import { translateExportReminderUnsubPage } from "../lib/exportReminderUnsubPageI18n";
import { notifyManualEntryRound } from "../lib/manualEntryNotify";
import type { DataRequestEmailKind } from "../lib/mailer";
import { recordMemberAudit } from "../lib/auditMember";
import {
  getActiveSideGameReceiptToggleAnnouncement,
  dismissSideGameReceiptToggleAnnouncement,
} from "../lib/sideGameReceiptToggleAnnouncement";
import { wellnessDailyMetricsTable, wellnessConsentsTable, userHealthPrefsTable, whsPlayerStateTable } from "@workspace/db";
import { computePlayerSGFromDB, computePerHoleSGFromShots, computeProximityBands, computeProximityByClub, computeProximityCoachingTips, computePuttingMakeRates, computeClubDispersion, computeWeeklyProximityHistory, resolveProximityBaseline, resolveSgBaseline, pickPrimarySgBaseline, type SGBaseline, type ShotRow } from "../lib/strokes-gained";
import { computeWeatherCorrelation } from "../lib/weatherCorrelation.js";
import { getWeather } from "../lib/weather.js";
import { computePlaysLikeForHole } from "../lib/playsLike";
import { detectShotsFromSignals, detectedShotsToInsert, SENSITIVITY_PRESETS, bufferMotionEvents, drainMotionEvents, peekMotionEvents, bufferGPSSamples, peekGPSSamples, clearGPSSamples, mergeBufferedGPS, type GPSSample, type MotionEvent, type DetectedShot, type DetectedShotType } from "../lib/shot-detection";
import { recommend as caddieRecommend, buildClubStatsFromAggregates, fallbackClubStats, lieAdjustmentLabel, type ClubStat } from "../lib/caddie";
import { openai } from "@workspace/integrations-openai-ai-server";
import { computeRoundSGFromShots, type RoundShotData, type HoleParMap } from "../lib/strokes-gained";
import { issueWatchToken, verifyWatchToken as _verifyWatchToken } from "../lib/watch-token";
import { notifyHoleScoreEntered, notifyMarkerLiveScore } from "../lib/realtime";
import { notifyWatchHoleVerified, notifyWatchHoleRejected } from "./ws-watch";
import {
  getGarminOAuthUrl, handleGarminCallback,
  getArccosOAuthUrl, handleArccosCallback,
  getWhoopOAuthUrl, handleWhoopCallback,
  getGoogleFitOAuthUrl, handleGoogleFitCallback,
  processGPXUpload, syncWearableData,
  buildShotsFromGPX, type GPXRoundContext,
  upsertWellnessMetric, getAggregatedWellnessDays, computeReadinessRecommendation,
  WELLNESS_PROVIDERS, type WellnessProvider,
  ingestHrSamples, getRoundHrStrip, getHrScoringCorrelation, listHrSampleRoundsForUser,
  getUserHealthPrefs, setUserHealthPrefs, deleteAllHrSamplesForUser,
  markHrSessionActive, markHrSessionEnded,
  type IngestHrSample,
} from "../lib/wearables";
import { getEffectivePlanConfig } from "../lib/planConfigLoader";
import { TIER_DISPLAY, type SubscriptionTier } from "../lib/subscriptionTiers";
import { gateFeatureFromSession } from "../lib/featureGate";
import type { AuthUser } from "@workspace/api-zod";
import { postScoreAndRecalculate, getPccForCourseDate } from "../lib/whs-recalc";
import { requireOrgAdmin } from "../lib/permissions";
import { requireConsent, userHasConsent } from "../lib/consent";
import { ALL_BADGES, computeBadgeProgress } from "../lib/achievementEngine";
import { localizeBadge, resolveBadgeI18nLangFromReq } from "../lib/badgeI18n";
import { recordCaddiePromptMetric } from "../lib/caddiePromptMetrics";
import { sendPushToUsers, classifyPushDelivery } from "../lib/push";
import { translateSpectatorPush, isSupportedSpectatorPushLang } from "../lib/spectatorPushI18n";
import type { ScoringEvent } from "../lib/realtime";
import { getCachedYearInGolf, parseRecapPeriod } from "../lib/year-in-golf";
import { renderCardPng, renderRecapVideo } from "../lib/year-in-golf-render";

const router: IRouter = Router();

function getPortalUserId(req: Request): number | null {
  if (!req.isAuthenticated()) return null;
  return req.user!.id;
}


// Apply mobileApp gate to /portal/* routes only (NOT /public/* routes in this same router).
// Resolves org from session — fail-closed.
router.use("/portal", gateFeatureFromSession("mobileApp"));

// WHS self-scoring gate — all submission, signing, and scoring-workflow paths require whsScoring.
// orgId is resolved from session (not route params) so this works for /portal/* paths.
const gateWhs = gateFeatureFromSession("whsScoring");
router.use([
  "/portal/submissions",
  "/portal/my-submission-status",
  "/portal/pending-submissions",
], gateWhs);

// Shop & Locker gate — locker portal paths require shopLockerAccess.
const gateShopLocker = gateFeatureFromSession("shopLockerAccess");
router.use("/portal/locker", gateShopLocker);

function requirePlayer(req: Request, res: Response): boolean {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// GET /api/portal/me
router.get("/portal/me", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const [user] = await db
    .select()
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user!.id));

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  let organizationName: string | undefined;
  if (user.organizationId) {
    const [org] = await db
      .select({ name: organizationsTable.name })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, user.organizationId));
    organizationName = org?.name;
  }

  // Task #2210 — list every org id where this user has a membership-derived
  // member-admin role (org_admin / membership_secretary / treasurer in
  // org_memberships). The mobile home screen surfaces the stuck-erasure
  // backlog badge to anyone the server's `requireMemberAdmin` would
  // authorise — including treasurers and membership secretaries who only
  // hold their elevated role via `org_memberships`. Pre-computing the
  // list on `me` avoids a per-render extra round-trip.
  const memberAdminMemberships = await db
    .select({ organizationId: orgMembershipsTable.organizationId })
    .from(orgMembershipsTable)
    .where(
      and(
        eq(orgMembershipsTable.userId, user.id),
        inArray(orgMembershipsTable.role, MEMBER_ADMIN_MEMBERSHIP_ROLES),
      ),
    );
  const memberAdminOrgIds = Array.from(
    new Set(memberAdminMemberships.map((m) => m.organizationId)),
  ).sort((a, b) => a - b);

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    username: user.username,
    profileImage: user.profileImage,
    role: user.role,
    organizationId: user.organizationId,
    organizationName,
    memberAdminOrgIds,
    emailVerified: user.emailVerified,
    isLocalAuth: user.replitUserId.startsWith("ep_"),
    preferredLanguage: user.preferredLanguage ?? "en",
    createdAt: user.createdAt.toISOString(),
  });
});

// ── PUBLIC PROFILE (Task #383) ─────────────────────────────────────
// GET /api/portal/me/public-profile — current settings
router.get("/portal/me/public-profile", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const [u] = await db
    .select({
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicShowHandicap: appUsersTable.publicShowHandicap,
      publicShowRecentRounds: appUsersTable.publicShowRecentRounds,
      publicShowAchievements: appUsersTable.publicShowAchievements,
      publicShowFavoriteCourses: appUsersTable.publicShowFavoriteCourses,
      publicBio: appUsersTable.publicBio,
      publicLocation: appUsersTable.publicLocation,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user!.id));
  if (!u) { { res.status(404).json({ error: "User not found" }); return; } }
  res.json(u);
});

// PATCH /api/portal/me/public-profile — toggle profile, set handle, per-section privacy
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
const RESERVED_HANDLES = new Set(["admin","api","app","www","kharagolf","support","help","login","signup","p","scorecard","clubs","features","capability-report"]);
router.patch("/portal/me/public-profile", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const body = req.body ?? {};
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (body.publicHandle !== undefined) {
    if (body.publicHandle === null || body.publicHandle === "") {
      updates.publicHandle = null;
    } else {
      const h = String(body.publicHandle).toLowerCase().trim();
      if (!HANDLE_RE.test(h) || RESERVED_HANDLES.has(h)) {
        res.status(400).json({ error: "Invalid handle. Use 3–30 lowercase letters, numbers, '-' or '_'." });
        return;
      }
      // uniqueness check
      const [taken] = await db
        .select({ id: appUsersTable.id })
        .from(appUsersTable)
        .where(and(eq(appUsersTable.publicHandle, h)));
      if (taken && taken.id !== req.user!.id) {
        res.status(409).json({ error: "That handle is already taken." });
        return;
      }
      updates.publicHandle = h;
    }
  }

  for (const key of ["publicProfileEnabled","publicShowHandicap","publicShowRecentRounds","publicShowAchievements","publicShowFavoriteCourses"] as const) {
    if (typeof body[key] === "boolean") updates[key] = body[key];
  }
  if (body.publicBio !== undefined) {
    const v = body.publicBio === null ? null : String(body.publicBio).slice(0, 500);
    updates.publicBio = v;
  }
  if (body.publicLocation !== undefined) {
    const v = body.publicLocation === null ? null : String(body.publicLocation).slice(0, 120);
    updates.publicLocation = v;
  }

  // Cannot enable a profile without first reserving a handle
  if (updates.publicProfileEnabled === true) {
    const [cur] = await db.select({ publicHandle: appUsersTable.publicHandle }).from(appUsersTable).where(eq(appUsersTable.id, req.user!.id));
    const finalHandle = updates.publicHandle !== undefined ? updates.publicHandle : cur?.publicHandle;
    if (!finalHandle) {
      res.status(400).json({ error: "Reserve a handle before enabling your public profile." });
      return;
    }
  }

  await db.update(appUsersTable).set(updates).where(eq(appUsersTable.id, req.user!.id));

  const [u] = await db
    .select({
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicShowHandicap: appUsersTable.publicShowHandicap,
      publicShowRecentRounds: appUsersTable.publicShowRecentRounds,
      publicShowAchievements: appUsersTable.publicShowAchievements,
      publicShowFavoriteCourses: appUsersTable.publicShowFavoriteCourses,
      publicBio: appUsersTable.publicBio,
      publicLocation: appUsersTable.publicLocation,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user!.id));
  res.json(u);
});

// GET /api/portal/me/public-scorecards — list of the player's shareable scorecards with per-card visibility
router.get("/portal/me/public-scorecards", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const rows = await db
    .select({
      playerId: playersTable.id,
      shareToken: playersTable.shareToken,
      publicHidden: playersTable.publicHidden,
      tournamentName: tournamentsTable.name,
      startDate: tournamentsTable.startDate,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(eq(playersTable.userId, req.user!.id))
    .orderBy(desc(tournamentsTable.startDate))
    .limit(100);
  res.json(rows.filter(r => !!r.shareToken));
});

// ── Profile share analytics (Task #625) ──────────────────────────────
// POST /api/portal/me/profile-share-events
// Logs a single share-button click from the privacy/share UI on web or
// mobile (copy link, Web Share API, native share sheet, or QR code open).
// Counts are derived with COUNT(*) GROUP BY method at read time and
// surfaced via the share-stats endpoint below for product analytics.
const PROFILE_SHARE_METHODS = new Set(["copy", "web_share", "native_share", "qr_open"]);
const PROFILE_SHARE_SOURCES = new Set(["web", "mobile"]);
router.post("/portal/me/profile-share-events", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const body = req.body ?? {};
  const method = typeof body.method === "string" ? body.method : "";
  const source = typeof body.source === "string" && PROFILE_SHARE_SOURCES.has(body.source)
    ? body.source as "web" | "mobile"
    : null;
  if (!PROFILE_SHARE_METHODS.has(method)) {
    res.status(400).json({ error: "method must be one of copy, web_share, native_share, qr_open" });
    return;
  }
  const [u] = await db
    .select({ publicHandle: appUsersTable.publicHandle })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user!.id));
  if (!u || !u.publicHandle) {
    // Cannot share a profile that has no handle reserved.
    res.status(400).json({ error: "No public handle reserved" });
    return;
  }
  await db.insert(profileShareEventsTable).values({
    userId: req.user!.id,
    handle: u.publicHandle,
    method: method as "copy" | "web_share" | "native_share" | "qr_open",
    source,
  });
  res.status(201).json({ ok: true });
});

// GET /api/portal/me/public-profile/share-stats
// Returns total + per-method + per-source share counts for the caller's
// profile. Lightweight aggregate so the privacy page can show "X shares"
// alongside a web-vs-mobile breakdown, and the data is also queryable via
// the same table for product analytics.
router.get("/portal/me/public-profile/share-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  // Task #1259 — Union the raw events table with the daily-aggregate
  // rollup so totals stay accurate after old rows have been pruned out
  // of `profile_share_events` into `profile_share_daily_aggregates`.
  //
  // Task #1458 — Also surface a web-vs-mobile source split.
  //
  // Task #1781 — The daily aggregate table now preserves `source` as
  // part of its primary key, so the bySource breakdown UNIONs raw
  // events with rolled-up aggregates the same way byMethod does. Legacy
  // null sources on the raw table and the `'unknown'` sentinel on the
  // aggregate table are both excluded from bySource so the chips only
  // reflect events that were actually tagged at write time. Per-method
  // and total counts continue to include every row (tagged or not) so
  // owners still see complete historical share volume.
  const [rawRows, aggRows, rawSourceRows, aggSourceRows] = await Promise.all([
    db
      .select({
        method: profileShareEventsTable.method,
        n: count(profileShareEventsTable.id),
      })
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, req.user!.id))
      .groupBy(profileShareEventsTable.method),
    db
      .select({
        method: profileShareDailyAggregatesTable.method,
        n: sql<number>`COALESCE(SUM(${profileShareDailyAggregatesTable.count}), 0)::int`,
      })
      .from(profileShareDailyAggregatesTable)
      .where(eq(profileShareDailyAggregatesTable.userId, req.user!.id))
      .groupBy(profileShareDailyAggregatesTable.method),
    db
      .select({
        source: profileShareEventsTable.source,
        n: count(profileShareEventsTable.id),
      })
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, req.user!.id))
      .groupBy(profileShareEventsTable.source),
    db
      .select({
        source: profileShareDailyAggregatesTable.source,
        n: sql<number>`COALESCE(SUM(${profileShareDailyAggregatesTable.count}), 0)::int`,
      })
      .from(profileShareDailyAggregatesTable)
      .where(eq(profileShareDailyAggregatesTable.userId, req.user!.id))
      .groupBy(profileShareDailyAggregatesTable.source),
  ]);
  const byMethod: Record<string, number> = { copy: 0, web_share: 0, native_share: 0, qr_open: 0 };
  let total = 0;
  for (const r of [...rawRows, ...aggRows]) {
    const n = Number(r.n) || 0;
    byMethod[r.method] = (byMethod[r.method] ?? 0) + n;
    total += n;
  }
  const bySource: { web: number; mobile: number } = { web: 0, mobile: 0 };
  for (const r of [...rawSourceRows, ...aggSourceRows]) {
    const n = Number(r.n) || 0;
    if (r.source === "web") bySource.web += n;
    else if (r.source === "mobile") bySource.mobile += n;
    // Null/legacy raw sources and the aggregate's `'unknown'` sentinel
    // are intentionally excluded so the split only reflects events
    // tagged after source tracking landed.
  }
  res.json({ total, byMethod, bySource });
});

// ── Per-badge share analytics (Task #926) ───────────────────────────
// GET /api/portal/me/badge-share-stats
// Returns per-badge + per-method share counts for the caller's badges
// (identified by their reserved publicHandle). Mirrors the profile
// share-stats endpoint but groups by badgeType so club admins and the
// owner can see which achievements drive the most viral traffic.
//
// Response shape:
//   { total: number,
//     totalsByMethod: { copy, web_share, native_share },
//     badges: Array<{
//       badgeType, label, icon, category, total,
//       byMethod: { copy, web_share, native_share },
//     }> }
router.get("/portal/me/badge-share-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const [u] = await db
    .select({ publicHandle: appUsersTable.publicHandle })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user!.id));
  if (!u || !u.publicHandle) {
    res.json({ total: 0, totalsByMethod: { copy: 0, web_share: 0, native_share: 0 }, badges: [] });
    return;
  }
  // Task #1096 — Union the raw events table with the daily-aggregate
  // rollup so totals stay accurate after old rows have been pruned out
  // of `badge_share_events` into `badge_share_daily_aggregates`.
  const [rawRows, aggRows] = await Promise.all([
    db
      .select({
        badgeType: badgeShareEventsTable.badgeType,
        method: badgeShareEventsTable.method,
        n: count(badgeShareEventsTable.id),
      })
      .from(badgeShareEventsTable)
      .where(eq(badgeShareEventsTable.handle, u.publicHandle))
      .groupBy(badgeShareEventsTable.badgeType, badgeShareEventsTable.method),
    db
      .select({
        badgeType: badgeShareDailyAggregatesTable.badgeType,
        method: badgeShareDailyAggregatesTable.method,
        n: sql<number>`COALESCE(SUM(${badgeShareDailyAggregatesTable.count}), 0)::int`,
      })
      .from(badgeShareDailyAggregatesTable)
      .where(eq(badgeShareDailyAggregatesTable.handle, u.publicHandle))
      .groupBy(badgeShareDailyAggregatesTable.badgeType, badgeShareDailyAggregatesTable.method),
  ]);
  const rows = [...rawRows, ...aggRows];

  const totalsByMethod = { copy: 0, web_share: 0, native_share: 0 };
  let total = 0;
  const byBadge = new Map<string, { byMethod: { copy: number; web_share: number; native_share: number }; total: number }>();
  for (const r of rows) {
    const n = Number(r.n) || 0;
    let entry = byBadge.get(r.badgeType);
    if (!entry) {
      entry = { byMethod: { copy: 0, web_share: 0, native_share: 0 }, total: 0 };
      byBadge.set(r.badgeType, entry);
    }
    entry.byMethod[r.method as keyof typeof entry.byMethod] += n;
    entry.total += n;
    totalsByMethod[r.method as keyof typeof totalsByMethod] += n;
    total += n;
  }

  const badges = Array.from(byBadge.entries())
    .map(([badgeType, e]) => {
      const def = ALL_BADGES.find(b => b.type === badgeType);
      return {
        badgeType,
        label: def?.label ?? badgeType,
        icon: def?.icon ?? "🏅",
        category: def?.category ?? null,
        total: e.total,
        byMethod: e.byMethod,
      };
    })
    .sort((a, b) => b.total - a.total);

  res.json({ total, totalsByMethod, badges });
});

// ── Public recap-link share analytics (Task #1281) ──────────────────
// GET /api/portal/me/recap-share-stats
// Returns per-asset / per-period / per-source counts for hits to the
// caller's public Year-in-Golf recap endpoints. Counts come from two
// places after the rollup job runs: the raw `recap_share_events` table
// (recent rows) and the per-day `recap_share_daily_aggregates` table
// (older rows summarised per day). The rollup job
// (`pruneAndRollupRecapShareEvents`) deletes events once they're
// aggregated, so the union doesn't double-count on the boundary.
//
// Response shape:
//   {
//     total: number,
//     totalsByAsset:  { card_png, og },
//     totalsBySource: { copy, web_share, native_share, qr_open, crawler, unknown },
//     byPeriod: Array<{ year, period, total, byAsset, bySource }>,
//   }
//
// The `byPeriod` breakdown lets the player see which recap window
// (Q1, Q2, … Full Year) is generating the most external traffic, and
// the source breakdown surfaces whether viral signups are coming from
// link-preview crawlers vs. direct human clicks.
const RECAP_SHARE_ASSETS = ["card_png", "og"] as const;
const RECAP_SHARE_SOURCES_OUT = ["copy", "web_share", "native_share", "qr_open", "crawler", "unknown"] as const;
type RecapShareAssetKey = typeof RECAP_SHARE_ASSETS[number];
type RecapShareSourceKey = typeof RECAP_SHARE_SOURCES_OUT[number];
function emptyAssetCounts(): Record<RecapShareAssetKey, number> {
  return { card_png: 0, og: 0 };
}
function emptySourceCounts(): Record<RecapShareSourceKey, number> {
  return { copy: 0, web_share: 0, native_share: 0, qr_open: 0, crawler: 0, unknown: 0 };
}
router.get("/portal/me/recap-share-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const [rawRows, aggRows] = await Promise.all([
    db
      .select({
        asset: recapShareEventsTable.asset,
        period: recapShareEventsTable.period,
        year: recapShareEventsTable.year,
        source: recapShareEventsTable.source,
        n: count(recapShareEventsTable.id),
      })
      .from(recapShareEventsTable)
      .where(eq(recapShareEventsTable.userId, req.user!.id))
      .groupBy(
        recapShareEventsTable.asset,
        recapShareEventsTable.period,
        recapShareEventsTable.year,
        recapShareEventsTable.source,
      ),
    db
      .select({
        asset: recapShareDailyAggregatesTable.asset,
        period: recapShareDailyAggregatesTable.period,
        year: recapShareDailyAggregatesTable.year,
        source: recapShareDailyAggregatesTable.source,
        n: sql<number>`COALESCE(SUM(${recapShareDailyAggregatesTable.count}), 0)::int`,
      })
      .from(recapShareDailyAggregatesTable)
      .where(eq(recapShareDailyAggregatesTable.userId, req.user!.id))
      .groupBy(
        recapShareDailyAggregatesTable.asset,
        recapShareDailyAggregatesTable.period,
        recapShareDailyAggregatesTable.year,
        recapShareDailyAggregatesTable.source,
      ),
  ]);

  const totalsByAsset = emptyAssetCounts();
  const totalsBySource = emptySourceCounts();
  let total = 0;
  // Bucket per (year, period) for the breakdown.
  const byPeriodMap = new Map<string, {
    year: number;
    period: string;
    total: number;
    byAsset: Record<RecapShareAssetKey, number>;
    bySource: Record<RecapShareSourceKey, number>;
  }>();

  for (const r of [...rawRows, ...aggRows]) {
    const n = Number(r.n) || 0;
    if (n === 0) continue;
    const asset = (RECAP_SHARE_ASSETS as readonly string[]).includes(r.asset)
      ? (r.asset as RecapShareAssetKey)
      : null;
    const source: RecapShareSourceKey = (RECAP_SHARE_SOURCES_OUT as readonly string[]).includes(r.source)
      ? (r.source as RecapShareSourceKey)
      : "unknown";
    if (asset) totalsByAsset[asset] += n;
    totalsBySource[source] += n;
    total += n;
    const key = `${r.year}|${r.period}`;
    let entry = byPeriodMap.get(key);
    if (!entry) {
      entry = {
        year: Number(r.year),
        period: String(r.period),
        total: 0,
        byAsset: emptyAssetCounts(),
        bySource: emptySourceCounts(),
      };
      byPeriodMap.set(key, entry);
    }
    entry.total += n;
    if (asset) entry.byAsset[asset] += n;
    entry.bySource[source] += n;
  }

  const byPeriod = Array.from(byPeriodMap.values())
    .sort((a, b) => (b.year - a.year) || a.period.localeCompare(b.period));

  res.json({ total, totalsByAsset, totalsBySource, byPeriod });
});

// PATCH /api/portal/me/public-scorecards/:playerId — set per-scorecard hidden flag
router.patch("/portal/me/public-scorecards/:playerId", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const playerId = parseInt((req.params as Record<string, string>).playerId ?? "", 10);
  if (!Number.isFinite(playerId)) { { res.status(400).json({ error: "Invalid playerId" }); return; } }
  if (typeof req.body?.publicHidden !== "boolean") { { res.status(400).json({ error: "publicHidden boolean required" }); return; } }

  const [pl] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, playerId));
  if (!pl || pl.userId !== req.user!.id) { { res.status(404).json({ error: "Player not found" }); return; } }

  await db.update(playersTable).set({ publicHidden: req.body.publicHidden }).where(eq(playersTable.id, playerId));
  res.json({ playerId, publicHidden: req.body.publicHidden });
});

// PATCH /api/portal/me/language — update preferred language
router.patch("/portal/me/language", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const { language } = req.body;
  const supported = ["en", "hi", "ar", "es", "fr", "de", "pt", "ja", "ko", "zh", "th", "ms", "id", "vi", "fil", "sw", "af", "am", "ha", "zu", "yo"];
  if (!language || !supported.includes(language)) {
    res.status(400).json({ error: "Invalid language. Supported: en, hi, ar, es, fr, de, pt, ja, ko, zh, th, ms, id, vi, fil, sw, af, am, ha, zu, yo" });
    return;
  }
  await db.update(appUsersTable).set({ preferredLanguage: language as "en", updatedAt: new Date() }).where(eq(appUsersTable.id, req.user!.id));
  res.json({ preferredLanguage: language });
});

// POST /api/portal/avatar-upload-url — get signed GCS URL for avatar upload
router.post("/portal/avatar-upload-url", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const { contentType } = req.body;
  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(contentType)) {
    res.status(400).json({ error: "Invalid content type. Use PNG, JPEG or WebP." });
    return;
  }
  try {
    const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
    if (!bucket) { { res.status(500).json({ error: "Storage not configured" }); return; } }
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const objectPath = `avatars/user-${req.user!.id}.${ext}`;
    const bucketObj = objectStorageClient.bucket(bucket);
    const file = bucketObj.file(objectPath);
    const [uploadUrl] = await file.getSignedUrl({
      action: "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType,
    });
    const publicUrl = `https://storage.googleapis.com/${bucket}/${objectPath}`;
    res.json({ uploadUrl, publicUrl });
  } catch {
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// PATCH /api/portal/me/avatar — save avatar URL or preset after upload
router.patch("/portal/me/avatar", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const { profileImage } = req.body;
  if (!profileImage || typeof profileImage !== "string") {
    res.status(400).json({ error: "profileImage URL or preset ID is required" });
    return;
  }
  const isPreset = profileImage.startsWith("preset:");
  const isUrl = profileImage.startsWith("https://") || profileImage.startsWith("http://") || profileImage.startsWith("data:");
  if (!isPreset && !isUrl) {
    res.status(400).json({ error: "Invalid profileImage value" });
    return;
  }
  await db.update(appUsersTable).set({ profileImage, updatedAt: new Date() }).where(eq(appUsersTable.id, req.user!.id));
  res.json({ profileImage });
});

// DELETE /api/portal/me/avatar — clear avatar
router.delete("/portal/me/avatar", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  await db.update(appUsersTable).set({ profileImage: null, updatedAt: new Date() }).where(eq(appUsersTable.id, req.user!.id));
  res.json({ profileImage: null });
});

// GET /api/portal/my-orgs
// Returns all organizations the authenticated user belongs to (any role).
// Used by the mobile/web club switcher to let multi-org members switch context.
router.get("/portal/my-orgs", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  // Task #2193 — prefer the saved `club_theming.logo_url` (the new
  // club-theming UI) over the legacy `organizations.logo_url` so the
  // multi-org switcher renders the same logo a player sees on their
  // membership card / event emails / certificates. We do this with a
  // single LEFT JOIN + COALESCE rather than per-org `resolveOrgBranding`
  // calls because the route returns N orgs and we want one round trip.
  // COALESCE picks the first non-null value, which mirrors the
  // precedence in `resolveOrgBranding`: a club_theming row with a
  // non-null logo wins; a row that exists but left logo_url null still
  // falls through to the legacy column.
  const memberships = await db
    .select({
      orgId: orgMembershipsTable.organizationId,
      role: orgMembershipsTable.role,
      name: organizationsTable.name,
      slug: organizationsTable.slug,
      subscriptionTier: organizationsTable.subscriptionTier,
      logoUrl: sql<string | null>`COALESCE(${clubThemingTable.logoUrl}, ${organizationsTable.logoUrl})`,
      isActive: organizationsTable.isActive,
    })
    .from(orgMembershipsTable)
    .innerJoin(organizationsTable, eq(orgMembershipsTable.organizationId, organizationsTable.id))
    .leftJoin(clubThemingTable, eq(clubThemingTable.organizationId, organizationsTable.id))
    .where(eq(orgMembershipsTable.userId, userId));

  const orgs = memberships.map(m => ({
    id: m.orgId,
    name: m.name,
    slug: m.slug,
    subscriptionTier: m.subscriptionTier,
    logoUrl: m.logoUrl,
    role: m.role,
    isActive: m.isActive,
  }));

  res.json({ orgs });
});

// GET /api/portal/my-tournaments
router.get("/portal/my-tournaments", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const userEmail = req.user!.email;
  if (!userEmail) {
    res.json([]);
    return;
  }

  // Find all player registrations linked to this email or userId
  const playerRows = await db
    .select({
      playerId: playersTable.id,
      tournamentId: playersTable.tournamentId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
      paymentStatus: playersTable.paymentStatus,
      checkedIn: playersTable.checkedIn,
      currentRound: playersTable.currentRound,
      teeBox: playersTable.teeBox,
      registeredAt: playersTable.registeredAt,
      tournamentName: tournamentsTable.name,
      tournamentStatus: tournamentsTable.status,
      tournamentFormat: tournamentsTable.format,
      leaderboardType: tournamentsTable.leaderboardType,
      startDate: tournamentsTable.startDate,
      endDate: tournamentsTable.endDate,
      entryFee: tournamentsTable.entryFee,
      orgId: tournamentsTable.organizationId,
      selfPosting: tournamentsTable.selfPosting,
      allowSelfScoring: tournamentsTable.allowSelfScoring,
      markerValidation: tournamentsTable.markerValidation,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(
      sql`${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${req.user!.id}`
    )
    .orderBy(desc(tournamentsTable.startDate));

  res.json(playerRows);
});

// GET /api/portal/badge-counts
// Aggregated counts that power the More-menu row badges in the mobile app.
// One round-trip replaces the previous 5+ fan-out (notifications + per-tournament
// announcements + peer invites + notice board + feed + wallet).
//
// Query params:
//   orgId               — optional active org; scopes notice-board, feed, wallet
//   announcementsSince  — epoch ms; announcements newer than this count as unread
//   feedSince           — epoch ms; feed posts newer than this count as new
//                         (omit / 0 to get 0, matching the client's first-visit
//                         behaviour where the backlog must not flood the badge)
router.get("/portal/badge-counts", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const userId = req.user!.id;
  const userEmail = req.user!.email ?? null;
  const requestedOrgId = req.query.orgId ? Number(req.query.orgId) || null : null;
  const announcementsSince = req.query.announcementsSince
    ? Number(req.query.announcementsSince) || 0
    : 0;
  const feedSince = req.query.feedSince ? Number(req.query.feedSince) || 0 : 0;
  const now = new Date();

  // Verify org membership before computing any org-scoped count. If the caller
  // is not a member of the requested org we silently fall back to orgId=null
  // (returns zeros for those rows) instead of leaking activity counts.
  let orgId: number | null = null;
  if (requestedOrgId) {
    const [membership] = await db
      .select({ orgId: orgMembershipsTable.organizationId })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.userId, userId),
        eq(orgMembershipsTable.organizationId, requestedOrgId),
      ));
    if (membership) orgId = requestedOrgId;
  }

  const PENDING_WITHDRAWAL_STATES = ["pending", "processing", "dispatch_unknown"];

  const enrollmentCondition = userEmail
    ? sql`(${playersTable.userId} = ${userId} OR lower(${playersTable.email}) = lower(${userEmail}))`
    : eq(playersTable.userId, userId);

  // Match the previous mobile behaviour: when the client has no last-seen
  // marker yet (first sync), every announcement across the user's tournaments
  // counts as unread.
  const announcementsWhere = announcementsSince > 0
    ? and(
        inArray(
          tournamentAnnouncementsTable.tournamentId,
          db.select({ id: playersTable.tournamentId })
            .from(playersTable)
            .where(enrollmentCondition),
        ),
        gt(tournamentAnnouncementsTable.sentAt, new Date(announcementsSince)),
      )
    : inArray(
        tournamentAnnouncementsTable.tournamentId,
        db.select({ id: playersTable.tournamentId })
          .from(playersTable)
          .where(enrollmentCondition),
      );

  const [
    notificationsRow,
    announcementsRow,
    peerInvitesRow,
    noticesRow,
    feedRow,
    walletRow,
  ] = await Promise.all([
    // Handicap-committee notifications inbox unread count
    db.select({ n: count() })
      .from(handicapCaseNotificationsTable)
      .where(and(
        eq(handicapCaseNotificationsTable.subjectUserId, userId),
        isNull(handicapCaseNotificationsTable.readAt),
      ))
      .catch(() => [{ n: 0 }]),

    // Tournament announcements newer than the client's last-seen marker, across
    // every tournament the player is enrolled in. When no marker is provided
    // (first sync) every announcement counts as unread, matching the
    // pre-aggregation mobile behaviour.
    db.select({ n: count() })
      .from(tournamentAnnouncementsTable)
      .where(announcementsWhere)
      .catch(() => [{ n: 0 }]),

    // Pending peer-review invitations the user has not yet seen.
    db.select({ n: count() })
      .from(handicapCasePeerReviewsTable)
      .innerJoin(
        handicapReviewCasesTable,
        eq(handicapCasePeerReviewsTable.caseId, handicapReviewCasesTable.id),
      )
      .where(and(
        eq(handicapCasePeerReviewsTable.reviewerUserId, userId),
        isNull(handicapCasePeerReviewsTable.respondedAt),
        isNull(handicapCasePeerReviewsTable.seenAt),
        or(
          isNull(handicapCasePeerReviewsTable.expiresAt),
          gt(handicapCasePeerReviewsTable.expiresAt, now),
        ),
      ))
      .catch(() => [{ n: 0 }]),

    // Notice-board articles not yet read by the user (mirrors
    // /organizations/:orgId/notice-board/unread-count).
    orgId
      ? db.select({ n: count() })
          .from(noticeBoardArticlesTable)
          .where(and(
            eq(noticeBoardArticlesTable.organizationId, orgId),
            or(
              eq(noticeBoardArticlesTable.status, "published"),
              and(
                eq(noticeBoardArticlesTable.status, "scheduled"),
                sql`${noticeBoardArticlesTable.publishAt} <= ${now}`,
              ),
            ),
            sql`${noticeBoardArticlesTable.id} NOT IN (
              SELECT ${noticeBoardReadsTable.articleId}
              FROM ${noticeBoardReadsTable}
              WHERE ${noticeBoardReadsTable.userId} = ${userId}
            )`,
          ))
          .catch(() => [{ n: 0 }])
      : Promise.resolve([{ n: 0 }]),

    // Org feed posts published since the client's last visit.
    orgId && feedSince > 0
      ? db.select({ n: count() })
          .from(feedPostsTable)
          .where(and(
            eq(feedPostsTable.organizationId, orgId),
            eq(feedPostsTable.isHidden, false),
            gt(feedPostsTable.createdAt, new Date(feedSince)),
          ))
          .catch(() => [{ n: 0 }])
      : Promise.resolve([{ n: 0 }]),

    // Pending wallet withdrawals waiting on action.
    orgId
      ? db.select({ n: count() })
          .from(clubWalletWithdrawalsTable)
          .where(and(
            eq(clubWalletWithdrawalsTable.userId, userId),
            eq(clubWalletWithdrawalsTable.organizationId, orgId),
            inArray(clubWalletWithdrawalsTable.status, PENDING_WITHDRAWAL_STATES),
          ))
          .catch(() => [{ n: 0 }])
      : Promise.resolve([{ n: 0 }]),
  ]);

  res.json({
    notifications: Number(notificationsRow[0]?.n ?? 0),
    announcements: Number(announcementsRow[0]?.n ?? 0),
    peerInvites: Number(peerInvitesRow[0]?.n ?? 0),
    notices: Number(noticesRow[0]?.n ?? 0),
    feedSinceTs: Number(feedRow[0]?.n ?? 0),
    walletPending: Number(walletRow[0]?.n ?? 0),
  });
});

// GET /api/portal/my-leagues
router.get("/portal/my-leagues", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const userEmail = req.user!.email;
  if (!userEmail) {
    res.json([]);
    return;
  }

  const memberRows = await db
    .select({
      memberId: leagueMembersTable.id,
      leagueId: leagueMembersTable.leagueId,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      handicapIndex: leagueMembersTable.handicapIndex,
      teamName: leagueMembersTable.teamName,
      joinedAt: leagueMembersTable.joinedAt,
      paymentStatus: leagueMembersTable.paymentStatus,
      paymentLinkUrl: leagueMembersTable.paymentLinkUrl,
      leagueName: leaguesTable.name,
      leagueFormat: leaguesTable.format,
      leagueType: leaguesTable.type,
      leagueStatus: leaguesTable.status,
      leagueCurrency: leaguesTable.currency,
      leagueEntryFee: leaguesTable.entryFee,
      seasonStart: leaguesTable.seasonStart,
      seasonEnd: leaguesTable.seasonEnd,
      totalPoints: leagueStandingsTable.totalPoints,
      position: leagueStandingsTable.position,
      roundsPlayed: leagueStandingsTable.roundsPlayed,
      totalStableford: leagueStandingsTable.totalStableford,
    })
    .from(leagueMembersTable)
    .innerJoin(leaguesTable, eq(leagueMembersTable.leagueId, leaguesTable.id))
    .leftJoin(
      leagueStandingsTable,
      and(
        eq(leagueStandingsTable.leagueId, leagueMembersTable.leagueId),
        eq(leagueStandingsTable.memberId, leagueMembersTable.id),
      )
    )
    .where(
      sql`${leagueMembersTable.email} = ${userEmail} OR ${leagueMembersTable.userId} = ${req.user!.id}`
    )
    .orderBy(desc(leaguesTable.seasonStart));

  res.json(memberRows);
});

// GET /api/portal/my-scores/:tournamentId
router.get("/portal/my-scores/:tournamentId", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const tournamentId = Number((req.params as Record<string, string>).tournamentId);
  if (isNaN(tournamentId)) {
    res.status(400).json({ error: "Invalid tournament ID" });
    return;
  }

  const userEmail = req.user!.email;

  // Find the player record
  const [player] = await db
    .select()
    .from(playersTable)
    .where(
      and(
        eq(playersTable.tournamentId, tournamentId),
        sql`(${playersTable.email} = ${userEmail ?? ""} OR ${playersTable.userId} = ${req.user!.id})`
      )
    );

  if (!player) {
    res.status(404).json({ error: "You are not registered in this tournament" });
    return;
  }

  const scores = await db
    .select()
    .from(scoresTable)
    .where(eq(scoresTable.playerId, player.id))
    .orderBy(scoresTable.round, scoresTable.holeNumber);

  const [tournament] = await db
    .select({
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      rounds: tournamentsTable.rounds,
      status: tournamentsTable.status,
      organizationId: tournamentsTable.organizationId,
      selfPosting: tournamentsTable.selfPosting,
      allowSelfScoring: tournamentsTable.allowSelfScoring,
      markerValidation: tournamentsTable.markerValidation,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  res.json({
    player: {
      id: player.id,
      firstName: player.firstName,
      lastName: player.lastName,
      handicapIndex: player.handicapIndex,
      teeBox: player.teeBox,
      currentRound: player.currentRound,
    },
    tournament,
    scores,
  });
});

// GET /api/portal/my-stats
router.get("/portal/my-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const userEmail = req.user!.email;

  const players = await db
    .select({ playerId: playersTable.id })
    .from(playersTable)
    .where(
      sql`${playersTable.email} = ${userEmail ?? ""} OR ${playersTable.userId} = ${req.user!.id}`
    );

  if (players.length === 0) {
    res.json({ tournamentsPlayed: 0, totalScores: 0, averageStrokes: null, bestRound: null });
    return;
  }

  const playerIds = players.map((p) => p.playerId);

  const scoreRows = await db
    .select({
      playerId: scoresTable.playerId,
      tournamentId: scoresTable.tournamentId,
      round: scoresTable.round,
      strokes: scoresTable.strokes,
    })
    .from(scoresTable)
    .where(inArray(scoresTable.playerId, playerIds));

  const totalScores = scoreRows.length;
  const avgStrokes = totalScores > 0
    ? Math.round((scoreRows.reduce((a, b) => a + b.strokes, 0) / totalScores) * 10) / 10
    : null;

  // Group by playerId+tournamentId+round to get round totals (prevents cross-tournament collision)
  const roundMap = new Map<string, number>();
  for (const s of scoreRows) {
    const key = `${s.playerId}-${s.tournamentId}-${s.round}`;
    roundMap.set(key, (roundMap.get(key) ?? 0) + s.strokes);
  }
  const roundTotals = Array.from(roundMap.values());
  const bestRound = roundTotals.length > 0 ? Math.min(...roundTotals) : null;

  // Handicap trend (from handicap_history table, last 24 months)
  const hcpHistory = await db.select({ handicapIndex: handicapHistoryTable.handicapIndex, recordedAt: handicapHistoryTable.recordedAt })
    .from(handicapHistoryTable)
    .where(eq(handicapHistoryTable.userId, req.user!.id))
    .orderBy(asc(handicapHistoryTable.recordedAt))
    .limit(24);
  const hcpTrend = hcpHistory.map(h => ({ handicapIndex: Number(h.handicapIndex), recordedAt: h.recordedAt ? h.recordedAt.toISOString() : null }));

  // Course breakdown (join scores → tournaments → courses)
  const tids = [...new Set(scoreRows.map(s => s.tournamentId))];
  let courseBreakdown: { courseId: number; courseName: string; rounds: number; avgGross: number; bestGross: number }[] = [];
  if (tids.length > 0) {
    const tData = await db.select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId }).from(tournamentsTable).where(inArray(tournamentsTable.id, tids));
    const tcMap = new Map<number, number>();
    for (const t of tData) if (t.courseId) tcMap.set(t.id, t.courseId);
    const ucids = [...new Set(tcMap.values())];
    const cNames = ucids.length > 0 ? await db.select({ id: coursesTable.id, name: coursesTable.name }).from(coursesTable).where(inArray(coursesTable.id, ucids)) : [];
    const cNameMap = new Map(cNames.map(c => [c.id, c.name]));
    const csMap = new Map<number, { rounds: number; total: number; best: number }>();
    for (const [key, gross] of roundMap) {
      const [, tidStr] = key.split("-");
      const tid = Number(tidStr);
      const cid = tcMap.get(tid);
      if (!cid) continue;
      if (!csMap.has(cid)) csMap.set(cid, { rounds: 0, total: 0, best: Infinity });
      const cs = csMap.get(cid)!;
      cs.rounds++; cs.total += gross;
      if (gross < cs.best) cs.best = gross;
    }
    courseBreakdown = [...csMap.entries()]
      .map(([cid, cs]) => ({ courseId: cid, courseName: cNameMap.get(cid) ?? `Course ${cid}`, rounds: cs.rounds, avgGross: Math.round((cs.total / cs.rounds) * 10) / 10, bestGross: cs.best === Infinity ? 0 : cs.best }))
      .sort((a, b) => b.rounds - a.rounds);
  }

  res.json({
    tournamentsPlayed: players.length,
    totalScores,
    averageStrokes: avgStrokes,
    bestRound,
    handicapTrend: hcpTrend,
    courseBreakdown,
  });
});

// GET /api/portal/my-badges
// Returns the full badge catalog with locked/unlocked state for the signed-in user.
// Each entry carries the badge definition plus `unlocked: boolean` and (when
// unlocked) `earnedAt`. Powers the mobile "Badges" catalog screen.
router.get("/portal/my-badges", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const earnedRows = await db
    .select({ badgeType: achievementsTable.badgeType, earnedAt: achievementsTable.earnedAt })
    .from(achievementsTable)
    .where(eq(achievementsTable.userId, req.user!.id));

  // Use the earliest earnedAt per badgeType in the rare event of duplicates.
  const earnedMap = new Map<string, string>();
  for (const r of earnedRows) {
    const ts = r.earnedAt ? new Date(r.earnedAt).toISOString() : new Date().toISOString();
    const existing = earnedMap.get(r.badgeType);
    if (!existing || ts < existing) earnedMap.set(r.badgeType, ts);
  }

  // Progress hints for numeric-threshold badges (e.g. "8 of 10 career birdies").
  // Single-round achievements aren't included; their description states the
  // requirement on its own.
  const progressMap = await computeBadgeProgress(req.user!.id);

  // Task #1752 — translate the badge `label`/`description` server-side so the
  // mobile catalog screen renders titles in the player's selected language
  // across all 21 supported locales (the catalog itself is English-only).
  const badgeLang = resolveBadgeI18nLangFromReq(req);
  const badges = ALL_BADGES.map(b => {
    const localized = localizeBadge(b, badgeLang);
    return {
      ...b,
      label: localized.label,
      description: localized.description,
      unlocked: earnedMap.has(b.type),
      earnedAt: earnedMap.get(b.type) ?? null,
      progress: progressMap[b.type] ?? null,
    };
  });

  // Only count badges that exist in the current catalog so retired/legacy
  // badge rows still in the achievements table don't inflate the progress.
  const unlockedCount = badges.filter(b => b.unlocked).length;

  // Include the user's public-profile state so the mobile catalog can decide
  // whether to expose per-badge Share buttons (Task #780). Sharing requires
  // a public handle AND publicProfileEnabled AND publicShowAchievements so
  // that the resulting URL actually resolves to a public badge page.
  const [me] = await db
    .select({
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicShowAchievements: appUsersTable.publicShowAchievements,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, req.user!.id));

  const canShare = !!(me?.publicHandle && me.publicProfileEnabled && me.publicShowAchievements);

  res.json({
    badges,
    unlockedCount,
    totalCount: ALL_BADGES.length,
    publicHandle: me?.publicHandle ?? null,
    canShare,
  });
});

// ─── YEAR IN GOLF (Spotify-Wrapped-style recap) ───────────────────────────────

// GET /api/portal/year-in-golf?year=YYYY&period=year|q1|q2|q3|q4
router.get("/portal/year-in-golf", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const now = new Date();
  const yearParam = Number.parseInt(String(req.query.year ?? ""), 10);
  const year = Number.isFinite(yearParam) && yearParam >= 2000 && yearParam <= 2100 ? yearParam : now.getUTCFullYear();
  const period = parseRecapPeriod(req.query.period);
  try {
    const recap = await getCachedYearInGolf(req.user!.id, year, period);
    res.json(recap);
  } catch (err) {
    baseLogger.warn({ err, userId: req.user!.id, year, period }, "[year-in-golf] compute failed");
    res.status(500).json({ error: "Failed to build recap" });
  }
});

// GET /api/portal/year-in-golf/preferences — current opt-out state for launch pushes
router.get("/portal/year-in-golf/preferences", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const [pref] = await db.select({ preferPush: userNotificationPrefsTable.preferPush })
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, req.user!.id));
  res.json({ pushEnabled: pref?.preferPush ?? true });
});

// POST /api/portal/year-in-golf/preferences { pushEnabled: boolean }
router.post("/portal/year-in-golf/preferences", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const enabled = req.body?.pushEnabled !== false;
  await db.insert(userNotificationPrefsTable)
    .values({ userId: req.user!.id, preferPush: enabled })
    .onConflictDoUpdate({ target: userNotificationPrefsTable.userId, set: { preferPush: enabled, updatedAt: new Date() } });
  res.json({ pushEnabled: enabled });
});

// GET /api/portal/year-in-golf/card.png?year=YYYY&period=year|q1..q4&chapter=N
// Server-rendered shareable card for og:image, deep-link previews, and as
// a fallback when on-device view-shot capture is unavailable.
router.get("/portal/year-in-golf/card.png", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const now = new Date();
  const yearParam = Number.parseInt(String(req.query.year ?? ""), 10);
  const year = Number.isFinite(yearParam) && yearParam >= 2000 && yearParam <= 2100 ? yearParam : now.getUTCFullYear();
  const period = parseRecapPeriod(req.query.period);
  const chapter = Math.max(0, Number.parseInt(String(req.query.chapter ?? "0"), 10) || 0);
  try {
    const recap = await getCachedYearInGolf(req.user!.id, year, period);
    const png = renderCardPng(recap, chapter);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(png);
  } catch (err) {
    baseLogger.warn({ err, userId: req.user!.id, year, period, chapter }, "[year-in-golf] card render failed");
    res.status(500).json({ error: "Failed to render card" });
  }
});

// GET /api/portal/year-in-golf/video.mp4?year=YYYY&period=year|q1..q4
// Renders a short MP4 slideshow of all chapter cards for sharing.
router.get("/portal/year-in-golf/video.mp4", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const now = new Date();
  const yearParam = Number.parseInt(String(req.query.year ?? ""), 10);
  const year = Number.isFinite(yearParam) && yearParam >= 2000 && yearParam <= 2100 ? yearParam : now.getUTCFullYear();
  const period = parseRecapPeriod(req.query.period);
  try {
    const recap = await getCachedYearInGolf(req.user!.id, year, period);
    const mp4 = await renderRecapVideo(recap);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `inline; filename="year-in-golf-${year}-${period}.mp4"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(mp4);
  } catch (err) {
    baseLogger.warn({ err, userId: req.user!.id, year, period }, "[year-in-golf] video render failed");
    res.status(500).json({ error: "Failed to render video" });
  }
});

// Shared helper: verify authenticated marker is eligible to act on a submission
// (must be in the same tournament but NOT the player whose round is being reviewed)
// Checks BOTH userId and email to prevent self-approval when player row is unlinked (userId=null)
async function verifyMarkerEligibility(
  req: Request,
  res: Response,
  submission: { id: number; playerId: number; tournamentId: number; status: string; markerPlayerId?: number | null }
): Promise<boolean> {
  // Fetch the submitting player's identity fields
  const submittingPlayer = await db
    .select({ userId: playersTable.userId, email: playersTable.email })
    .from(playersTable)
    .where(eq(playersTable.id, submission.playerId))
    .then(rows => rows[0]);

  // Must not approve your own submission — check both userId AND email
  const markerEmail = req.user!.email ?? "";
  const isOwnSubmission =
    (submittingPlayer?.userId != null && submittingPlayer.userId === req.user!.id) ||
    (submittingPlayer?.email != null && markerEmail !== "" &&
      submittingPlayer.email.toLowerCase() === markerEmail.toLowerCase());

  if (isOwnSubmission) {
    res.status(403).json({ error: "You cannot validate your own round." });
    return false;
  }

  // Find the acting user's player record in this tournament
  const markerPlayer = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .where(
      and(
        eq(playersTable.tournamentId, submission.tournamentId),
        sql`(${playersTable.email} = ${markerEmail} OR ${playersTable.userId} = ${req.user!.id})`
      )
    )
    .then(rows => rows[0]);

  if (!markerPlayer) {
    res.status(403).json({ error: "You are not registered in this tournament and cannot validate scores." });
    return false;
  }

  // If a designated markerPlayerId is set, enforce it: only that player may countersign
  if (submission.markerPlayerId != null) {
    if (markerPlayer.id !== submission.markerPlayerId) {
      res.status(403).json({ error: "You are not the designated marker for this scorecard." });
      return false;
    }
  }

  return true;
}

// GET /api/portal/submissions/by-code/:code
// Marker enters the 6-digit code shown by the player to look up their pending submission
router.get("/portal/submissions/by-code/:code", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const { code } = (req.params as Record<string, string>);
  if (!code || code.length !== 6) { { res.status(400).json({ error: "Invalid code" }); return; } }

  const [submission] = await db
    .select({
      id: roundSubmissionsTable.id,
      playerId: roundSubmissionsTable.playerId,
      round: roundSubmissionsTable.round,
      totalStrokes: roundSubmissionsTable.totalStrokes,
      status: roundSubmissionsTable.status,
      submittedAt: roundSubmissionsTable.submittedAt,
      tournamentId: tournamentsTable.id,
      tournamentName: tournamentsTable.name,
      organizationId: tournamentsTable.organizationId,
      scoringCloseTime: tournamentsTable.scoringCloseTime,
      correctionWindowHours: tournamentsTable.correctionWindowHours,
      playerFirstName: playersTable.firstName,
      playerLastName: playersTable.lastName,
    })
    .from(roundSubmissionsTable)
    .innerJoin(playersTable, eq(playersTable.id, roundSubmissionsTable.playerId))
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, roundSubmissionsTable.tournamentId))
    .where(and(eq(roundSubmissionsTable.markerCode, code), inArray(roundSubmissionsTable.status, ["pending", "submitted"])));

  if (!submission) { { res.status(404).json({ error: "No pending submission found for this code." }); return; } }

  // Compute the correction window deadline: submittedAt + correctionWindowHours
  const correctionWindowHours = submission.correctionWindowHours ?? 24;
  const correctionDeadlineAt = submission.submittedAt
    ? new Date(new Date(submission.submittedAt).getTime() + correctionWindowHours * 60 * 60 * 1000).toISOString()
    : null;

  // Fetch hole-by-hole scores, flags, and corrections in parallel
  const [scores, flags, corrections] = await Promise.all([
    db.select({ hole: scoresTable.holeNumber, strokes: scoresTable.strokes, isVerified: scoresTable.isVerified })
      .from(scoresTable)
      .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)))
      .orderBy(scoresTable.holeNumber),
    db.select().from(scorecardFlagsTable).where(eq(scorecardFlagsTable.submissionId, submission.id)).orderBy(asc(scorecardFlagsTable.holeNumber)),
    db.select().from(scorecardCorrectionsTable).where(eq(scorecardCorrectionsTable.submissionId, submission.id)).orderBy(asc(scorecardCorrectionsTable.holeNumber)),
  ]);
  const awaitingMarkerCount = scores.reduce((n, s) => n + (s.isVerified ? 0 : 1), 0);

  res.json({
    submissionId: submission.id,
    playerName: `${submission.playerFirstName} ${submission.playerLastName}`,
    tournamentName: submission.tournamentName,
    tournamentId: submission.tournamentId,
    organizationId: submission.organizationId,
    scoringCloseTime: submission.scoringCloseTime,
    correctionWindowHours,
    correctionDeadlineAt,
    round: submission.round,
    totalStrokes: submission.totalStrokes,
    status: submission.status,
    submittedAt: submission.submittedAt,
    markerCode: null,
    awaitingMarkerCount,
    scores: scores.map(s => ({ ...s, awaitingMarker: !s.isVerified })),
    flags,
    corrections,
  });
});

// GET /api/portal/my-submission-status/:tournamentId/:round
// Player checks the status of their own round submission
router.get("/portal/my-submission-status/:tournamentId/:round", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const round = parseInt(String((req.params as Record<string, string>).round));

  const userEmail = req.user!.email ?? "";
  const [player] = await db.select().from(playersTable)
    .where(and(
      eq(playersTable.tournamentId, tournamentId),
      sql`(${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${req.user!.id})`
    ));

  if (!player) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable)
    .where(and(eq(roundSubmissionsTable.playerId, player.id), eq(roundSubmissionsTable.round, round)));

  if (!submission) { { res.json({ status: "not_submitted" }); return; } }

  // Fetch ext record and corrections in parallel
  const [ext, corrections, flags] = await Promise.all([
    db.select().from(roundSubmissionsExtTable).where(eq(roundSubmissionsExtTable.submissionId, submission.id)).then(r => r[0] ?? null),
    db.select().from(scorecardCorrectionsTable).where(eq(scorecardCorrectionsTable.submissionId, submission.id)).orderBy(asc(scorecardCorrectionsTable.holeNumber)),
    db.select().from(scorecardFlagsTable).where(eq(scorecardFlagsTable.submissionId, submission.id)).orderBy(asc(scorecardFlagsTable.holeNumber)),
  ]);

  res.json({
    submissionId: submission.id,
    status: submission.status,
    totalStrokes: submission.totalStrokes,
    submittedAt: submission.submittedAt,
    reviewedAt: submission.reviewedAt,
    rejectionReason: submission.rejectionReason,
    markerCode: ["pending", "submitted"].includes(submission.status) ? submission.markerCode : null,
    countersignedAt: ext?.countersignedAt ?? null,
    disputeNote: ext?.disputeNote ?? null,
    committeeOverrideNote: ext?.committeeOverrideNote ?? null,
    committeeOverrideAt: ext?.committeeOverrideAt ?? null,
    deadlineAt: ext?.deadlineAt ?? null,
    corrections,
    flags,
  });
});

// POST /api/portal/submissions/:submissionId/approve
// Authenticated marker approves the round — bearer token required, object-level auth enforced
router.post("/portal/submissions/:submissionId/approve", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable)
    .where(eq(roundSubmissionsTable.id, submissionId));

  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }
  // WHS two-step ceremony: marker can only act after player has signed (status = submitted)
  if (submission.status !== "submitted") { { res.status(400).json({ error: submission.status === "pending" ? "Player must sign the scorecard first (Step 1) before marker can countersign." : `Submission already ${submission.status}` }); return; } }

  if (!await verifyMarkerEligibility(req, res, submission)) return;

  await db.update(roundSubmissionsTable)
    .set({ status: "countersigned", reviewedAt: new Date(), markerCode: null })
    .where(eq(roundSubmissionsTable.id, submissionId));

  await db.update(scoresTable)
    .set({ isVerified: true, updatedAt: new Date() })
    .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));

  // Task #870 — alert TDs when this round closed mostly hand-entered.
  // Independent of whether the player has a linked app account.
  notifyManualEntryRound(submissionId).catch((err) => baseLogger.warn({ err, submissionId }, "[portal] manual-entry notify failed (non-blocking)"));

  // Push notification to player: score verified
  const [player] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, submission.playerId));
  if (player?.userId) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush([player.userId], "✅ Round Verified", `Your round ${submission.round} scorecard has been counter-signed by your marker.`, { type: "score_approved", submissionId }).catch(() => {});
    // Task #484 — push transient hole_verified event to the paired watch so the
    // "Awaiting marker" indicator clears immediately + the watch buzzes once.
    notifyWatchHoleVerified(player.userId, { round: submission.round, submissionId });
  }

  // WHS Gap 6: trigger handicap recalculation on marker approval — never on player-only submission.
  if (player?.userId) {
    const approveNow = new Date();
    (async () => {
      try {
        const [t] = await db.select({
          organizationId: tournamentsTable.organizationId,
          courseId: tournamentsTable.courseId,
          startDate: tournamentsTable.startDate,
        }).from(tournamentsTable).where(eq(tournamentsTable.id, submission.tournamentId));

        const [course] = t?.courseId
          ? await db.select({ rating: coursesTable.rating, slope: coursesTable.slope }).from(coursesTable).where(eq(coursesTable.id, t.courseId))
          : [];

        const holeScores = await db.select({ strokes: scoresTable.strokes })
          .from(scoresTable)
          .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));

        const grossScore = holeScores.reduce((s, h) => s + h.strokes, 0);

        if (t && grossScore > 0) {
          const courseRating = course?.rating ? Number(course.rating) : 72;
          const slopeRating = course?.slope ?? 113;
          const playedAt = t.startDate ?? approveNow;
          const pcc = await getPccForCourseDate(t.courseId!, playedAt).catch(() => 0);
          const markerName = (req.user as { displayName?: string; username?: string })?.displayName
            ?? (req.user as { username?: string })?.username
            ?? "Marker";

          await postScoreAndRecalculate({
            userId: player.userId!,
            organizationId: t.organizationId,
            courseId: t.courseId!,
            sourceType: "tournament",
            sourceTournamentId: submission.tournamentId,
            holesPlayed: holeScores.length,
            grossScore,
            adjustedGrossScore: grossScore,
            courseRating,
            slopeRating,
            pcc,
            markerName,
            markerGhinNumber: null,
            playedAt,
          });
        }
      } catch (err) {
        baseLogger.warn({ err, submissionId }, "[portal] approve WHS recalc failed (non-blocking)");
      }
    })();
  }

  res.json({ success: true, message: "Round counter-signed. Scores are now verified." });
});

// POST /api/portal/submissions/:submissionId/reject
// Authenticated marker rejects the round — bearer token required, object-level auth enforced
router.post("/portal/submissions/:submissionId/reject", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const { reason } = req.body as { reason?: string };

  const [submission] = await db.select().from(roundSubmissionsTable)
    .where(eq(roundSubmissionsTable.id, submissionId));

  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }
  // WHS two-step ceremony: marker can only act after player has signed (status = submitted)
  if (submission.status !== "submitted") { { res.status(400).json({ error: submission.status === "pending" ? "Player must sign the scorecard first (Step 1) before marker can dispute." : `Submission already ${submission.status}` }); return; } }

  if (!await verifyMarkerEligibility(req, res, submission)) return;

  const rejectionReason = reason ?? "Marker did not agree with the score";

  await db.update(roundSubmissionsTable)
    .set({ status: "disputed", reviewedAt: new Date(), rejectionReason, markerCode: null })
    .where(eq(roundSubmissionsTable.id, submissionId));

  // Push notification to player: score rejected
  const [rejectedPlayer] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, submission.playerId));
  if (rejectedPlayer?.userId) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush([rejectedPlayer.userId], "❌ Round Disputed", `Your round ${submission.round} scorecard was disputed. Reason: ${rejectionReason}`, { type: "score_rejected", submissionId }).catch(() => {});
    // Task #637 — paired watch buzz + show reason instantly so the player can
    // correct disputed holes before leaving the green, instead of waiting for
    // the next 30 s periodic refresh.
    notifyWatchHoleRejected(rejectedPlayer.userId, { round: submission.round, submissionId, reason: rejectionReason });
  }

  res.json({ success: true, message: "Round rejected." });
});

// POST /api/portal/submissions/:submissionId/countersign
// Authenticated marker formally counter-signs (approves) the round and stores the ext record
router.post("/portal/submissions/:submissionId/countersign", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }
  // WHS two-step ceremony: marker can only countersign after player has signed (status = submitted)
  if (submission.status !== "submitted") { { res.status(400).json({ error: submission.status === "pending" ? "Player must sign the scorecard first (Step 1) before marker can countersign." : `Submission already ${submission.status}` }); return; } }
  if (!await verifyMarkerEligibility(req, res, submission)) return;

  const now = new Date();
  await db.update(roundSubmissionsTable).set({ status: "countersigned", reviewedAt: now, markerCode: null }).where(eq(roundSubmissionsTable.id, submissionId));
  await db.update(scoresTable).set({ isVerified: true, updatedAt: now }).where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));

  // Task #870 — alert TDs when this round closed mostly hand-entered.
  // Independent of whether the player has a linked app account.
  notifyManualEntryRound(submissionId).catch((err) => baseLogger.warn({ err, submissionId }, "[portal] manual-entry notify failed (non-blocking)"));

  // Upsert ext record with countersignedAt + markerUserId
  const [existingExt] = await db.select().from(roundSubmissionsExtTable).where(eq(roundSubmissionsExtTable.submissionId, submissionId));
  if (existingExt) {
    await db.update(roundSubmissionsExtTable).set({ countersignedAt: now, markerUserId: req.user!.id }).where(eq(roundSubmissionsExtTable.submissionId, submissionId));
  } else {
    await db.insert(roundSubmissionsExtTable).values({ submissionId, countersignedAt: now, markerUserId: req.user!.id });
  }

  const [player] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, submission.playerId));
  if (player?.userId) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush([player.userId], "✅ Scorecard Counter-Signed", `Your round ${submission.round} scorecard has been counter-signed by your marker.`, { type: "score_approved", submissionId }).catch(() => {});
    // Task #484 — paired watch buzz + clear awaiting indicator instantly.
    notifyWatchHoleVerified(player.userId, { round: submission.round, submissionId });
  }

  // WHS Gap 6: trigger handicap recalculation ONLY on marker countersign — never on player-only submission.
  // This is the tournament equivalent of the general-play countersign recalc trigger.
  if (player?.userId) {
    (async () => {
      try {
        const [t] = await db.select({
          organizationId: tournamentsTable.organizationId,
          courseId: tournamentsTable.courseId,
          startDate: tournamentsTable.startDate,
        }).from(tournamentsTable).where(eq(tournamentsTable.id, submission.tournamentId));

        const [course] = t?.courseId
          ? await db.select({ rating: coursesTable.rating, slope: coursesTable.slope }).from(coursesTable).where(eq(coursesTable.id, t.courseId))
          : [];

        const holeScores = await db.select({ strokes: scoresTable.strokes })
          .from(scoresTable)
          .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));

        const grossScore = holeScores.reduce((s, h) => s + h.strokes, 0);

        if (t && grossScore > 0) {
          const courseRating = course?.rating ? Number(course.rating) : 72;
          const slopeRating = course?.slope ?? 113;
          const playedAt = t.startDate ?? now;
          const pcc = await getPccForCourseDate(t.courseId!, playedAt).catch(() => 0);
          const markerName = (req.user as { displayName?: string; username?: string; email?: string })?.displayName
            ?? (req.user as { username?: string })?.username
            ?? "Marker";

          await postScoreAndRecalculate({
            userId: player.userId!,
            organizationId: t.organizationId,
            courseId: t.courseId!,
            sourceType: "tournament",
            sourceTournamentId: submission.tournamentId,
            holesPlayed: holeScores.length,
            grossScore,
            adjustedGrossScore: grossScore,
            courseRating,
            slopeRating,
            pcc,
            markerName,
            markerGhinNumber: null,
            playedAt,
          });
        }
      } catch (err) {
        baseLogger.warn({ err, submissionId }, "[portal] countersign WHS recalc failed (non-blocking)");
      }
    })();
  }

  res.json({ success: true, message: "Scorecard counter-signed. Scores are verified." });
});

// POST /api/portal/submissions/:submissionId/scores/:holeNumber/verify
// Authenticated marker confirms ONE individual hole (per Task #483).
// Lets the marker tap a single unverified hole row in the review modal to flip
// is_verified=true on just that score, without countersigning the entire round.
// Useful when a player has a few late-arriving offline scores still showing the
// awaiting-marker indicator.
router.post("/portal/submissions/:submissionId/scores/:holeNumber/verify", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId), 10);
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber), 10);
  if (isNaN(submissionId) || isNaN(holeNumber) || holeNumber < 1 || holeNumber > 18) {
    res.status(400).json({ error: "Invalid submission or hole number" }); return;
  }

  const [submission] = await db.select().from(roundSubmissionsTable)
    .where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }

  // Per-hole verify is only meaningful while the round is still open. Once the
  // card is countersigned/disputed/overridden the scores are locked.
  if (!["pending", "submitted"].includes(submission.status)) {
    res.status(400).json({ error: `Submission already ${submission.status} — per-hole verification is no longer allowed.` });
    return;
  }

  if (!await verifyMarkerEligibility(req, res, submission)) return;

  // Find the existing score row for this player+round+hole
  const [existing] = await db.select({
    id: scoresTable.id,
    isVerified: scoresTable.isVerified,
    strokes: scoresTable.strokes,
    tournamentId: scoresTable.tournamentId,
  }).from(scoresTable).where(and(
    eq(scoresTable.playerId, submission.playerId),
    eq(scoresTable.round, submission.round),
    eq(scoresTable.holeNumber, holeNumber),
  ));
  if (!existing) { { res.status(404).json({ error: "No score recorded for that hole yet." }); return; } }

  if (existing.isVerified) {
    res.json({ ok: true, holeNumber, alreadyVerified: true });
    return;
  }

  const now = new Date();
  await db.update(scoresTable)
    .set({ isVerified: true, updatedAt: now })
    .where(eq(scoresTable.id, existing.id));

  // Broadcast so phone/watch live views refresh without the marker having to
  // countersign the whole round. Reuses the existing hole_score_entered event
  // shape — clients re-render the row and clear the awaiting-marker indicator.
  try {
    const [playerRow] = await db.select({ firstName: playersTable.firstName, lastName: playersTable.lastName })
      .from(playersTable).where(eq(playersTable.id, submission.playerId));
    if (playerRow) {
      const scoreEvent = {
        tournamentId: submission.tournamentId,
        playerId: submission.playerId,
        round: submission.round,
        holeNumber,
        strokes: existing.strokes,
        playerName: `${playerRow.firstName} ${playerRow.lastName}`,
        occurredAt: now.toISOString(),
      };
      notifyHoleScoreEntered(submission.tournamentId, scoreEvent);
      if (submission.markerShareToken && submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt > now) {
        notifyMarkerLiveScore(submission.markerShareToken, scoreEvent);
      }
    }
  } catch { /* non-fatal */ }

  res.json({ ok: true, holeNumber, verified: true });
});

// POST /api/portal/submissions/:submissionId/live-token
// Authenticated player generates (or retrieves) a short-lived marker share token for their submission.
// Returns the full shareable URL the marker can open without logging in.
router.post("/portal/submissions/:submissionId/live-token", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }

  // Verify the caller is the player who owns the submission
  const userEmail = req.user!.email ?? "";
  const [player] = await db.select({ userId: playersTable.userId, email: playersTable.email })
    .from(playersTable).where(eq(playersTable.id, submission.playerId));
  const isOwner =
    (player?.userId != null && player.userId === req.user!.id) ||
    (player?.email != null && userEmail !== "" && player.email.toLowerCase() === userEmail.toLowerCase());
  if (!isOwner) { { res.status(403).json({ error: "Forbidden" }); return; } }

  // If a non-expired token already exists, reuse it
  const now = new Date();
  if (submission.markerShareToken && submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt > now) {
    const shareUrl = `https://app.kharagolf.com/portal/marker-live/${submission.markerShareToken}`;
    res.json({ token: submission.markerShareToken, shareUrl });
    return;
  }

  // Generate a fresh 32-byte hex token (64 chars) and set 24h TTL
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await db.update(roundSubmissionsTable)
    .set({ markerShareToken: token, markerShareTokenExpiresAt: expiresAt })
    .where(eq(roundSubmissionsTable.id, submissionId));

  const shareUrl = `https://app.kharagolf.com/portal/marker-live/${token}`;
  res.json({ token, shareUrl });
});

// NOTE: Public marker live view endpoints (GET /api/marker-live/:token, POST /api/marker-live/:token/countersign,
// GET /api/marker-live/:token/stream) are in routes/marker-live.ts, registered BEFORE any auth middleware
// so the marker can access them without a session. Do not add them here.

// POST /api/portal/scoring/live-share
// Mobile-friendly endpoint: authenticated player gets a share token for their active round.
// Finds or creates the round submission and returns the shareable marker live view URL.
// No gate — works independently of whsScoring plan gate so scoring screen can call it.
router.post("/portal/scoring/live-share", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const { tournamentId, round = 1 } = req.body as { tournamentId?: number; round?: number };
  if (!tournamentId) { { res.status(400).json({ error: "tournamentId required" }); return; } }

  // Find player record for the authenticated user in this tournament
  const userEmail = req.user!.email ?? "";
  const [player] = await db.select({ id: playersTable.id })
    .from(playersTable)
    .where(and(
      eq(playersTable.tournamentId, tournamentId),
      sql`(${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${req.user!.id})`
    ));
  if (!player) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

  // Find or create the round submission
  let [submission] = await db.select().from(roundSubmissionsTable)
    .where(and(eq(roundSubmissionsTable.playerId, player.id), eq(roundSubmissionsTable.round, round)));

  if (!submission) {
    const [created] = await db.insert(roundSubmissionsTable)
      .values({ tournamentId, playerId: player.id, round, status: "pending" })
      .returning();
    submission = created;
  }

  if (!submission) { { res.status(500).json({ error: "Failed to create submission" }); return; } }

  // Don't allow for finalised rounds
  if (["countersigned", "disputed"].includes(submission.status)) {
    res.status(409).json({ error: `Round is already ${submission.status} — live sharing is not available` }); return;
  }

  // If a non-expired token already exists, reuse it
  const now = new Date();
  if (submission.markerShareToken && submission.markerShareTokenExpiresAt && submission.markerShareTokenExpiresAt > now) {
    const shareUrl = `https://app.kharagolf.com/portal/marker-live/${submission.markerShareToken}`;
    res.json({ token: submission.markerShareToken, shareUrl });
    return;
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await db.update(roundSubmissionsTable)
    .set({ markerShareToken: token, markerShareTokenExpiresAt: expiresAt })
    .where(eq(roundSubmissionsTable.id, submission.id));

  const shareUrl = `https://app.kharagolf.com/portal/marker-live/${token}`;
  res.json({ token, shareUrl });
});

// POST /api/portal/submissions/:submissionId/dispute
// Authenticated marker disputes the round with optional hole-level notes
router.post("/portal/submissions/:submissionId/dispute", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const { note, holes } = req.body as { note?: string; holes?: { holeNumber: number; markerNote: string }[] };

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }
  // WHS two-step ceremony: marker can only dispute after player has signed (status = submitted)
  if (submission.status !== "submitted") { { res.status(400).json({ error: submission.status === "pending" ? "Player must sign the scorecard first (Step 1) before marker can dispute." : `Submission already ${submission.status}` }); return; } }
  if (!await verifyMarkerEligibility(req, res, submission)) return;

  const disputeNote = note ?? "Marker raised a dispute with this scorecard";
  const now = new Date();
  await db.update(roundSubmissionsTable).set({ status: "disputed", reviewedAt: now, rejectionReason: disputeNote, markerCode: null }).where(eq(roundSubmissionsTable.id, submissionId));

  // Upsert ext record
  const [existingExt] = await db.select().from(roundSubmissionsExtTable).where(eq(roundSubmissionsExtTable.submissionId, submissionId));
  if (existingExt) {
    await db.update(roundSubmissionsExtTable).set({ disputeNote, markerUserId: req.user!.id }).where(eq(roundSubmissionsExtTable.submissionId, submissionId));
  } else {
    await db.insert(roundSubmissionsExtTable).values({ submissionId, disputeNote, markerUserId: req.user!.id });
  }

  // Insert per-hole flags if provided
  if (holes && holes.length > 0) {
    for (const h of holes) {
      if (!h.holeNumber || !h.markerNote) continue;
      await db.insert(scorecardFlagsTable).values({ submissionId, holeNumber: h.holeNumber, markerNote: h.markerNote }).catch(() => {});
    }
  }

  const [disputedPlayer] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, submission.playerId));
  if (disputedPlayer?.userId) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush([disputedPlayer.userId], "⚠️ Scorecard Disputed", `Your round ${submission.round} scorecard was disputed. Reason: ${disputeNote}`, { type: "score_rejected", submissionId }).catch(() => {});
    // Task #637 — paired watch buzz + flagged holes instantly so the player
    // sees which holes the marker disputed without waiting for a refresh.
    const flaggedHoleNumbers = (holes ?? []).map((h) => h.holeNumber).filter((n): n is number => typeof n === "number" && n > 0);
    notifyWatchHoleRejected(disputedPlayer.userId, { round: submission.round, submissionId, reason: disputeNote, holes: flaggedHoleNumbers });
  }
  res.json({ success: true, message: "Scorecard disputed." });
});

// GET /api/portal/submissions/:submissionId/corrections
router.get("/portal/submissions/:submissionId/corrections", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const corrections = await db.select().from(scorecardCorrectionsTable).where(eq(scorecardCorrectionsTable.submissionId, submissionId)).orderBy(asc(scorecardCorrectionsTable.holeNumber));
  res.json(corrections);
});

// POST /api/portal/submissions/:submissionId/corrections
// Player requests a score correction on a specific hole
router.post("/portal/submissions/:submissionId/corrections", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const { holeNumber, requestedScore, reason } = req.body as { holeNumber?: number; requestedScore?: number; reason?: string };
  if (!holeNumber || !requestedScore) { { res.status(400).json({ error: "holeNumber and requestedScore required" }); return; } }

  const [submission] = await db.select({ playerId: roundSubmissionsTable.playerId, status: roundSubmissionsTable.status, round: roundSubmissionsTable.round })
    .from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }

  // Corrections only allowed in the narrow window between player sign and marker countersign
  if (submission.status !== "submitted") {
    res.status(400).json({ error: `Corrections can only be requested for scorecards in 'submitted' status (awaiting marker countersign). Current status: ${submission.status}` }); return;
  }

  // Only the player themselves or an admin can request corrections
  const userEmail = req.user!.email ?? "";
  const [player] = await db.select({ userId: playersTable.userId, email: playersTable.email }).from(playersTable).where(eq(playersTable.id, submission.playerId));
  const isOwner = (player?.userId === req.user!.id) || (player?.email?.toLowerCase() === userEmail.toLowerCase());
  if (!isOwner) { { res.status(403).json({ error: "Only the player can request corrections" }); return; } }

  // Get original score from scores table
  const [originalScore] = await db.select({ strokes: scoresTable.strokes }).from(scoresTable).where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round), eq(scoresTable.holeNumber, holeNumber)));

  const correction = await db.insert(scorecardCorrectionsTable).values({
    submissionId,
    holeNumber,
    originalScore: originalScore?.strokes ?? 0,
    requestedScore,
    reason,
  }).returning();

  res.json({ success: true, correction: correction[0] });
});

// POST /api/portal/submissions/:submissionId/corrections/:corrId/decide
// Marker decides on a player's correction request
router.post("/portal/submissions/:submissionId/corrections/:corrId/decide", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  const corrId = parseInt(String((req.params as Record<string, string>).corrId));
  if (isNaN(submissionId) || isNaN(corrId)) { { res.status(400).json({ error: "Invalid IDs" }); return; } }

  const { decision } = req.body as { decision?: "accepted" | "rejected" };
  if (!decision || !["accepted", "rejected"].includes(decision)) { { res.status(400).json({ error: "decision must be 'accepted' or 'rejected'" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }
  // Correction decisions only allowed while scorecard is awaiting countersign (status = submitted)
  // After countersign/dispute/override the card is locked — no further score mutations allowed
  if (submission.status !== "submitted") {
    res.status(400).json({ error: `Correction decisions are only allowed for scorecards awaiting marker countersign (status 'submitted'). Current status: ${submission.status}` });
    return;
  }
  if (!await verifyMarkerEligibility(req, res, submission)) return;

  const [correction] = await db.select().from(scorecardCorrectionsTable).where(and(eq(scorecardCorrectionsTable.id, corrId), eq(scorecardCorrectionsTable.submissionId, submissionId)));
  if (!correction) { { res.status(404).json({ error: "Correction not found" }); return; } }

  // Prevent re-deciding an already decided correction
  if (correction.markerDecision != null) {
    res.status(409).json({ error: `Correction already decided: ${correction.markerDecision}` });
    return;
  }

  const now = new Date();
  await db.update(scorecardCorrectionsTable).set({ markerDecision: decision, decidedAt: now }).where(eq(scorecardCorrectionsTable.id, corrId));

  // If accepted, update the actual score on the scores table (still within submitted window — card not yet countersigned)
  if (decision === "accepted") {
    await db.update(scoresTable).set({ strokes: correction.requestedScore, updatedAt: now })
      .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round), eq(scoresTable.holeNumber, correction.holeNumber)));
  }

  res.json({ success: true, decision });
});

// POST /api/portal/submissions/:submissionId/flags
// Marker flags a specific hole during or after the round
router.post("/portal/submissions/:submissionId/flags", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const { holeNumber, markerNote } = req.body as { holeNumber?: number; markerNote?: string };
  if (!holeNumber) { { res.status(400).json({ error: "holeNumber required" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }
  if (!await verifyMarkerEligibility(req, res, submission)) return;

  const [flag] = await db.insert(scorecardFlagsTable).values({ submissionId, holeNumber, markerNote }).returning();
  res.json({ success: true, flag });
});

// POST /api/portal/submissions/:submissionId/flag-hole
// Marker flags a hole IN-ROUND with immediate push notification to the player
// Spec: distinct from /flags (which is bulk/post-round). This fires real-time alert.
router.post("/portal/submissions/:submissionId/flag-hole", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const { holeNumber, markerNote } = req.body as { holeNumber?: number; markerNote?: string };
  if (!holeNumber) { { res.status(400).json({ error: "holeNumber required" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }
  if (!await verifyMarkerEligibility(req, res, submission)) return;

  // Insert the flag record
  const [flag] = await db.insert(scorecardFlagsTable).values({ submissionId, holeNumber, markerNote }).returning();

  // Immediately alert the player via push notification
  const [player] = await db.select({ userId: playersTable.userId, firstName: playersTable.firstName })
    .from(playersTable).where(eq(playersTable.id, submission.playerId));
  if (player?.userId) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush(
      [player.userId],
      `⚠️ Hole ${holeNumber} Flagged by Your Marker`,
      markerNote ? `Your marker noted: "${markerNote}"` : `Your marker has flagged hole ${holeNumber} for review.`,
      { type: "flag_hole", submissionId: String(submissionId), holeNumber: String(holeNumber) },
    ).catch(() => {});
  }

  res.json({ success: true, flag });
});

// POST /api/portal/submissions/:submissionId/override
// Committee override for disputed/outstanding submissions (requires org_admin or tournament_admin)
router.post("/portal/submissions/:submissionId/override", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const { action, note } = req.body as { action?: "approved" | "rejected" | "overridden" | "outstanding"; note?: string };
  if (!action || !["approved", "rejected", "overridden", "outstanding"].includes(action)) { { res.status(400).json({ error: "action must be 'approved', 'rejected', 'overridden', or 'outstanding'" }); return; } }
  // Mandatory audit note for all committee overrides — required for WHS audit trail
  if (!note || !note.trim()) { { res.status(400).json({ error: "note is required for committee override. Provide a reason for the audit trail." }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }

  // Must be platform admin OR org-scoped admin/director for the tournament's organization
  // Fetch the tournament to resolve organizationId for scoped membership check
  const [tournament] = await db.select({ organizationId: tournamentsTable.organizationId }).from(tournamentsTable).where(eq(tournamentsTable.id, submission.tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const userRole = req.user!.role as string;
  if (userRole !== "admin" && userRole !== "super_admin") {
    // Check that the user has an appropriate role in this specific organization
    const [orgMember] = await db.select().from(orgMembershipsTable).where(
      and(
        eq(orgMembershipsTable.userId, req.user!.id),
        eq(orgMembershipsTable.organizationId, tournament.organizationId),
        inArray(orgMembershipsTable.role, ["org_admin", "tournament_director", "committee_member", "competition_secretary"]),
      )
    );
    if (!orgMember) { { res.status(403).json({ error: "Committee override requires org admin privileges for this tournament's organization" }); return; } }
  }

  const now = new Date();
  // Map legacy action names to proper status codes
  const statusMap: Record<string, string> = { approved: "overridden", rejected: "outstanding", overridden: "overridden", outstanding: "outstanding" };
  const newStatus = statusMap[action] ?? action;
  await db.update(roundSubmissionsTable).set({ status: newStatus, reviewedAt: now, markerCode: null }).where(eq(roundSubmissionsTable.id, submissionId));

  // Committee approval/override also verifies the scores
  if (action === "approved" || action === "overridden") {
    await db.update(scoresTable).set({ isVerified: true, updatedAt: now }).where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));
  }

  const overrideNote = note!.trim();
  const [existingExt] = await db.select().from(roundSubmissionsExtTable).where(eq(roundSubmissionsExtTable.submissionId, submissionId));
  if (existingExt) {
    await db.update(roundSubmissionsExtTable).set({ committeeOverrideNote: overrideNote, committeeOverrideByUserId: req.user!.id, committeeOverrideAt: now }).where(eq(roundSubmissionsExtTable.submissionId, submissionId));
  } else {
    await db.insert(roundSubmissionsExtTable).values({ submissionId, committeeOverrideNote: overrideNote, committeeOverrideByUserId: req.user!.id, committeeOverrideAt: now });
  }

  const [overriddenPlayer] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, submission.playerId));
  if (overriddenPlayer?.userId) {
    const pushTitle = (action === "approved" || action === "overridden") ? "✅ Scorecard Approved (Committee)" : "⚠️ Scorecard Flagged (Committee)";
    const pushBody = `Your round ${submission.round} scorecard was overridden by the committee. ${overrideNote}`;
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush([overriddenPlayer.userId], pushTitle, pushBody, { type: "committee_override", submissionId }).catch(() => {});
    // Task #484 — committee approval also verifies scores; nudge the watch.
    if (action === "approved" || action === "overridden") {
      notifyWatchHoleVerified(overriddenPlayer.userId, { round: submission.round, submissionId });
    }
  }

  // WHS Gap 6: trigger handicap recalculation on committee approval/override — never on player-only submission.
  // Only fire for approving actions; "rejected"/"outstanding" do not certify the score.
  if ((action === "approved" || action === "overridden") && overriddenPlayer?.userId) {
    (async () => {
      try {
        const [t] = await db.select({
          organizationId: tournamentsTable.organizationId,
          courseId: tournamentsTable.courseId,
          startDate: tournamentsTable.startDate,
        }).from(tournamentsTable).where(eq(tournamentsTable.id, submission.tournamentId));

        const [course] = t?.courseId
          ? await db.select({ rating: coursesTable.rating, slope: coursesTable.slope }).from(coursesTable).where(eq(coursesTable.id, t.courseId))
          : [];

        const holeScores = await db.select({ strokes: scoresTable.strokes })
          .from(scoresTable)
          .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));

        const grossScore = holeScores.reduce((s, h) => s + h.strokes, 0);

        if (t && grossScore > 0) {
          const courseRating = course?.rating ? Number(course.rating) : 72;
          const slopeRating = course?.slope ?? 113;
          const playedAt = t.startDate ?? now;
          const pcc = await getPccForCourseDate(t.courseId!, playedAt).catch(() => 0);

          await postScoreAndRecalculate({
            userId: overriddenPlayer.userId!,
            organizationId: t.organizationId,
            courseId: t.courseId!,
            sourceType: "tournament",
            sourceTournamentId: submission.tournamentId,
            holesPlayed: holeScores.length,
            grossScore,
            adjustedGrossScore: grossScore,
            courseRating,
            slopeRating,
            pcc,
            markerName: `[Committee override — ${overrideNote.slice(0, 60)}]`,
            markerGhinNumber: null,
            playedAt,
          });
        }
      } catch (err) {
        baseLogger.warn({ err, submissionId }, "[portal] committee override WHS recalc failed (non-blocking)");
      }
    })();
  }

  res.json({ success: true, action: newStatus, message: `Scorecard ${newStatus} by committee override.` });
});

// GET /api/portal/pending-submissions
// Marker authentication: returns pending/submitted submissions in tournaments the portal user is registered in
router.get("/portal/pending-submissions", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const userEmail = req.user!.email;

  // Find tournaments this user is registered in
  const myPlayers = await db
    .select({ tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(
      sql`${playersTable.email} = ${userEmail ?? ""} OR ${playersTable.userId} = ${req.user!.id}`
    );

  if (myPlayers.length === 0) {
    res.json([]);
    return;
  }

  const tournamentIds = myPlayers.map((p) => p.tournamentId);

  // Find pending/submitted submissions in those tournaments (excluding the user's own submissions)
  const submissions = await db
    .select({
      id: roundSubmissionsTable.id,
      playerId: roundSubmissionsTable.playerId,
      round: roundSubmissionsTable.round,
      totalStrokes: roundSubmissionsTable.totalStrokes,
      markerCode: roundSubmissionsTable.markerCode,
      status: roundSubmissionsTable.status,
      submittedAt: roundSubmissionsTable.submittedAt,
      tournamentName: tournamentsTable.name,
      tournamentId: tournamentsTable.id,
      organizationId: tournamentsTable.organizationId,
      scoringCloseTime: tournamentsTable.scoringCloseTime,
      correctionWindowHours: tournamentsTable.correctionWindowHours,
      playerFirstName: playersTable.firstName,
      playerLastName: playersTable.lastName,
      markerPlayerId: roundSubmissionsTable.markerPlayerId,
    })
    .from(roundSubmissionsTable)
    .innerJoin(playersTable, eq(playersTable.id, roundSubmissionsTable.playerId))
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, playersTable.tournamentId))
    .where(
      and(
        // Only submitted cards: player has signed (Step 1), marker action pending (Step 2)
        eq(roundSubmissionsTable.status, "submitted"),
        inArray(playersTable.tournamentId, tournamentIds),
        // Exclude the user's own submissions
        sql`(${playersTable.email} != ${userEmail ?? ""} AND ${playersTable.userId} IS DISTINCT FROM ${req.user!.id})`
      )
    )
    .orderBy(desc(roundSubmissionsTable.submittedAt));

  // Find the acting user's player IDs across all relevant tournaments (for markerPlayerId check)
  const myPlayerRows = await db
    .select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(
      and(
        inArray(playersTable.tournamentId, tournamentIds),
        sql`(${playersTable.email} = ${userEmail ?? ""} OR ${playersTable.userId} = ${req.user!.id})`
      )
    );
  const myPlayerIdByTournament: Record<number, number> = {};
  for (const p of myPlayerRows) myPlayerIdByTournament[p.tournamentId] = p.id;

  // Filter: only show submissions where user is designated marker OR no marker is designated
  const eligibleSubmissions = submissions.filter(sub => {
    if (sub.markerPlayerId == null) return true; // open to any tournament-mate
    const myPlayerId = myPlayerIdByTournament[sub.tournamentId];
    return myPlayerId != null && myPlayerId === sub.markerPlayerId;
  });

  // For each submission, fetch the hole-by-hole scores, flags, and corrections
  const result = await Promise.all(eligibleSubmissions.map(async (sub) => {
    const [scores, flags, corrections] = await Promise.all([
      db.select({ hole: scoresTable.holeNumber, strokes: scoresTable.strokes, isVerified: scoresTable.isVerified })
        .from(scoresTable)
        .where(and(eq(scoresTable.playerId, sub.playerId), eq(scoresTable.round, sub.round)))
        .orderBy(scoresTable.holeNumber),
      db.select().from(scorecardFlagsTable).where(eq(scorecardFlagsTable.submissionId, sub.id)).orderBy(asc(scorecardFlagsTable.holeNumber)),
      db.select().from(scorecardCorrectionsTable).where(eq(scorecardCorrectionsTable.submissionId, sub.id)).orderBy(asc(scorecardCorrectionsTable.holeNumber)),
    ]);

    const windowHours = sub.correctionWindowHours ?? 24;
    const correctionDeadlineAt = sub.submittedAt
      ? new Date(new Date(sub.submittedAt).getTime() + windowHours * 60 * 60 * 1000).toISOString()
      : null;

    return {
      submissionId: sub.id,
      playerName: `${sub.playerFirstName} ${sub.playerLastName}`,
      tournamentName: sub.tournamentName,
      tournamentId: sub.tournamentId,
      organizationId: sub.organizationId,
      scoringCloseTime: sub.scoringCloseTime,
      correctionWindowHours: windowHours,
      correctionDeadlineAt,
      round: sub.round,
      totalStrokes: sub.totalStrokes,
      markerCode: ["pending", "submitted"].includes(sub.status) ? sub.markerCode : null,
      status: sub.status,
      submittedAt: sub.submittedAt,
      awaitingMarkerCount: scores.reduce((n, s) => n + (s.isVerified ? 0 : 1), 0),
      scores: scores.map(s => ({ ...s, awaitingMarker: !s.isVerified })),
      flags,
      corrections,
    };
  }));

  res.json(result);
});

// GET /api/portal/tournaments/:tournamentId/my-marker
// Returns the player's assigned marker from their flight/pairing group
router.get("/portal/tournaments/:tournamentId/my-marker", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournament ID" }); return; } }

  const userEmail = req.user!.email ?? "";
  const [player] = await db.select().from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId),
      sql`(${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${req.user!.id})`));

  if (!player) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

  // Find the player's flight
  const [playerFlight] = await db.select({ flightId: playerFlightsTable.flightId })
    .from(playerFlightsTable)
    .where(eq(playerFlightsTable.playerId, player.id));

  if (!playerFlight) { { res.json({ marker: null, message: "No flight assignment found" }); return; } }

  // Find other players in the same flight (potential markers)
  const flightmates = await db
    .select({
      playerId: playerFlightsTable.playerId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      userId: playersTable.userId,
      email: playersTable.email,
    })
    .from(playerFlightsTable)
    .innerJoin(playersTable, eq(playersTable.id, playerFlightsTable.playerId))
    .where(and(eq(playerFlightsTable.flightId, playerFlight.flightId), sql`${playerFlightsTable.playerId} != ${player.id}`));

  if (flightmates.length === 0) { { res.json({ marker: null, message: "No playing partners in your flight" }); return; } }

  // Rank flightmates by how often they've co-signed before (markerPlayerId)
  const flightmateIds = flightmates.map(f => f.playerId);
  const coSignCounts = await db
    .select({ markerPlayerId: roundSubmissionsTable.markerPlayerId, cnt: count() })
    .from(roundSubmissionsTable)
    .innerJoin(playersTable, eq(playersTable.id, roundSubmissionsTable.playerId))
    .where(and(
      sql`(${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${req.user!.id})`,
      inArray(roundSubmissionsTable.markerPlayerId, flightmateIds)
    ))
    .groupBy(roundSubmissionsTable.markerPlayerId);

  const countMap: Record<number, number> = {};
  for (const row of coSignCounts) if (row.markerPlayerId) countMap[row.markerPlayerId] = Number(row.cnt);

  // Sort by co-sign frequency descending, then alphabetically
  const sorted = [...flightmates].sort((a, b) => {
    const diff = (countMap[b.playerId] ?? 0) - (countMap[a.playerId] ?? 0);
    return diff !== 0 ? diff : `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`);
  });

  const marker = sorted[0];
  res.json({
    marker: {
      playerId: marker.playerId,
      userId: marker.userId,
      name: `${marker.firstName} ${marker.lastName}`,
      email: marker.email,
      previousPlayCount: countMap[marker.playerId] ?? 0,
    },
    allFlightmates: sorted.map(f => ({
      playerId: f.playerId,
      userId: f.userId,
      name: `${f.firstName} ${f.lastName}`,
      email: f.email,
      previousPlayCount: countMap[f.playerId] ?? 0,
    })),
  });
});

// GET /api/portal/tournaments/:tournamentId/recent-markers
// Returns recent playing partners for quick marker selection (league scoring)
router.get("/portal/tournaments/:tournamentId/recent-markers", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournament ID" }); return; } }

  const userEmail = req.user!.email ?? "";

  // Get the player's recent round_submissions to find who they've played with
  const recentSubmissions = await db
    .select({
      id: roundSubmissionsTable.id,
      tournamentId: roundSubmissionsTable.tournamentId,
      markerPlayerId: roundSubmissionsTable.markerPlayerId,
      submittedAt: roundSubmissionsTable.submittedAt,
    })
    .from(roundSubmissionsTable)
    .innerJoin(playersTable, eq(playersTable.id, roundSubmissionsTable.playerId))
    .where(sql`${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${req.user!.id}`)
    .orderBy(desc(roundSubmissionsTable.submittedAt))
    .limit(10);

  const markerPlayerIds = recentSubmissions
    .map(s => s.markerPlayerId)
    .filter((id): id is number => id != null);

  if (markerPlayerIds.length === 0) {
    // No recent partners — return all players in this tournament as options
    const allPlayers = await db.select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    }).from(playersTable)
      .where(and(eq(playersTable.tournamentId, tournamentId),
        sql`(${playersTable.email} != ${userEmail} AND ${playersTable.userId} IS DISTINCT FROM ${req.user!.id})`))
      .limit(20);
    res.json({ recentPartners: [], otherPlayers: allPlayers.map(p => ({ playerId: p.id, name: `${p.firstName} ${p.lastName}` })) });
    return;
  }

  const recentMarkers = await db.select({
    id: playersTable.id,
    firstName: playersTable.firstName,
    lastName: playersTable.lastName,
  }).from(playersTable).where(inArray(playersTable.id, markerPlayerIds));

  const recentSet = new Set(markerPlayerIds);
  const otherPlayers = await db.select({
    id: playersTable.id,
    firstName: playersTable.firstName,
    lastName: playersTable.lastName,
  }).from(playersTable)
    .where(and(
      eq(playersTable.tournamentId, tournamentId),
      notInArray(playersTable.id, markerPlayerIds),
      sql`(${playersTable.email} != ${userEmail} AND ${playersTable.userId} IS DISTINCT FROM ${req.user!.id})`
    ))
    .limit(10);

  res.json({
    recentPartners: recentMarkers.map(p => ({ playerId: p.id, name: `${p.firstName} ${p.lastName}`, isRecent: true })),
    otherPlayers: otherPlayers.filter(p => !recentSet.has(p.id)).map(p => ({ playerId: p.id, name: `${p.firstName} ${p.lastName}` })),
  });
});

// POST /api/portal/tournaments/:tournamentId/pre-round-marker
// Player pre-assigns their marker before scoring begins (WHS Rule 7.1 compliance)
// Creates or updates the submission record with the designated markerPlayerId.
router.post("/portal/tournaments/:tournamentId/pre-round-marker", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournament ID" }); return; } }

  const { markerPlayerId, round = 1 } = req.body as { markerPlayerId?: number; round?: number };
  if (!markerPlayerId) { { res.status(400).json({ error: "markerPlayerId required" }); return; } }

  const userEmail = req.user!.email ?? "";
  const [player] = await db.select().from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId),
      sql`(${playersTable.email} = ${userEmail} OR ${playersTable.userId} = ${req.user!.id})`));
  if (!player) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

  // Verify marker exists in this tournament
  const [markerPlayer] = await db.select({ id: playersTable.id }).from(playersTable)
    .where(and(eq(playersTable.id, markerPlayerId), eq(playersTable.tournamentId, tournamentId)));
  if (!markerPlayer) { { res.status(404).json({ error: "Marker player not found in this tournament" }); return; } }

  // Upsert submission with markerPlayerId — other fields populated/updated at submit time
  const [upserted] = await db.insert(roundSubmissionsTable)
    .values({ tournamentId, playerId: player.id, round, markerPlayerId, status: "pending", totalStrokes: 0 })
    .onConflictDoUpdate({
      target: [roundSubmissionsTable.playerId, roundSubmissionsTable.round],
      set: { markerPlayerId },
    })
    .returning();

  // Auto-generate a marker share token so the pre-assigned marker gets a link immediately
  const now = new Date();
  let shareToken = upserted?.markerShareToken;
  if (!shareToken || !upserted?.markerShareTokenExpiresAt || upserted.markerShareTokenExpiresAt <= now) {
    shareToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await db.update(roundSubmissionsTable)
      .set({ markerShareToken: shareToken, markerShareTokenExpiresAt: expiresAt })
      .where(eq(roundSubmissionsTable.id, upserted.id));
  }

  const shareUrl = `https://app.kharagolf.com/portal/marker-live/${shareToken}`;
  res.json({ success: true, message: "Marker pre-assigned for this round", shareUrl, markerShareToken: shareToken });
});

// POST /api/portal/submissions/:submissionId/sign
// Player signs & submits their card (status: pending → submitted). Card is locked after this.
router.post("/portal/submissions/:submissionId/sign", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const submissionId = parseInt(String((req.params as Record<string, string>).submissionId));
  if (isNaN(submissionId)) { { res.status(400).json({ error: "Invalid submission ID" }); return; } }

  const [submission] = await db.select().from(roundSubmissionsTable).where(eq(roundSubmissionsTable.id, submissionId));
  if (!submission) { { res.status(404).json({ error: "Submission not found" }); return; } }

  // Only the player can sign their own card
  const userEmail = req.user!.email ?? "";
  const [player] = await db.select({ userId: playersTable.userId, email: playersTable.email })
    .from(playersTable).where(eq(playersTable.id, submission.playerId));
  const isOwner = (player?.userId === req.user!.id) || (player?.email?.toLowerCase() === userEmail.toLowerCase());
  if (!isOwner) { { res.status(403).json({ error: "Only the player can sign their own card" }); return; } }

  if (submission.status !== "pending") {
    res.status(400).json({ error: `Card is already ${submission.status} — cannot sign again` });
    return;
  }

  // Validate that all holes for the round are recorded before the player can officially sign
  // Fetch expected hole count from the course linked to the tournament
  const [tournamentCourse] = await db
    .select({ holes: coursesTable.holes })
    .from(tournamentsTable)
    .leftJoin(coursesTable, eq(coursesTable.id, tournamentsTable.courseId))
    .where(eq(tournamentsTable.id, submission.tournamentId));
  const expectedHoles = tournamentCourse?.holes ?? 18;

  const scoredHoles = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scoresTable)
    .where(and(eq(scoresTable.playerId, submission.playerId), eq(scoresTable.round, submission.round)));
  const scoredCount = scoredHoles[0]?.count ?? 0;
  if (scoredCount < expectedHoles) {
    res.status(400).json({
      error: `Cannot sign scorecard: only ${scoredCount} of ${expectedHoles} holes have been recorded. Please complete all holes before signing.`,
      scoredHoles: scoredCount,
      expectedHoles,
    });
    return;
  }

  // Move to "submitted" status — card is now locked for player edits
  await db.update(roundSubmissionsTable)
    .set({ status: "submitted", reviewedAt: null })
    .where(eq(roundSubmissionsTable.id, submissionId));

  // Notify the designated marker when player signs their card
  const [ext] = await db.select({ markerUserId: roundSubmissionsExtTable.markerUserId })
    .from(roundSubmissionsExtTable).where(eq(roundSubmissionsExtTable.submissionId, submissionId));
  let markerUserIdToNotify = ext?.markerUserId ?? null;

  // Fallback: if no ext marker, look up the designated markerPlayerId on the submission
  if (!markerUserIdToNotify && submission.markerPlayerId) {
    const [markerPlayer] = await db.select({ userId: playersTable.userId })
      .from(playersTable).where(eq(playersTable.id, submission.markerPlayerId));
    markerUserIdToNotify = markerPlayer?.userId ?? null;
  }
  if (markerUserIdToNotify) {
    // Task #1240 — fire-and-forget (`.catch(() => {})`); no delivery
    // telemetry consumed downstream, classifier intentionally not used.
    sendTransactionalPush(
      [markerUserIdToNotify],
      "📋 Scorecard Ready to Countersign",
      `A player has signed their scorecard. Please review and countersign.`,
      { type: "countersign_requested", submissionId: String(submissionId) },
    ).catch(() => {});
  }

  res.json({ success: true, status: "submitted", message: "Card signed. Awaiting marker countersign." });
});

// DELETE /api/portal/tournaments/:tournamentId/withdraw
// Player self-service withdrawal — authenticated player withdraws themselves from a tournament
router.delete("/portal/tournaments/:tournamentId/withdraw", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const userEmail = req.user!.email;
  const userId = req.user!.id;

  const [player] = await db
    .select()
    .from(playersTable)
    .where(and(
      eq(playersTable.tournamentId, tournamentId),
      sql`(${playersTable.email} = ${userEmail ?? ""} OR ${playersTable.userId} = ${userId})`,
    ));

  if (!player) {
    res.status(404).json({ error: "You are not registered for this tournament" });
    return;
  }

  const [tournament] = await db
    .select({ status: tournamentsTable.status, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (tournament?.status === "completed" || tournament?.status === "active") {
    res.status(400).json({ error: "Cannot withdraw from a tournament that has already started or completed" });
    return;
  }

  const tournamentName = tournament?.name ?? "the tournament";
  const refundPending = player.paymentStatus === "paid";

  await db.insert(withdrawalsTable).values({
    tournamentId,
    playerName: `${player.firstName} ${player.lastName}`,
    playerEmail: player.email ?? "",
    phone: player.phone ?? null,
    handicapIndex: player.handicapIndex ?? null,
    flight: player.flight ?? null,
    teeBox: player.teeBox ?? null,
    paymentStatus: player.paymentStatus,
    paymentReference: player.stripePaymentId ?? null,
    refundStatus: refundPending ? "pending" : "not_applicable",
    actorName: `${player.firstName} ${player.lastName} (self)`,
  });

  await db.delete(playersTable).where(eq(playersTable.id, player.id));

  // Send withdrawal confirmation email (fire-and-forget)
  if (player.email) {
    sendWithdrawalConfirmationEmail(
      player.email,
      `${player.firstName} ${player.lastName}`,
      tournamentName,
      refundPending,
    ).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      baseLogger.error({ email: player.email, eventName: tournamentName, errMsg }, "[portal] Failed to send withdrawal email");
    });
  }

  // Auto-promote next waitlisted player
  const [nextWaiting] = await db
    .select()
    .from(waitlistTable)
    .where(and(eq(waitlistTable.tournamentId, tournamentId), sql`${waitlistTable.promotedAt} IS NULL`))
    .orderBy(waitlistTable.position)
    .limit(1);

  if (nextWaiting) {
    await db.insert(playersTable).values({
      tournamentId,
      firstName: nextWaiting.firstName,
      lastName: nextWaiting.lastName,
      email: nextWaiting.email,
      phone: nextWaiting.phone ?? null,
      handicapIndex: nextWaiting.handicapIndex ?? null,
      flight: nextWaiting.flight ?? null,
      teeBox: nextWaiting.teeBox ?? "white",
    });
    await db.update(waitlistTable).set({ promotedAt: new Date() }).where(eq(waitlistTable.id, nextWaiting.id));

    // Renumber remaining waitlist positions after promotion
    const remaining = await db
      .select()
      .from(waitlistTable)
      .where(and(eq(waitlistTable.tournamentId, tournamentId), sql`${waitlistTable.promotedAt} IS NULL`))
      .orderBy(waitlistTable.position);
    for (let i = 0; i < remaining.length; i++) {
      await db.update(waitlistTable).set({ position: i + 1 }).where(eq(waitlistTable.id, remaining[i].id));
    }

    // Notify promoted player (fire-and-forget)
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    if (nextWaiting.email) {
      sendWaitlistPromotionEmail(
        nextWaiting.email,
        `${nextWaiting.firstName} ${nextWaiting.lastName}`,
        tournamentName,
        `${baseUrl}/portal`,
      ).catch((err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        baseLogger.error({ email: nextWaiting.email, eventName: tournamentName, errMsg }, "[portal] Failed to send waitlist promotion email");
      });
    }
  }

  res.json({ withdrawn: true, refundPending, message: refundPending ? "Successfully withdrawn. A refund will be processed." : "Successfully withdrawn from the tournament." });
});

// Task #1075 — public, unauthenticated one-click "stop reminding me about
// this data export" endpoint. Embedded as a link in the original
// `completed_export` ready email + the `export_expiring` reminder so a
// member can suppress the 24h-before nudge without first re-authenticating
// in the portal. Idempotent: clicking again on a row that's already
// suppressed returns 200 with `alreadyOptedOut: true`. The token is an
// opaque 24-byte hex string (see `ensureExpiringReminderUnsubToken`) and
// is the only authority required — possession of the link IS the consent
// signal, exactly as it is for "unsubscribe from this newsletter" links.
//
// We also stamp `expiringNoticeSentAt` so the daily cron's idempotency
// guard treats the row as resolved and never reconsiders it. The
// per-request `expiringReminderOptedOutAt` remains the authoritative
// "they asked us to stop" record so the suppressed counter on the cron's
// summary log line is accurate.
router.get("/public/data-export-reminder-unsubscribe", async (req: Request, res: Response) => {
  // Content negotiation: programmatic callers that explicitly ask for JSON
  // (and the integration test, which sends no Accept header — `req.accepts`
  // returns the first item in the list when nothing is preferred) keep the
  // legacy JSON shape. Real browsers, which send `Accept: text/html,...`,
  // get a friendly branded confirmation page so members don't see raw JSON
  // after clicking the link in their inbox.
  const wantsHtml = req.accepts(["json", "html"]) === "html";
  const tokenRaw = req.query.token;
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  // Task #1437 — `lang` query hint added by `dataRequestNotify.ts` so the
  // confirmation page renders in the same language as the email the link
  // came from. Unknown / missing codes fall back to English inside
  // `translateExportReminderUnsubPage`.
  const langRaw = req.query.lang;
  const lang = typeof langRaw === "string" ? langRaw.trim().toLowerCase() : null;
  if (!token || token.length < 16 || token.length > 128) {
    if (wantsHtml) {
      res.status(400)
        .type("html")
        .setHeader("Cache-Control", "no-store")
        .send(renderExportReminderUnsubPage("invalid", lang));
      return;
    }
    res.status(400).json({ error: "Missing or invalid token." });
    return;
  }
  const [row] = await db.select({
    id: memberDataRequestsTable.id,
    organizationId: memberDataRequestsTable.organizationId,
    clubMemberId: memberDataRequestsTable.clubMemberId,
    expiringReminderOptedOutAt: memberDataRequestsTable.expiringReminderOptedOutAt,
  }).from(memberDataRequestsTable)
    .where(eq(memberDataRequestsTable.expiringReminderUnsubToken, token))
    .limit(1);
  if (!row) {
    // Don't leak whether the token ever existed — same response shape as a
    // truly invalid token avoids token-presence enumeration.
    if (wantsHtml) {
      res.status(404)
        .type("html")
        .setHeader("Cache-Control", "no-store")
        .send(renderExportReminderUnsubPage("invalid", lang));
      return;
    }
    res.status(404).json({ error: "This unsubscribe link is no longer valid." });
    return;
  }
  if (row.expiringReminderOptedOutAt) {
    if (wantsHtml) {
      res.status(200)
        .type("html")
        .setHeader("Cache-Control", "no-store")
        .send(renderExportReminderUnsubPage("already", lang));
      return;
    }
    res.json({ ok: true, alreadyOptedOut: true });
    return;
  }
  await db.update(memberDataRequestsTable)
    .set({
      expiringReminderOptedOutAt: new Date(),
      // Stamp the reminder-sent guard too so the cron's idempotency check
      // treats this row as resolved on subsequent passes.
      expiringNoticeSentAt: new Date(),
    })
    .where(eq(memberDataRequestsTable.id, row.id));
  // Task #1773 — mirror the Task #1454 erasure-digest audit pattern so a
  // member who later wonders "why did the export-expiring reminders stop
  // arriving?" can see the public-link click in `member_audit_log`. The
  // audit is scoped to the data request's org and club member; the
  // entityId is the matching app user (when the club member is linked to
  // one) so the portal GET below can find it by user. Only emitted on the
  // *transition* (the early-return above already handled the idempotent
  // second click), so a re-click never writes a duplicate "unsubscribe"
  // row. recordMemberAudit swallows insert errors internally — if the
  // (rare) lookup or insert fails, the unsubscribe response still
  // succeeds.
  try {
    const [member] = await db.select({ userId: clubMembersTable.userId })
      .from(clubMembersTable)
      .where(eq(clubMembersTable.id, row.clubMemberId))
      .limit(1);
    await recordMemberAudit({
      req,
      organizationId: row.organizationId,
      clubMemberId: row.clubMemberId,
      entity: "comm_prefs",
      entityId: member?.userId ?? null,
      action: "update",
      changes: {
        notifyDataExportExpiring: { from: true, to: false },
      },
      reason: "Public unsubscribe link clicked",
      metadata: {
        source: "public_unsubscribe_link",
        kind: "data_export_expiring",
        direction: "unsubscribe",
        dataRequestId: row.id,
        targetUserId: member?.userId ?? null,
      },
    });
  } catch (err) {
    baseLogger.warn(
      { errMsg: err instanceof Error ? err.message : String(err) },
      "[portal] export-expiring reminder unsubscribe: failed to record audit",
    );
  }
  if (wantsHtml) {
    res.status(200)
      .type("html")
      .setHeader("Cache-Control", "no-store")
      .send(renderExportReminderUnsubPage("ok", lang));
    return;
  }
  res.json({ ok: true, alreadyOptedOut: false });
});

/**
 * Task #1235 — branded HTML confirmation page for the one-click
 * data-export-reminder unsubscribe link. Public, unauthenticated and has no
 * org context (the token is the only identifier the route accepts), so we
 * use the default KHARAGOLF brand palette to match the email it was clicked
 * from. Mobile-friendly, fully self-contained inline CSS — no external
 * assets, no JS — so it renders identically on every webview (including
 * stripped-down email-client in-app browsers).
 */
function renderExportReminderUnsubPage(
  state: "ok" | "already" | "invalid",
  // Task #1437 — language hint carried as a `lang=` query string param on the
  // unsubscribe link. Built by `dataRequestNotify.ts` from the recipient's
  // preferred language so the confirmation page reads in the same language
  // as the email the link was clicked from. Unsupported / missing codes
  // fall back to English inside `translateExportReminderUnsubPage`.
  lang: string | null = null,
): string {
  const esc = (s: string): string => s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const accent = state === "ok" ? "#22c55e" : state === "already" ? "#9ca3af" : "#f59e0b";
  const icon = state === "invalid" ? "!" : "✓";
  const copy = translateExportReminderUnsubPage(lang, state);
  return `<!doctype html>
<html lang="${esc(copy.htmlLang)}" dir="${copy.dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${esc(copy.title)} — KHARAGOLF</title>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{
      font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      background:#0a0a0a;color:#fff;min-height:100vh;
      display:flex;align-items:center;justify-content:center;
      padding:24px;line-height:1.5;
    }
    .card{
      width:100%;max-width:480px;background:#111;
      border:1px solid rgba(255,255,255,0.08);border-radius:16px;overflow:hidden;
      box-shadow:0 20px 50px rgba(0,0,0,0.4);
    }
    .header{background:#1e4d2b;padding:28px 32px;}
    .brand{margin:0;font-size:22px;letter-spacing:4px;font-weight:900;color:#fff;}
    .subtitle{margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;}
    .content{padding:36px 32px;}
    .icon{
      width:56px;height:56px;border-radius:50%;
      display:flex;align-items:center;justify-content:center;
      font-size:28px;font-weight:700;color:#0a0a0a;
      margin:0 0 20px;
    }
    h1{margin:0 0 12px;font-size:20px;font-weight:700;color:#fff;line-height:1.3;}
    p.body{margin:0 0 24px;color:#9ca3af;font-size:15px;line-height:1.6;}
    .footer{
      border-top:1px solid rgba(255,255,255,0.06);
      padding:20px 32px;color:#6b7280;font-size:12px;line-height:1.5;
    }
    @media (max-width:480px){
      body{padding:16px;}
      .header{padding:24px;}
      .content{padding:28px 24px;}
      .footer{padding:16px 24px;}
      h1{font-size:18px;}
    }
  </style>
</head>
<body>
  <main class="card" role="main">
    <div class="header">
      <h2 class="brand">KHARAGOLF</h2>
      <p class="subtitle">${esc(copy.headerTag)}</p>
    </div>
    <div class="content">
      <div class="icon" style="background:${accent};" aria-hidden="true">${icon}</div>
      <h1>${esc(copy.heading)}</h1>
      <p class="body">${esc(copy.body)}</p>
    </div>
    <div class="footer">
      ${esc(copy.footer)}
    </div>
  </main>
</body>
</html>`;
}

// Task #1124 — public, unauthenticated open-tracking pixel for the
// `export_expiring` reminder. Embedded as a 1x1 image at the end of the
// reminder email; the first request stamps `expiringReminderEmailOpenedAt`
// on the matching data-request row so the controller dashboard can report
// the read-rate of the courtesy notice. The token is the opaque
// `expiringReminderTrackingToken` minted at send time and is intentionally
// distinct from the Task #1075 unsubscribe token so this endpoint can
// never be coerced into silencing a member's reminder.
//
// Response is always a 1x1 transparent GIF with no-cache headers; the
// status code is always 200 even for unknown/missing tokens to avoid
// leaking which tokens map to live rows. Subsequent opens are silently
// no-op (we keep the *first* open as the authoritative timestamp).
//
// Task #1298 — privacy-aware accounting. Apple Mail Privacy Protection
// (AMPP), GoogleImageProxy, YahooMailProxy and friends eagerly prefetch
// every <img> in inbound mail from a relay IP, *without the recipient
// ever opening the email*. Counting those as "opens" inflates the
// dashboard's open rate. We classify each fetch via `looksLikeMailPrefetch`
// (User-Agent + Apple proxy CIDR + DNT/Sec-GPC privacy signals) and stamp
// the prefetch column instead of the open column when the fetch is almost
// certainly a proxy prefetch. The dashboard excludes prefetches by default
// and exposes an admin toggle to fold them back in.
//
// Task #1533 — the heuristic itself now lives in
// `lib/mailPrefetch.ts` so any future open-pixel handler (levy-ledger
// emails, payout-confirmation emails, side-game receipts, …) can
// `import { looksLikeMailPrefetch }` from there instead of
// re-implementing the classifier and re-introducing the same bug.
// Task #1532's CIDR-narrowed Apple AMPP heuristic moved with it.
const TRANSPARENT_GIF_1X1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

router.get("/public/data-export-reminder-pixel", async (req: Request, res: Response) => {
  const tokenRaw = req.query.token;
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  // Always serve the pixel — we don't want broken images in member inboxes.
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (token && token.length >= 16 && token.length <= 128) {
    try {
      const isPrefetch = looksLikeMailPrefetch(req);
      const [row] = await db.select({
        id: memberDataRequestsTable.id,
        openedAt: memberDataRequestsTable.expiringReminderEmailOpenedAt,
        prefetchedAt: memberDataRequestsTable.expiringReminderEmailPrefetchedAt,
      }).from(memberDataRequestsTable)
        .where(eq(memberDataRequestsTable.expiringReminderTrackingToken, token))
        .limit(1);
      if (row) {
        if (isPrefetch) {
          // Stamp the prefetch column (first hit only) and *never* the
          // open column — even if a real open later arrives, the open
          // pixel handler will stamp the open column correctly then.
          if (!row.prefetchedAt) {
            await db.update(memberDataRequestsTable)
              .set({ expiringReminderEmailPrefetchedAt: new Date() })
              .where(eq(memberDataRequestsTable.id, row.id));
          }
        } else if (!row.openedAt) {
          await db.update(memberDataRequestsTable)
            .set({ expiringReminderEmailOpenedAt: new Date() })
            .where(eq(memberDataRequestsTable.id, row.id));
        }
      }
    } catch (err) {
      // Telemetry must never break image rendering — log and serve the GIF.
      baseLogger.warn(
        { errMsg: err instanceof Error ? err.message : String(err) },
        "[portal] export-expiring reminder pixel: failed to stamp open",
      );
    }
  }
  res.status(200).end(TRANSPARENT_GIF_1X1);
});

// Task #1124 — public, unauthenticated click-tracking redirect for the
// `export_expiring` reminder's download CTA. Stamps
// `expiringReminderEmailClickedAt` (and back-fills `expiringReminderEmail
// OpenedAt` if the open pixel was blocked, since a click implies an open)
// the first time it's hit, then 302s to a freshly-minted signed download
// URL for the archive. The signed URL is re-minted on every click so
// repeated taps always land on a working link — even if the previous
// signed URL has since expired or rotated. Falls back to the in-app
// privacy screen when the artifact path is no longer downloadable.
router.get("/public/data-export-reminder-click", async (req: Request, res: Response) => {
  const tokenRaw = req.query.token;
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  const fallbackUrl = `${process.env.APP_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`}`.replace(/\/$/, "") + "/portal/privacy";

  if (!token || token.length < 16 || token.length > 128) {
    res.status(400).json({ error: "Missing or invalid token." });
    return;
  }

  const [row] = await db.select({
    id: memberDataRequestsTable.id,
    artifactUrl: memberDataRequestsTable.artifactUrl,
    openedAt: memberDataRequestsTable.expiringReminderEmailOpenedAt,
    clickedAt: memberDataRequestsTable.expiringReminderEmailClickedAt,
  }).from(memberDataRequestsTable)
    .where(eq(memberDataRequestsTable.expiringReminderTrackingToken, token))
    .limit(1);

  if (!row) {
    // Match the unsubscribe endpoint shape — don't leak token validity.
    res.status(404).json({ error: "This download link is no longer valid." });
    return;
  }

  try {
    const now = new Date();
    const patch: { expiringReminderEmailClickedAt?: Date; expiringReminderEmailOpenedAt?: Date } = {};
    if (!row.clickedAt) patch.expiringReminderEmailClickedAt = now;
    // A click implies an open — back-fill if the open pixel was blocked
    // by the member's mail client (common with privacy-focused clients
    // like Apple Mail Privacy Protection that proxy or block pixels).
    if (!row.openedAt) patch.expiringReminderEmailOpenedAt = now;
    if (Object.keys(patch).length > 0) {
      await db.update(memberDataRequestsTable)
        .set(patch)
        .where(eq(memberDataRequestsTable.id, row.id));
    }
  } catch (err) {
    baseLogger.warn(
      { errMsg: err instanceof Error ? err.message : String(err), requestId: row.id },
      "[portal] export-expiring reminder click: failed to stamp click",
    );
  }

  // Re-mint the signed download URL on every click so the link doesn't
  // go stale between send and tap. If the archive has already been purged
  // or the path isn't an object-storage path, fall back to the privacy
  // screen so the member at least lands somewhere useful.
  let target: string = fallbackUrl;
  if (row.artifactUrl && row.artifactUrl.startsWith("/objects/")) {
    try {
      const svc = new ObjectStorageService();
      const SEVEN_DAYS = 7 * 24 * 60 * 60;
      const signed = await svc.getSignedDownloadUrl(row.artifactUrl, SEVEN_DAYS);
      if (signed) target = signed;
    } catch (err) {
      baseLogger.warn(
        { errMsg: err instanceof Error ? err.message : String(err), requestId: row.id },
        "[portal] export-expiring reminder click: failed to mint signed URL — redirecting to portal",
      );
    }
  }
  res.redirect(302, target);
});

// GET /api/portal/notification-preferences
// Returns the authenticated user's channel preferences (or defaults if not yet set),
// plus capability flags: hasPhone (whether a player record has a phone number on file)
// and hasPushToken (whether the user has at least one registered push token).
router.get("/portal/notification-preferences", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  // Task #754 — committee eligibility for the daily peer-response digest
  // toggle. Mirrors `getCommitteeMemberUserIds` in `lib/handicap-cases.ts`:
  // a user is committee-eligible if EITHER their app-level role is one of
  // the committee roles OR they have an org_memberships row with a
  // committee role. We expose this so the portal UI can show the toggle to
  // exactly the same audience that actually receives the digest email.
  const COMMITTEE_ROLES = ["org_admin", "tournament_director", "committee_member", "competition_secretary"];

  const [[prefs], phoneRows, pushRows, appRoleRows, orgMembershipRows, erasureDigestLinkAuditRows, dataExportExpiringLinkAuditRows] = await Promise.all([
    db.select().from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId)),
    db.select({ phone: playersTable.phone })
      .from(playersTable)
      .where(and(eq(playersTable.userId, userId), sql`${playersTable.phone} IS NOT NULL AND ${playersTable.phone} != ''`))
      .limit(1),
    db.select({ id: deviceTokensTable.id })
      .from(deviceTokensTable)
      .where(eq(deviceTokensTable.userId, userId))
      .limit(1),
    db.select({ role: appUsersTable.role })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId))
      .limit(1),
    db.select({ role: orgMembershipsTable.role })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.userId, userId),
        inArray(orgMembershipsTable.role, COMMITTEE_ROLES as never[]),
      ))
      .limit(1),
    // Task #1454 — surface "Last changed via unsubscribe link on <date>"
    // next to the stuck-erasure digest toggle. We pull the most recent
    // member_audit_log row written by the public unsubscribe / re-subscribe
    // endpoints (entity = "comm_prefs", metadata.source = "public_unsubscribe_link",
    // metadata.kind = "erasure_storage_digest") for this user, regardless
    // of which org's email link they clicked.
    //
    // Task #2215 — the original Task #1454 query filtered by
    // metadata.source = "public_unsubscribe_link" and so the hint
    // persisted forever, even after the controller subsequently flipped
    // the toggle back from the in-portal settings page (PATCH below).
    // That was misleading: the date read as if the most recent change
    // came from the email link when in fact a newer in-portal change
    // had superseded it. We now fetch the LATEST comm_prefs/
    // erasure_storage_digest row regardless of source and only surface
    // the link-change hint if that latest row was the link click —
    // i.e. no portal-side toggle has happened since. The portal PATCH
    // writes its own member_audit_log row (mirroring the
    // silent-alerts-digest and admin-payout-reverify patterns below),
    // so a portal flip naturally supersedes the link-driven row in
    // this query without us having to delete the historical entry.
    db.select({
      createdAt: memberAuditLogTable.createdAt,
      direction: sql<string | null>`${memberAuditLogTable.metadata}->>'direction'`,
      source: sql<string | null>`${memberAuditLogTable.metadata}->>'source'`,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, userId),
        sql`${memberAuditLogTable.metadata}->>'kind' = 'erasure_storage_digest'`,
      ))
      .orderBy(desc(memberAuditLogTable.createdAt))
      .limit(1),
    // Task #1773 — same surfacing pattern for the data-export-expiring
    // public unsubscribe link (Task #1075). Pulls the most recent
    // member_audit_log row written by the per-request opt-out handler
    // (entity = "comm_prefs", metadata.source = "public_unsubscribe_link",
    // metadata.kind = "data_export_expiring") so the portal UI can show
    // "Last changed via unsubscribe link on <date>" next to the
    // data-export reminder toggle. Direction is currently always
    // "unsubscribe" (the per-request opt-out has no public re-subscribe
    // counterpart) but we surface the field anyway so the response shape
    // matches the erasure-digest hint and the UI can render the same
    // chip in both places.
    db.select({
      createdAt: memberAuditLogTable.createdAt,
      direction: sql<string | null>`${memberAuditLogTable.metadata}->>'direction'`,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.entity, "comm_prefs"),
        eq(memberAuditLogTable.entityId, userId),
        sql`${memberAuditLogTable.metadata}->>'source' = 'public_unsubscribe_link'`,
        sql`${memberAuditLogTable.metadata}->>'kind' = 'data_export_expiring'`,
      ))
      .orderBy(desc(memberAuditLogTable.createdAt))
      .limit(1),
  ]);

  const isCommitteeMember =
    (appRoleRows.length > 0 && COMMITTEE_ROLES.includes(appRoleRows[0].role as string)) ||
    orgMembershipRows.length > 0;

  const base = prefs ?? { userId, preferEmail: true, preferPush: true, preferSms: false, preferWhatsapp: false, notifyMemberDocuments: true, notifyCommitteePeerDigest: true, notifySideGameReceipts: true, notifyManualEntryAlerts: true, notifyCoachPayoutAccountChanges: true, notifyAdminPayoutReverify: true, notifySocialLinkAdded: true, notifyDataExportExpiring: true, notifyErasureStorageDigest: true, notifyErasureStorageDigestPush: true, notifyWalletRefundDigestFailed: true, notifySideGameReceiptDigestFailed: true, notifyLevyLedgerDigestFailed: true, notifyLevyLedgerOrgDigestFailed: true, notifyLevyRemindersDigestFailed: true, notifyExhaustionAdminDigestFailed: true, notifySilentAlertsDigest: true, notifyCoachingTipClosed: true };
  // Task #2215 — only surface the link-change hint when the most recent
  // comm_prefs/erasure_storage_digest audit row is the public unsubscribe
  // link click. If a portal-side toggle (PATCH below, source =
  // "portal_notification_preferences") wrote a newer row, the link click
  // is no longer the latest change and the hint must disappear so the
  // controller is not misled into thinking the displayed date reflects
  // the most recent toggle. Other sources we deliberately ignore here
  // are `public_portal_mute_revert_link` (a separate flow with its own
  // surface) and any future audit-source we add — only the original
  // unsubscribe-link source is what the existing UI string ("Last
  // changed via email link") refers to.
  const latestErasureDigestAuditRow = erasureDigestLinkAuditRows[0] ?? null;
  const lastErasureDigestLinkChange =
    latestErasureDigestAuditRow?.source === "public_unsubscribe_link"
      ? latestErasureDigestAuditRow
      : null;
  const lastDataExportExpiringLinkChange = dataExportExpiringLinkAuditRows[0] ?? null;
  // Task #2218 — surface the watermark column the in-portal mute path
  // already stamps (`maybeSendErasureDigestMuteConfirmation`) so the
  // settings UI can show an in-portal "you recently muted this — click
  // to revert" banner that mirrors the email confirmation's revert link.
  // The column lives on `user_notification_prefs` so the bare `prefs`
  // query (`db.select().from(userNotificationPrefsTable)…`) already
  // returns it; we re-emit it here as an explicit, ISO-formatted field
  // alongside the other audit-trail surfaces above so the client schema
  // stays uniform regardless of which column is a Date vs string in the
  // DB driver. Stays null for controllers who have never silenced the
  // digest from the in-portal toggle.
  const muteConfirmationLastSentAtRaw =
    (base as { notifyErasureStorageDigestMuteConfirmationLastSentAt?: Date | string | null })
      .notifyErasureStorageDigestMuteConfirmationLastSentAt ?? null;
  const muteConfirmationLastSentAtIso =
    muteConfirmationLastSentAtRaw instanceof Date
      ? muteConfirmationLastSentAtRaw.toISOString()
      : (typeof muteConfirmationLastSentAtRaw === "string"
        ? muteConfirmationLastSentAtRaw
        : null);
  res.json({
    ...base,
    hasPhone: phoneRows.length > 0,
    hasPushToken: pushRows.length > 0,
    isCommitteeMember,
    notifyErasureStorageDigestMuteConfirmationLastSentAt:
      muteConfirmationLastSentAtIso,
    notifyErasureStorageDigestLastChangedViaUnsubscribeLinkAt:
      lastErasureDigestLinkChange?.createdAt instanceof Date
        ? lastErasureDigestLinkChange.createdAt.toISOString()
        : (lastErasureDigestLinkChange?.createdAt ?? null),
    notifyErasureStorageDigestLastChangedViaUnsubscribeLinkDirection:
      lastErasureDigestLinkChange?.direction ?? null,
    // Task #1773 — same shape as the erasure-digest hint above so the
    // portal UI can render an identical "Last changed via unsubscribe
    // link on <date>" chip next to the data-export reminder toggle.
    notifyDataExportExpiringLastChangedViaUnsubscribeLinkAt:
      lastDataExportExpiringLinkChange?.createdAt instanceof Date
        ? lastDataExportExpiringLinkChange.createdAt.toISOString()
        : (lastDataExportExpiringLinkChange?.createdAt ?? null),
    notifyDataExportExpiringLastChangedViaUnsubscribeLinkDirection:
      lastDataExportExpiringLinkChange?.direction ?? null,
  });
});

// PATCH /api/portal/notification-preferences
// Upserts the authenticated user's channel preferences
router.patch("/portal/notification-preferences", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const { preferEmail, preferPush, preferSms, preferWhatsapp, notifyMemberDocuments, notifyCommitteePeerDigest, notifySideGameReceipts, notifyManualEntryAlerts, notifyCoachPayoutAccountChanges, notifyAdminPayoutReverify, notifySocialLinkAdded, notifyDataExportExpiring, notifyErasureStorageDigest, notifyErasureStorageDigestPush, notifyWalletRefundDigestFailed, notifySideGameReceiptDigestFailed, notifyLevyLedgerDigestFailed, notifyLevyLedgerOrgDigestFailed, notifyLevyRemindersDigestFailed, notifyExhaustionAdminDigestFailed, notifySilentAlertsDigest, notifyCoachingTipClosed } = req.body as {
    preferEmail?: boolean;
    preferPush?: boolean;
    preferSms?: boolean;
    preferWhatsapp?: boolean;
    notifyMemberDocuments?: boolean;
    notifyCommitteePeerDigest?: boolean;
    notifySideGameReceipts?: boolean;
    notifyManualEntryAlerts?: boolean;
    notifyCoachPayoutAccountChanges?: boolean;
    // Task #1724 — coach-side per-event opt-out for the courtesy email
    // sent when an admin manually re-verifies the coach's payout account
    // (`sendCoachPayoutAccountReverifiedByAdminEmail`). Independent of
    // the broader `billing` comm-prefs opt-out so coaches can mute just
    // this notice without silencing payout receipts or the cron-side
    // needs-attention email.
    notifyAdminPayoutReverify?: boolean;
    // Task #2150 — per-event opt-out for the security heads-up email
    // sent when an Apple/Google sign-in identity is freshly linked to
    // the player's KHARAGOLF account (`sendSocialLinkAddedSecurityEmail`,
    // gated in `routes/wave3.ts` POST /portal/me/social-links/:provider).
    // Default-on so existing players keep receiving the heads-up; a
    // false value mutes just this one notice without flipping the
    // umbrella `privacy` comm-prefs category.
    notifySocialLinkAdded?: boolean;
    notifyDataExportExpiring?: boolean;
    notifyErasureStorageDigest?: boolean;
    // Task #1449 — split push-side opt-out for the stuck-erasure controller
    // digest. Independent of `notifyErasureStorageDigest` (email side) so a
    // controller can keep one channel and mute the other.
    notifyErasureStorageDigestPush?: boolean;
    // Task #1429 — admin per-event opt-outs for the digest-failed alerts.
    notifyWalletRefundDigestFailed?: boolean;
    notifySideGameReceiptDigestFailed?: boolean;
    // Task #1762 — admin per-event opt-outs for the three Task #1444
    // levy/reminders digest-failed alerts. Same audit-only short-circuit
    // semantics as the wallet/side-game refund digest opt-outs above.
    notifyLevyLedgerDigestFailed?: boolean;
    notifyLevyLedgerOrgDigestFailed?: boolean;
    notifyLevyRemindersDigestFailed?: boolean;
    // Task #1855 — super-admin per-event opt-out for the daily exhaustion
    // admin digest cron (`sendNotifyExhaustionAdminDigest`). Same audit-
    // only short-circuit semantics as the wallet/side-game refund digest
    // opt-outs above so a super_admin who muted the alert still has the
    // audit row but no email/push.
    notifyExhaustionAdminDigestFailed?: boolean;
    // Task #1663 — super-admin per-event opt-out for the weekly silent-
    // failures CSV digest (`sendSilentAlertsDigestToSuperAdmins`). The
    // cron skips users with this set to false. Default-on so existing
    // super admins keep receiving the digest after the migration.
    notifySilentAlertsDigest?: boolean;
    // Task #2040 — per-player opt-out for the daily "you closed the
    // gap" coaching encouragement push. Audit-only short-circuit
    // semantics — same pattern as `notifyWalletRefundDigestFailed`
    // above — so a `false` value mutes the per-event push without
    // affecting the global `preferPush` toggle.
    notifyCoachingTipClosed?: boolean;
  };

  const updates: Partial<{ preferEmail: boolean; preferPush: boolean; preferSms: boolean; preferWhatsapp: boolean; notifyMemberDocuments: boolean; notifyCommitteePeerDigest: boolean; notifySideGameReceipts: boolean; notifyManualEntryAlerts: boolean; notifyCoachPayoutAccountChanges: boolean; notifyAdminPayoutReverify: boolean; notifySocialLinkAdded: boolean; notifyDataExportExpiring: boolean; notifyErasureStorageDigest: boolean; notifyErasureStorageDigestPush: boolean; notifyWalletRefundDigestFailed: boolean; notifySideGameReceiptDigestFailed: boolean; notifyLevyLedgerDigestFailed: boolean; notifyLevyLedgerOrgDigestFailed: boolean; notifyLevyRemindersDigestFailed: boolean; notifyExhaustionAdminDigestFailed: boolean; notifySilentAlertsDigest: boolean; notifyCoachingTipClosed: boolean; updatedAt: Date }> = { updatedAt: new Date() };
  // Email is always on — silently enforce server-side regardless of what was sent
  updates.preferEmail = true;
  if (typeof preferPush === "boolean") updates.preferPush = preferPush;
  if (typeof preferSms === "boolean") updates.preferSms = preferSms;
  if (typeof preferWhatsapp === "boolean") updates.preferWhatsapp = preferWhatsapp;
  if (typeof notifyMemberDocuments === "boolean") updates.notifyMemberDocuments = notifyMemberDocuments;
  if (typeof notifyCommitteePeerDigest === "boolean") updates.notifyCommitteePeerDigest = notifyCommitteePeerDigest;
  if (typeof notifySideGameReceipts === "boolean") updates.notifySideGameReceipts = notifySideGameReceipts;
  if (typeof notifyManualEntryAlerts === "boolean") updates.notifyManualEntryAlerts = notifyManualEntryAlerts;
  if (typeof notifyCoachPayoutAccountChanges === "boolean") updates.notifyCoachPayoutAccountChanges = notifyCoachPayoutAccountChanges;
  if (typeof notifyAdminPayoutReverify === "boolean") updates.notifyAdminPayoutReverify = notifyAdminPayoutReverify;
  if (typeof notifySocialLinkAdded === "boolean") updates.notifySocialLinkAdded = notifySocialLinkAdded;
  if (typeof notifyDataExportExpiring === "boolean") updates.notifyDataExportExpiring = notifyDataExportExpiring;
  if (typeof notifyErasureStorageDigest === "boolean") updates.notifyErasureStorageDigest = notifyErasureStorageDigest;
  if (typeof notifyErasureStorageDigestPush === "boolean") updates.notifyErasureStorageDigestPush = notifyErasureStorageDigestPush;
  if (typeof notifyWalletRefundDigestFailed === "boolean") updates.notifyWalletRefundDigestFailed = notifyWalletRefundDigestFailed;
  if (typeof notifySideGameReceiptDigestFailed === "boolean") updates.notifySideGameReceiptDigestFailed = notifySideGameReceiptDigestFailed;
  if (typeof notifyLevyLedgerDigestFailed === "boolean") updates.notifyLevyLedgerDigestFailed = notifyLevyLedgerDigestFailed;
  if (typeof notifyLevyLedgerOrgDigestFailed === "boolean") updates.notifyLevyLedgerOrgDigestFailed = notifyLevyLedgerOrgDigestFailed;
  if (typeof notifyLevyRemindersDigestFailed === "boolean") updates.notifyLevyRemindersDigestFailed = notifyLevyRemindersDigestFailed;
  if (typeof notifyExhaustionAdminDigestFailed === "boolean") updates.notifyExhaustionAdminDigestFailed = notifyExhaustionAdminDigestFailed;
  if (typeof notifySilentAlertsDigest === "boolean") updates.notifySilentAlertsDigest = notifySilentAlertsDigest;
  if (typeof notifyCoachingTipClosed === "boolean") updates.notifyCoachingTipClosed = notifyCoachingTipClosed;

  // Task #1776 — capture the pre-update flags so we can detect a true→false
  // transition on either stuck-erasure-digest channel and emit the
  // confirmation email below. We read inside the same handler (not via a
  // trigger or downstream cron) so the email's "you just muted X" framing
  // matches the user's intent at the exact moment they saved the toggle.
  //
  // Task #2073 — also capture the pre-update value of
  // `notifySilentAlertsDigest` so the post-save audit-write below can
  // diff before/after on the super-admin opt-out toggle. A future
  // incident where every super admin has muted the weekly silent-
  // failures digest needs an audit trail to answer "when did they all
  // turn it off?", and the previous PATCH path silently flipped the
  // column with no record. Schema default is true, so a missing prefs
  // row reads as "was on before this save".
  // Task #2141 — also capture the pre-update value of
  // `notifyAdminPayoutReverify` so the post-save audit-write below can
  // diff before/after on the coach mute toggle. Until now this PATCH
  // path silently flipped the column with no record, so a coach who
  // later complained "I never got the courtesy email after the admin
  // re-verify" gave support no way to tell whether they themselves
  // muted it. Schema default is true, so a missing prefs row reads as
  // "was on before this save".
  const [previousPrefs] = await db
    .select({
      notifyErasureStorageDigest: userNotificationPrefsTable.notifyErasureStorageDigest,
      notifyErasureStorageDigestPush: userNotificationPrefsTable.notifyErasureStorageDigestPush,
      notifyErasureStorageDigestMuteConfirmationLastSentAt:
        userNotificationPrefsTable.notifyErasureStorageDigestMuteConfirmationLastSentAt,
      notifySilentAlertsDigest: userNotificationPrefsTable.notifySilentAlertsDigest,
      notifyAdminPayoutReverify: userNotificationPrefsTable.notifyAdminPayoutReverify,
      // Task #2154 — read every per-event opt-out flag on `user_notification_prefs`
      // up-front so the post-save audit pass below can diff before/after on
      // each one and write a `notification_audit_log` row per genuine flip.
      // The settings page now mirrors the email-link mute path's audit
      // semantics (Task #1734) so an admin who silenced an alert from the
      // in-portal toggle leaves the same paper trail as one who clicked the
      // footer link in an email.
      notifyWalletRefundDigestFailed: userNotificationPrefsTable.notifyWalletRefundDigestFailed,
      notifySideGameReceiptDigestFailed: userNotificationPrefsTable.notifySideGameReceiptDigestFailed,
      notifyLevyLedgerDigestFailed: userNotificationPrefsTable.notifyLevyLedgerDigestFailed,
      notifyLevyLedgerOrgDigestFailed: userNotificationPrefsTable.notifyLevyLedgerOrgDigestFailed,
      notifyLevyRemindersDigestFailed: userNotificationPrefsTable.notifyLevyRemindersDigestFailed,
      notifyExhaustionAdminDigestFailed: userNotificationPrefsTable.notifyExhaustionAdminDigestFailed,
      notifyCoachingTipClosed: userNotificationPrefsTable.notifyCoachingTipClosed,
    })
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, userId));

  const [saved] = await db
    .insert(userNotificationPrefsTable)
    .values({ userId, preferEmail: true, preferPush: preferPush ?? true, preferSms: preferSms ?? false, preferWhatsapp: preferWhatsapp ?? false, notifyMemberDocuments: notifyMemberDocuments ?? true, notifyCommitteePeerDigest: notifyCommitteePeerDigest ?? true, notifySideGameReceipts: notifySideGameReceipts ?? true, notifyManualEntryAlerts: notifyManualEntryAlerts ?? true, notifyCoachPayoutAccountChanges: notifyCoachPayoutAccountChanges ?? true, notifyAdminPayoutReverify: notifyAdminPayoutReverify ?? true, notifySocialLinkAdded: notifySocialLinkAdded ?? true, notifyDataExportExpiring: notifyDataExportExpiring ?? true, notifyErasureStorageDigest: notifyErasureStorageDigest ?? true, notifyErasureStorageDigestPush: notifyErasureStorageDigestPush ?? true, notifyWalletRefundDigestFailed: notifyWalletRefundDigestFailed ?? true, notifySideGameReceiptDigestFailed: notifySideGameReceiptDigestFailed ?? true, notifyLevyLedgerDigestFailed: notifyLevyLedgerDigestFailed ?? true, notifyLevyLedgerOrgDigestFailed: notifyLevyLedgerOrgDigestFailed ?? true, notifyLevyRemindersDigestFailed: notifyLevyRemindersDigestFailed ?? true, notifyExhaustionAdminDigestFailed: notifyExhaustionAdminDigestFailed ?? true, notifySilentAlertsDigest: notifySilentAlertsDigest ?? true, notifyCoachingTipClosed: notifyCoachingTipClosed ?? true })
    .onConflictDoUpdate({ target: userNotificationPrefsTable.userId, set: updates })
    .returning();

  // Task #2154 — Audit-trail parity for per-event opt-outs flipped from
  // the in-portal Notifications settings page. Until now only the email-
  // link mute path (Task #1734, `/api/public/notification-event-mute` /
  // `/api/public/notification-event-resubscribe`) wrote the
  // `notification_audit_log` row that proves the alert was suppressed by
  // user choice rather than lost. An admin who muted (or re-enabled)
  // the same alert from the settings page left no entry, which made it
  // impossible to reconstruct who silenced an alert when an incident
  // surfaced later.
  //
  // We diff the pre-update read above against the saved row for every
  // dispatcher key in `PER_EVENT_OPT_OUT_COLUMNS` (the canonical
  // registry the dispatcher itself reads). Any genuine true→false
  // produces a `skipped`/`event_opted_out_via_settings_page` row;
  // false→true produces `event_opted_in_via_settings_page` so a
  // re-enable is just as discoverable. Both reasons match the
  // `event_opted_out_via_email_link` / `event_opted_in_via_email_link`
  // pattern so the existing audit-log surface (`/portal/notification-
  // audit`) renders them out of the box.
  const { PER_EVENT_OPT_OUT_COLUMNS, PER_EVENT_OPT_OUT_FIELD_NAMES } =
    await import("../lib/notifyDispatch.js");
  type PerEventField = NonNullable<typeof PER_EVENT_OPT_OUT_FIELD_NAMES[string]>;
  const perEventAuditRows: Array<typeof notificationAuditLogTable.$inferInsert> = [];
  for (const [key, fieldName] of Object.entries(PER_EVENT_OPT_OUT_FIELD_NAMES)) {
    if (!fieldName) continue;
    if (!(key in PER_EVENT_OPT_OUT_COLUMNS)) continue;
    const field = fieldName as PerEventField;
    const prevFlag =
      (previousPrefs as Record<string, unknown> | undefined)?.[field] as boolean | undefined
      ?? true;
    const nextFlag = (saved as unknown as Record<string, boolean>)[field];
    if (typeof nextFlag !== "boolean") continue;
    if (prevFlag === nextFlag) continue;
    perEventAuditRows.push({
      notificationKey: key,
      userId,
      // The dispatcher records `channel: "email"` for the email-link
      // mute path (the slug only ever appears in email footers); the
      // settings page is channel-agnostic but we keep the same value
      // so the existing audit surface filters/groups continue to work
      // without a schema-level change.
      channel: "email",
      status: "skipped",
      reason: nextFlag
        ? "event_opted_in_via_settings_page"
        : "event_opted_out_via_settings_page",
      payload: {
        source: "portal_notification_preferences",
        direction: nextFlag ? "resubscribe" : "unsubscribe",
        previousFlag: prevFlag,
        field,
      },
    });
  }
  if (perEventAuditRows.length > 0) {
    await db.insert(notificationAuditLogTable).values(perEventAuditRows);
  }

  // Task #1776 — Emit a one-time confirmation email when the controller
  // flipped EITHER stuck-erasure-digest channel from true→false in this
  // request. Restores parity with the email-side unsubscribe path
  // (Task #1242), which has always shown a confirmation page when its
  // link was clicked: until now the in-portal toggle silently flipped
  // the row with no record, so a mis-click or a shared session could
  // mute the digest invisibly. The send is rate-limited via the
  // `notifyErasureStorageDigestMuteConfirmationLastSentAt` watermark on
  // the prefs row so a quick toggle off → on → off doesn't spam the
  // recipient — the throttle window matches the typical "did you mean
  // it?" debounce most controllers settle on within a session.
  await maybeSendErasureDigestMuteConfirmation({
    req,
    userId,
    previousPrefs: previousPrefs ?? null,
    nextPrefs: {
      notifyErasureStorageDigest: saved.notifyErasureStorageDigest,
      notifyErasureStorageDigestPush: saved.notifyErasureStorageDigestPush,
    },
  });

  // Task #2219 — Generalises the Task #1776 in-portal mute confirmation
  // to every sibling controller digest in
  // `PORTAL_DIGEST_MUTE_REGISTRY` (wallet auto-refund failed, stuck
  // side-game receipts, per-levy / org-wide ledger CSV digest,
  // bounced-levy reminders, admin-exhaustion fallback, weekly silent-
  // failures CSV). Until now the in-portal toggle silently flipped
  // these columns with no email trail, so a mis-click or a shared
  // session could mute any of them invisibly. Each digest with a
  // genuine true→false transition in this PATCH gets its own
  // rate-limited confirmation email carrying its own 7-day signed
  // revert link — the helper iterates the registry and skips digests
  // whose flag did not transition or whose throttle window has not
  // elapsed.
  await maybeSendPortalDigestMuteConfirmations({
    req,
    userId,
    previousPrefs: (previousPrefs ?? null) as Record<string, unknown> | null,
    saved: saved as unknown as Record<string, unknown>,
  });

  // Task #2073 — write a `member_audit_log` row whenever a super admin
  // (or any caller, really — the field is super-admin-only by UI gating
  // but the API is uniform) flips `notifySilentAlertsDigest`. Until now
  // this PATCH path silently flipped the column with no record, so a
  // future incident where every super admin had opted out would leave
  // ops with no way to reconstruct who muted the weekly silent-failures
  // CSV digest or when. Mirrors the audit shape used by the
  // digest-preferences PATCH at the bottom of this file (entity =
  // "comm_prefs", entityId = userId, metadata.kind =
  // "silent_alerts_digest") so the existing per-member comm-prefs
  // audit-history UI surfaces it alongside the other digest toggles.
  //
  // We only emit on a true change (supplied AND value differs from the
  // pre-update read above) so a no-op save doesn't pollute the timeline.
  // Schema default for `notifySilentAlertsDigest` is true, so a missing
  // prefs row reads as "was on before this save" — matching the
  // dispatch cron's interpretation of the same column.
  if (
    typeof notifySilentAlertsDigest === "boolean"
    && (previousPrefs?.notifySilentAlertsDigest ?? true) !== notifySilentAlertsDigest
  ) {
    // The toggle is user-level (the silent-failures digest isn't owned
    // by any single club), but `member_audit_log.organization_id` is
    // FK to organizations.id and the per-org audit-history UI scopes
    // by orgId. Anchor the row to the caller's `app_users.organizationId`
    // so a super admin can find the entry on their own member-360
    // audit timeline. If the column is null (rare for super_admin) we
    // skip the audit — the toggle still saves; the audit just won't
    // surface on a per-org timeline. `metadata.scope = "user_level"`
    // mirrors the digest-preferences PATCH so per-org timeline
    // consumers can filter the row out of one club's audit feed.
    const [me] = await db
      .select({ orgId: appUsersTable.organizationId })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId))
      .limit(1);
    const anchorOrgId = me?.orgId ?? null;
    if (anchorOrgId !== null) {
      const previousValue = previousPrefs?.notifySilentAlertsDigest ?? true;
      await recordMemberAudit({
        req,
        organizationId: anchorOrgId,
        clubMemberId: null,
        entity: "comm_prefs",
        entityId: userId,
        action: "update",
        changes: {
          notifySilentAlertsDigest: { from: previousValue, to: notifySilentAlertsDigest },
        },
        reason: "Toggled from portal notification preferences",
        metadata: {
          source: "portal_notification_preferences",
          scope: "user_level",
          kind: "silent_alerts_digest",
          direction: notifySilentAlertsDigest ? "resubscribe" : "unsubscribe",
          targetUserId: userId,
        },
      });
    }
  }

  // Task #2141 — write a `member_audit_log` row whenever a coach (or
  // any caller — the field is coach-only by UI gating but the API is
  // uniform) flips `notifyAdminPayoutReverify`. Until now this PATCH
  // path silently flipped the column with no record, so when a coach
  // later complained "I never got the courtesy email after the admin
  // re-verified my payout account" support had no way to tell whether
  // the coach themselves had muted it. Mirrors the silent-alerts-digest
  // audit shape above (entity = "comm_prefs", entityId = userId,
  // metadata.kind = "admin_payout_reverify") so the existing per-member
  // comm-prefs audit-history UI surfaces it alongside the other digest
  // toggles.
  //
  // We only emit on a true change (supplied AND value differs from the
  // pre-update read above) so a no-op save doesn't pollute the timeline.
  // Schema default for `notifyAdminPayoutReverify` is true, so a missing
  // prefs row reads as "was on before this save" — matching the
  // re-verify mailer's interpretation of the same column.
  if (
    typeof notifyAdminPayoutReverify === "boolean"
    && (previousPrefs?.notifyAdminPayoutReverify ?? true) !== notifyAdminPayoutReverify
  ) {
    // The toggle is user-level (the courtesy email isn't owned by any
    // single club — a coach can teach across multiple orgs), but
    // `member_audit_log.organization_id` is FK to organizations.id and
    // the per-org audit-history UI scopes by orgId. Anchor the row to
    // the caller's `app_users.organizationId` so support can find the
    // entry on their member-360 audit timeline. If the column is null
    // (rare) we skip the audit — the toggle still saves; the audit
    // just won't surface on a per-org timeline. `metadata.scope =
    // "user_level"` mirrors the silent-alerts-digest audit so per-org
    // timeline consumers can filter the row out of one club's feed.
    const [me] = await db
      .select({ orgId: appUsersTable.organizationId })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId))
      .limit(1);
    const anchorOrgId = me?.orgId ?? null;
    if (anchorOrgId !== null) {
      const previousValue = previousPrefs?.notifyAdminPayoutReverify ?? true;
      await recordMemberAudit({
        req,
        organizationId: anchorOrgId,
        clubMemberId: null,
        entity: "comm_prefs",
        entityId: userId,
        action: "update",
        changes: {
          notifyAdminPayoutReverify: { from: previousValue, to: notifyAdminPayoutReverify },
        },
        reason: "Toggled from portal notification preferences",
        metadata: {
          source: "portal_notification_preferences",
          scope: "user_level",
          kind: "admin_payout_reverify",
          direction: notifyAdminPayoutReverify ? "resubscribe" : "unsubscribe",
          targetUserId: userId,
        },
      });
    }
  }

  // Task #2215 — write a `member_audit_log` row whenever the controller
  // flips `notifyErasureStorageDigest` from the in-portal settings page.
  // The GET handler above (`/api/portal/notification-preferences`) now
  // queries the latest `comm_prefs / erasure_storage_digest` audit row
  // regardless of source and only surfaces the "Last changed via email
  // link" hint when that latest row is the public unsubscribe-link
  // click — so a portal-side toggle naturally supersedes the link-driven
  // row and the misleading hint disappears, without us having to delete
  // the historical entry. Mirrors the silent-alerts-digest and
  // admin-payout-reverify shapes immediately above (entity =
  // "comm_prefs", entityId = userId, source =
  // "portal_notification_preferences", kind = "erasure_storage_digest")
  // so the existing per-member comm-prefs audit-history UI surfaces it
  // alongside the email-link rows.
  //
  // We only emit on a true change (supplied AND value differs from the
  // pre-update read above) so a no-op save doesn't pollute the timeline
  // and — critically — doesn't accidentally suppress the link-change
  // hint when the controller saves an unrelated preference. Schema
  // default for `notifyErasureStorageDigest` is true, so a missing
  // prefs row reads as "was on before this save".
  if (
    typeof notifyErasureStorageDigest === "boolean"
    && (previousPrefs?.notifyErasureStorageDigest ?? true) !== notifyErasureStorageDigest
  ) {
    // Anchor the row to the caller's `app_users.organizationId` (same
    // pattern as silent-alerts-digest / admin-payout-reverify above)
    // because `member_audit_log.organization_id` is FK-non-null. If
    // the column is null we skip the audit — the toggle still saves;
    // the GET-side hint suppression keys on the row's existence so a
    // skipped audit means the link-change hint will continue to show
    // until the org column is populated. `metadata.scope = "user_level"`
    // mirrors the digest-preferences PATCH so per-org timeline
    // consumers can filter the row out of one club's audit feed.
    const [meErasure] = await db
      .select({ orgId: appUsersTable.organizationId })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId))
      .limit(1);
    const anchorOrgIdErasure = meErasure?.orgId ?? null;
    if (anchorOrgIdErasure !== null) {
      const previousValue = previousPrefs?.notifyErasureStorageDigest ?? true;
      await recordMemberAudit({
        req,
        organizationId: anchorOrgIdErasure,
        clubMemberId: null,
        entity: "comm_prefs",
        entityId: userId,
        action: "update",
        changes: {
          notifyErasureStorageDigest: { from: previousValue, to: notifyErasureStorageDigest },
        },
        reason: "Toggled from portal notification preferences",
        metadata: {
          source: "portal_notification_preferences",
          scope: "user_level",
          kind: "erasure_storage_digest",
          direction: notifyErasureStorageDigest ? "resubscribe" : "unsubscribe",
          targetUserId: userId,
        },
      });
    }
  }

  res.json(saved);
});

/**
 * Task #1776 — throttle window for the in-portal stuck-erasure mute
 * confirmation email. Long enough that a controller who toggles
 * off → on → off within the same session only triggers a single
 * confirmation, short enough that a deliberate re-mute days later still
 * confirms. Exposed (not inlined) so the test suite can assert the
 * suppression behaviour without hard-coding the constant in two places.
 */
export const ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS = 5 * 60 * 1000;

async function maybeSendErasureDigestMuteConfirmation(args: {
  req: Request;
  userId: number;
  previousPrefs: {
    notifyErasureStorageDigest: boolean;
    notifyErasureStorageDigestPush: boolean;
    notifyErasureStorageDigestMuteConfirmationLastSentAt: Date | null;
  } | null;
  nextPrefs: {
    notifyErasureStorageDigest: boolean;
    notifyErasureStorageDigestPush: boolean;
  };
}): Promise<void> {
  const { req, userId, previousPrefs, nextPrefs } = args;
  // Schema default is true, so a missing prefs row reads as "both
  // channels were on". Detect a true→false transition for each channel
  // independently — the confirmation email then names which one(s)
  // moved so the recipient sees exactly what they (or someone with
  // their session) just changed.
  const prevEmail = previousPrefs?.notifyErasureStorageDigest ?? true;
  const prevPush = previousPrefs?.notifyErasureStorageDigestPush ?? true;
  const emailMuted = prevEmail === true && nextPrefs.notifyErasureStorageDigest === false;
  const pushMuted = prevPush === true && nextPrefs.notifyErasureStorageDigestPush === false;
  if (!emailMuted && !pushMuted) return;

  // Rate limit: skip the send when the watermark column says we already
  // confirmed inside the throttle window. We DO NOT advance the
  // watermark on a suppressed call so a controller who genuinely
  // re-mutes the next day still gets a fresh confirmation — the
  // dedup key is "the previous confirmation we actually sent", not
  // "the previous toggle event".
  const lastSentAt = previousPrefs?.notifyErasureStorageDigestMuteConfirmationLastSentAt ?? null;
  if (lastSentAt instanceof Date) {
    const ageMs = Date.now() - lastSentAt.getTime();
    if (ageMs >= 0 && ageMs < ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS) {
      baseLogger.debug(
        { userId, ageMs, throttleMs: ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS },
        "[portal] erasure-digest mute confirmation suppressed by rate limit",
      );
      return;
    }
  }

  // Fetch the controller's email + display name. A controller without
  // an email address on file cannot receive the confirmation — log and
  // move on (the toggle still applied; we just can't confirm via mail).
  const [user] = await db
    .select({
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId));
  if (!user?.email) {
    baseLogger.info({ userId }, "[portal] erasure-digest mute confirmation skipped — no email on file");
    return;
  }

  // Pick a controller-role org for the confirmation email's branding +
  // token orgId. A user with no controller membership cannot have been
  // receiving the digest in the first place, so it's vanishingly rare
  // to land here without one — but we degrade gracefully (orgId=0,
  // generic branding) rather than skip the confirmation, because the
  // user-level mute still applied across every org they control.
  const CONTROLLER_ROLES = ["org_admin", "membership_secretary", "treasurer"] as const;
  const [membership] = await db
    .select({
      organizationId: orgMembershipsTable.organizationId,
      orgName: organizationsTable.name,
      orgLogoUrl: organizationsTable.logoUrl,
      orgPrimaryColor: organizationsTable.primaryColor,
    })
    .from(orgMembershipsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, orgMembershipsTable.organizationId))
    .where(and(
      eq(orgMembershipsTable.userId, userId),
      inArray(orgMembershipsTable.role, CONTROLLER_ROLES as unknown as never[]),
    ))
    .orderBy(asc(orgMembershipsTable.organizationId))
    .limit(1);

  const orgIdForToken = membership?.organizationId ?? 0;
  const channels: ErasureDigestMuteRevertChannels = emailMuted && pushMuted
    ? "b"
    : emailMuted
      ? "e"
      : "p";

  const baseUrl = (process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`).replace(/\/$/, "");
  const token = signErasureDigestMuteRevertToken(userId, orgIdForToken, channels);
  const revertUrl = `${baseUrl}/api/public/erasure-digest-portal-mute-revert?token=${encodeURIComponent(token)}`;

  const branding = membership
    ? {
        ...(await resolveOrgBranding(membership.organizationId, {
          name: membership.orgName,
          logoUrl: membership.orgLogoUrl,
          primaryColor: membership.orgPrimaryColor,
        })),
        orgId: membership.organizationId,
      }
    : undefined;

  const staffName = user.displayName || user.username || "there";
  try {
    await sendErasureStorageDigestMutedConfirmationEmail({
      to: user.email,
      staffName,
      baseUrl,
      mutedChannels: { email: emailMuted, push: pushMuted },
      revertUrl,
      branding,
    });
    // Only stamp the watermark AFTER a successful send so a transient
    // mailer outage doesn't suppress the next genuine attempt.
    await db.update(userNotificationPrefsTable)
      .set({ notifyErasureStorageDigestMuteConfirmationLastSentAt: new Date() })
      .where(eq(userNotificationPrefsTable.userId, userId));
  } catch (err) {
    baseLogger.warn(
      { err, userId, channels },
      "[portal] erasure-digest mute confirmation email failed",
    );
  }
}

/**
 * Task #2219 — Iterates {@link PORTAL_DIGEST_MUTE_SPECS} and emits one
 * confirmation email per sibling controller digest that just
 * transitioned true→false in this PATCH. Mirrors the stuck-erasure
 * helper above one digest at a time so a single PATCH that mutes two
 * siblings (e.g. wallet-refund + levy-ledger together) sends two
 * separate confirmations — recipients see exactly which digest moved
 * and each carries its own revert link.
 *
 * Watermarks live in `portal_digest_mute_confirmation_sends` keyed on
 * (user_id, digest_slug). The same throttle window as the erasure
 * confirmation ({@link ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS},
 * 5 minutes) — long enough that an off→on→off toggle inside a session
 * only sends once per digest, short enough that a deliberate re-mute
 * later still confirms. The watermark row is upserted only AFTER a
 * successful send so a transient mailer outage doesn't poison the next
 * genuine attempt.
 *
 * Defensive against unrelated failures: each digest is processed in
 * its own try/catch so a mailer error on, say, the wallet-refund
 * confirmation does not prevent the levy-ledger confirmation from
 * being sent in the same request.
 */
async function maybeSendPortalDigestMuteConfirmations(args: {
  req: Request;
  userId: number;
  previousPrefs: Record<string, unknown> | null;
  saved: Record<string, unknown>;
}): Promise<void> {
  const { req, userId, previousPrefs, saved } = args;
  // First pass: detect transitions so we can short-circuit when nothing
  // moved (the common case for every PATCH that doesn't touch a
  // registry'd column).
  const transitioned: PortalDigestMuteSpec[] = [];
  for (const spec of PORTAL_DIGEST_MUTE_SPECS) {
    const prevFlag = (previousPrefs?.[spec.prefField] as boolean | undefined) ?? true;
    const nextFlag = saved[spec.prefField];
    if (typeof nextFlag !== "boolean") continue;
    if (prevFlag === true && nextFlag === false) transitioned.push(spec);
  }
  if (transitioned.length === 0) return;

  // Single fetch of the controller's email + display name shared across
  // every transition in this PATCH — they all email the same address.
  const [user] = await db
    .select({
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId));
  if (!user?.email) {
    baseLogger.info(
      { userId, slugs: transitioned.map(s => s.slug) },
      "[portal] portal-digest mute confirmation skipped — no email on file",
    );
    return;
  }

  // Single per-(user, digest) watermark read for the registry's slugs.
  // We resolve the in-flight throttle window against the same Date.now
  // for every spec so concurrent transitions get consistent decisions.
  const { portalDigestMuteConfirmationSendsTable } = await import("@workspace/db");
  const watermarkRows = await db
    .select({
      digestSlug: portalDigestMuteConfirmationSendsTable.digestSlug,
      lastSentAt: portalDigestMuteConfirmationSendsTable.lastSentAt,
    })
    .from(portalDigestMuteConfirmationSendsTable)
    .where(and(
      eq(portalDigestMuteConfirmationSendsTable.userId, userId),
      inArray(
        portalDigestMuteConfirmationSendsTable.digestSlug,
        transitioned.map(s => s.slug),
      ),
    ));
  const watermarkBySlug = new Map<string, Date>();
  for (const row of watermarkRows) watermarkBySlug.set(row.digestSlug, row.lastSentAt);

  // Pick a controller-role org for branding once — same logic as the
  // erasure helper, same fallback (orgId=0 + generic branding) when the
  // user has no controller membership at all.
  const CONTROLLER_ROLES = ["org_admin", "membership_secretary", "treasurer"] as const;
  const [membership] = await db
    .select({
      organizationId: orgMembershipsTable.organizationId,
      orgName: organizationsTable.name,
      orgLogoUrl: organizationsTable.logoUrl,
      orgPrimaryColor: organizationsTable.primaryColor,
    })
    .from(orgMembershipsTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, orgMembershipsTable.organizationId))
    .where(and(
      eq(orgMembershipsTable.userId, userId),
      inArray(orgMembershipsTable.role, CONTROLLER_ROLES as unknown as never[]),
    ))
    .orderBy(asc(orgMembershipsTable.organizationId))
    .limit(1);

  const orgIdForToken = membership?.organizationId ?? 0;
  const baseUrl = (process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`).replace(/\/$/, "");
  const branding = membership
    ? {
        ...(await resolveOrgBranding(membership.organizationId, {
          name: membership.orgName,
          logoUrl: membership.orgLogoUrl,
          primaryColor: membership.orgPrimaryColor,
        })),
        orgId: membership.organizationId,
      }
    : undefined;
  const staffName = user.displayName || user.username || "there";

  for (const spec of transitioned) {
    // Throttle check per slug — skipping does NOT advance the
    // watermark, so a controller who genuinely re-mutes after the
    // window elapses still gets a fresh confirmation.
    const lastSentAt = watermarkBySlug.get(spec.slug);
    if (lastSentAt instanceof Date) {
      const ageMs = Date.now() - lastSentAt.getTime();
      if (ageMs >= 0 && ageMs < ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS) {
        baseLogger.debug(
          { userId, slug: spec.slug, ageMs, throttleMs: ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS },
          "[portal] portal-digest mute confirmation suppressed by rate limit",
        );
        continue;
      }
    }

    const token = signPortalDigestMuteRevertToken(userId, orgIdForToken, spec.slug);
    const revertUrl = `${baseUrl}/api/public/portal-digest-mute-revert?token=${encodeURIComponent(token)}`;

    try {
      await sendPortalDigestMutedConfirmationEmail({
        to: user.email,
        staffName,
        baseUrl,
        digest: {
          subject: spec.subject,
          headlineHtml: spec.headlineHtml,
          digestNameHtml: spec.digestNameHtml,
          audienceHtml: spec.audienceHtml,
        },
        revertUrl,
        branding,
      });
      // Stamp the watermark only AFTER a successful send so a
      // transient mailer outage doesn't suppress the next genuine
      // attempt for this digest.
      const sentAt = new Date();
      await db.insert(portalDigestMuteConfirmationSendsTable)
        .values({ userId, digestSlug: spec.slug, lastSentAt: sentAt })
        .onConflictDoUpdate({
          target: [
            portalDigestMuteConfirmationSendsTable.userId,
            portalDigestMuteConfirmationSendsTable.digestSlug,
          ],
          set: { lastSentAt: sentAt },
        });
    } catch (err) {
      baseLogger.warn(
        { err, userId, slug: spec.slug },
        "[portal] portal-digest mute confirmation email failed",
      );
    }
  }
  // Mark `req` as observed so TypeScript's noUnusedParameters / our
  // request-scoped logger middleware don't complain about unused locals
  // — kept for parity with the erasure helper and so future audit
  // hooks can reach back to the request without changing the signature.
  void req;
}

// Task #1775 — GET /api/portal/notification-audit
//
// Surface the signed-in user's recent suppressed-notification audit rows so
// controllers who muted both channels for an alert (e.g.
// `privacy.erasure.storage_failures.controller_digest`) can still see that
// the cron tried to reach them. Without this endpoint the only trace of a
// fully-muted alert is a `skipped/event_opted_out` row in
// `notification_audit_log` with no UI surface, which means a real outage can
// hide forever.
//
// Returns rows with `status = 'skipped'` for the current user, defaulting to
// the last 30 days, sorted newest-first. Each row carries a `kind`
// discriminator so the UI can clearly distinguish "you muted this"
// (`reason = 'event_opted_out'`) from "system suppressed" (anything else,
// e.g. `no_address`, `no_email_on_file`, `all_channels_opted_out`).
//
// Pagination: cursor-based via `?before=<ISO8601>` (rows strictly older than
// the given timestamp). The default `limit` is 50, capped at 200.
// `?days` controls the lower bound of the time window (default 30, max 365).
// `?key` optionally narrows to a single notification key so the comm-prefs
// page can deep-link to "show me what I missed for THIS alert".
router.get("/portal/notification-audit", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const rawDays = Number.parseInt(String(req.query.days ?? ""), 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30;
  const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const beforeRaw = typeof req.query.before === "string" ? req.query.before.trim() : "";
  let before: Date | null = null;
  if (beforeRaw) {
    const parsed = new Date(beforeRaw);
    if (Number.isFinite(parsed.getTime())) before = parsed;
  }

  const keyFilter = typeof req.query.key === "string" && req.query.key.trim().length > 0
    ? req.query.key.trim()
    : null;

  const conditions = [
    eq(notificationAuditLogTable.userId, userId),
    eq(notificationAuditLogTable.status, "skipped"),
    gte(notificationAuditLogTable.createdAt, since),
  ];
  if (before) conditions.push(sql`${notificationAuditLogTable.createdAt} < ${before}`);
  if (keyFilter) conditions.push(eq(notificationAuditLogTable.notificationKey, keyFilter));

  // Pull one extra row beyond `limit` so we can compute `hasMore` without a
  // separate count query — the audit table is append-only and the index on
  // (userId, createdAt) makes this cheap for the per-user scan.
  const rows = await db.select({
    id: notificationAuditLogTable.id,
    notificationKey: notificationAuditLogTable.notificationKey,
    channel: notificationAuditLogTable.channel,
    status: notificationAuditLogTable.status,
    reason: notificationAuditLogTable.reason,
    payload: notificationAuditLogTable.payload,
    createdAt: notificationAuditLogTable.createdAt,
    category: notificationTypeRegistryTable.category,
    description: notificationTypeRegistryTable.description,
  })
    .from(notificationAuditLogTable)
    .leftJoin(
      notificationTypeRegistryTable,
      eq(notificationAuditLogTable.notificationKey, notificationTypeRegistryTable.key),
    )
    .where(and(...conditions))
    .orderBy(desc(notificationAuditLogTable.createdAt), desc(notificationAuditLogTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const nextBefore = hasMore && trimmed.length > 0
    ? (trimmed[trimmed.length - 1].createdAt as Date).toISOString()
    : null;

  const entries = trimmed.map(r => {
    const isUserMuted = r.reason === "event_opted_out";
    return {
      id: r.id,
      notificationKey: r.notificationKey,
      category: r.category ?? null,
      description: r.description ?? null,
      channel: r.channel,
      status: r.status,
      reason: r.reason,
      // Discriminator for the UI: "user_muted" vs "system_suppressed". Keeps
      // the source-of-truth (`reason`) intact so future reasons added by the
      // dispatcher don't require a UI redeploy to surface — they just fall
      // into the `system_suppressed` bucket until explicitly re-classified.
      kind: isUserMuted ? "user_muted" as const : "system_suppressed" as const,
      payload: r.payload ?? {},
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    };
  });

  res.json({
    entries,
    windowDays: days,
    limit,
    hasMore,
    nextBefore,
  });
});

// Task #1170 — GET /api/portal/notification-key-prefs
// Returns every digestable notification key in the registry, with the
// authenticated user's per-key delivery override (or null when no
// override is set, in which case the global `digestMode` flag applies).
// Only digestable keys are returned — non-digestable keys always send
// in real-time and have no override to display.
router.get("/portal/notification-key-prefs", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const [registryRows, keyPrefRows, [globalPrefs]] = await Promise.all([
    db.select({
      key: notificationTypeRegistryTable.key,
      category: notificationTypeRegistryTable.category,
      description: notificationTypeRegistryTable.description,
    }).from(notificationTypeRegistryTable)
      .where(eq(notificationTypeRegistryTable.digestable, true)),
    db.select({
      notificationKey: userNotificationKeyPrefsTable.notificationKey,
      deliveryMode: userNotificationKeyPrefsTable.deliveryMode,
    }).from(userNotificationKeyPrefsTable)
      .where(eq(userNotificationKeyPrefsTable.userId, userId)),
    db.select({ digestMode: userNotificationPrefsTable.digestMode })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId)),
  ]);

  const overrideMap = new Map<string, "realtime" | "digest">();
  for (const r of keyPrefRows) {
    if (r.deliveryMode === "realtime" || r.deliveryMode === "digest") {
      overrideMap.set(r.notificationKey, r.deliveryMode);
    }
  }
  const digestMode = globalPrefs?.digestMode ?? false;

  const keys = registryRows
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(r => {
      const override = overrideMap.get(r.key) ?? null;
      return {
        key: r.key,
        category: r.category,
        description: r.description,
        override,
        effectiveMode: override ?? (digestMode ? "digest" : "realtime"),
      };
    });

  res.json({ digestMode, keys });
});

// Task #1170 — PATCH /api/portal/notification-key-prefs
// Sets the authenticated user's per-key delivery override for a single
// digestable notification key. Body: { key: string, deliveryMode:
// "realtime" | "digest" | null }. Passing null clears the override so
// the key inherits the user's global digestMode again.
router.patch("/portal/notification-key-prefs", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const { key, deliveryMode } = req.body as { key?: unknown; deliveryMode?: unknown };

  if (typeof key !== "string" || key.length === 0) {
    res.status(400).json({ error: "key is required" });
    return;
  }
  if (deliveryMode !== null && deliveryMode !== "realtime" && deliveryMode !== "digest") {
    res.status(400).json({ error: "deliveryMode must be 'realtime', 'digest', or null" });
    return;
  }

  // Validate the key exists in the registry AND is actually digestable —
  // it would be misleading to let a player save a "digest" preference for
  // a key the dispatcher will always send immediately anyway.
  const [reg] = await db.select({
    key: notificationTypeRegistryTable.key,
    digestable: notificationTypeRegistryTable.digestable,
  }).from(notificationTypeRegistryTable)
    .where(eq(notificationTypeRegistryTable.key, key))
    .limit(1);
  if (!reg) {
    res.status(404).json({ error: "Unknown notification key" });
    return;
  }
  if (!reg.digestable) {
    res.status(400).json({ error: "Notification key is not digestable" });
    return;
  }

  if (deliveryMode === null) {
    await db.delete(userNotificationKeyPrefsTable)
      .where(and(
        eq(userNotificationKeyPrefsTable.userId, userId),
        eq(userNotificationKeyPrefsTable.notificationKey, key),
      ));
    res.json({ key, override: null });
    return;
  }

  const now = new Date();
  await db.insert(userNotificationKeyPrefsTable)
    .values({ userId, notificationKey: key, deliveryMode, updatedAt: now })
    .onConflictDoUpdate({
      target: [userNotificationKeyPrefsTable.userId, userNotificationKeyPrefsTable.notificationKey],
      set: { deliveryMode, updatedAt: now },
    });
  res.json({ key, override: deliveryMode });
});

// Task #1353 — DELETE /api/portal/notification-key-prefs
// Wipes every per-key delivery override the authenticated user has set,
// so each notification key falls back to the global digest_mode flag.
// Returns the number of rows deleted so the client can show feedback.
router.delete("/portal/notification-key-prefs", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const deleted = await db.delete(userNotificationKeyPrefsTable)
    .where(eq(userNotificationKeyPrefsTable.userId, userId))
    .returning({ notificationKey: userNotificationKeyPrefsTable.notificationKey });

  res.json({ cleared: deleted.length });
});

// POST /api/portal/tournament-player/:playerId/payment-link
// Generates (or returns cached) a Razorpay payment link for the requesting player
router.post("/portal/tournament-player/:playerId/payment-link", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  if (isNaN(playerId)) { { res.status(400).json({ error: "Invalid player ID" }); return; } }

  const [player] = await db
    .select({
      id: playersTable.id, userId: playersTable.userId,
      firstName: playersTable.firstName, lastName: playersTable.lastName, email: playersTable.email,
      paymentStatus: playersTable.paymentStatus, paymentLinkId: playersTable.paymentLinkId,
      paymentLinkUrl: playersTable.paymentLinkUrl, tournamentId: playersTable.tournamentId,
    })
    .from(playersTable)
    .where(eq(playersTable.id, playerId));

  if (!player) { { res.status(404).json({ error: "Player entry not found" }); return; } }
  // Ensure the requesting user owns this entry
  if (player.userId !== req.user!.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (player.paymentStatus === "paid") { { res.status(400).json({ error: "Already paid" }); return; } }
  if (player.paymentLinkUrl) { { res.json({ url: player.paymentLinkUrl, existing: true }); return; } }

  const [tournament] = await db
    .select({ name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, player.tournamentId));

  if (!tournament?.entryFee) { { res.status(400).json({ error: "Tournament has no entry fee" }); return; } }

  try {
    const razorpay = getRazorpayClient();
    const currency = (tournament.currency as string | null) ?? "INR";
    const amountSubunit = Math.round(Number(tournament.entryFee) * 100);
    const opts: RazorpayPaymentLinkCreateOpts = {
      amount: amountSubunit, currency,
      description: `Entry fee — ${tournament.name}`,
      customer: { name: `${player.firstName} ${player.lastName}`, email: player.email ?? undefined },
      notify: { email: !!player.email },
      upi_link: currency === "INR",
      expire_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      callback_url: process.env.RAZORPAY_CALLBACK_URL,
      reference_id: `tp_${player.id}`,
      notes: { playerId: String(player.id), tournamentId: String(player.tournamentId) },
    };
    const link = await razorpay.paymentLink.create(opts);
    await db.update(playersTable)
      .set({ paymentLinkId: link.id, paymentLinkUrl: link.short_url })
      .where(eq(playersTable.id, playerId));
    res.json({ url: link.short_url });
  } catch (err: unknown) {
    const msg = err !== null && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Failed to create payment link";
    res.status(500).json({ error: msg });
  }
});

// POST /api/portal/league-member/:memberId/payment-link
// Generates (or returns cached) a Razorpay payment link for the requesting league member.
router.post("/portal/league-member/:memberId/payment-link", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (isNaN(memberId)) { { res.status(400).json({ error: "Invalid member ID" }); return; } }

  const [member] = await db
    .select({
      id: leagueMembersTable.id, userId: leagueMembersTable.userId,
      firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName,
      email: leagueMembersTable.email, paymentStatus: leagueMembersTable.paymentStatus,
      paymentLinkId: leagueMembersTable.paymentLinkId, paymentLinkUrl: leagueMembersTable.paymentLinkUrl,
      leagueId: leagueMembersTable.leagueId,
    })
    .from(leagueMembersTable)
    .where(eq(leagueMembersTable.id, memberId));

  if (!member) { { res.status(404).json({ error: "League member entry not found" }); return; } }
  if (member.userId !== req.user!.id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (member.paymentStatus === "paid") { { res.status(400).json({ error: "Already paid" }); return; } }
  if (member.paymentLinkUrl) { { res.json({ url: member.paymentLinkUrl, existing: true }); return; } }

  const [league] = await db
    .select({ name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency })
    .from(leaguesTable)
    .where(eq(leaguesTable.id, member.leagueId));

  if (!league?.entryFee) { { res.status(400).json({ error: "League has no entry fee" }); return; } }

  try {
    const razorpay = getRazorpayClient();
    const currency = (league.currency as string | null) ?? "INR";
    const amountSubunit = Math.round(Number(league.entryFee) * 100);
    const opts: RazorpayPaymentLinkCreateOpts = {
      amount: amountSubunit, currency,
      description: `Entry fee — ${league.name}`,
      customer: { name: `${member.firstName} ${member.lastName}`, email: member.email ?? undefined },
      notify: { email: !!member.email },
      upi_link: currency === "INR",
      expire_by: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      callback_url: process.env.RAZORPAY_CALLBACK_URL,
      reference_id: `lm_${member.id}`,
      notes: { memberId: String(member.id) },
    };
    const link = await razorpay.paymentLink.create(opts);
    await db.update(leagueMembersTable)
      .set({ paymentLinkId: link.id, paymentLinkUrl: link.short_url })
      .where(eq(leagueMembersTable.id, memberId));
    res.json({ url: link.short_url });
  } catch (err: unknown) {
    const msg = err !== null && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : "Failed to create payment link";
    res.status(500).json({ error: msg });
  }
});

// GET /api/portal/tournament-player/:playerId/receipt
// Lets the authenticated player download their own PDF receipt (no admin required).
router.get("/portal/tournament-player/:playerId/receipt", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  if (isNaN(playerId)) { { res.status(400).json({ error: "Invalid player ID" }); return; } }

  const [player] = await db
    .select({ id: playersTable.id, userId: playersTable.userId, paymentStatus: playersTable.paymentStatus })
    .from(playersTable).where(eq(playersTable.id, playerId));
  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (player.userId !== (req.user as { id: number }).id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (player.paymentStatus !== "paid") { { res.status(400).json({ error: "No receipt — payment not yet made" }); return; } }

  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) { { res.status(503).json({ error: "Object storage not configured" }); return; } }
  const withoutScheme = privateDir.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  const bucketName = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
  const dirPrefix = slashIdx === -1 ? "" : withoutScheme.slice(slashIdx + 1) + "/";
  const osc = objectStorageClient;
  const bucket = osc.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: `${dirPrefix}receipts/player_${playerId}_` });
  if (!files.length) { { res.status(404).json({ error: "Receipt PDF not yet available" }); return; } }
  const latest = files.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="receipt_player_${playerId}.pdf"`);
  latest.createReadStream().pipe(res);
});

// GET /api/portal/league-member/:memberId/receipt
// Lets the authenticated player download their own league membership PDF receipt.
router.get("/portal/league-member/:memberId/receipt", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (isNaN(memberId)) { { res.status(400).json({ error: "Invalid member ID" }); return; } }

  const [member] = await db
    .select({ id: leagueMembersTable.id, userId: leagueMembersTable.userId, paymentStatus: leagueMembersTable.paymentStatus })
    .from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  if (member.userId !== (req.user as { id: number }).id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (member.paymentStatus !== "paid") { { res.status(400).json({ error: "No receipt — payment not yet made" }); return; } }

  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) { { res.status(503).json({ error: "Object storage not configured" }); return; } }
  const withoutScheme = privateDir.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  const bucketName = slashIdx === -1 ? withoutScheme : withoutScheme.slice(0, slashIdx);
  const dirPrefix = slashIdx === -1 ? "" : withoutScheme.slice(slashIdx + 1) + "/";
  const osc = objectStorageClient;
  const bucket = osc.bucket(bucketName);
  const [files] = await bucket.getFiles({ prefix: `${dirPrefix}receipts/league_member_${memberId}_` });
  if (!files.length) { { res.status(404).json({ error: "Receipt PDF not yet available" }); return; } }
  const latest = files.sort((a, b) => a.name.localeCompare(b.name)).at(-1)!;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="receipt_member_${memberId}.pdf"`);
  latest.createReadStream().pipe(res);
});

// POST /api/portal/league-member/:memberId/order
// Creates a checkout order for native mobile SDK checkout (iOS/Android) for a league member entry.
// Routes through createCheckoutOrder so non-INR clubs receive Stripe credentials
// while INR clubs continue with Razorpay. Response includes `processor` plus the
// processor-specific fields (clientSecret/stripePublishableKey for Stripe;
// orderId/keyId for Razorpay).
router.post("/portal/league-member/:memberId/order", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const memberId = parseInt(String((req.params as Record<string, string>).memberId));
  if (isNaN(memberId)) { { res.status(400).json({ error: "Invalid member ID" }); return; } }

  const [member] = await db
    .select({
      id: leagueMembersTable.id, userId: leagueMembersTable.userId,
      firstName: leagueMembersTable.firstName, lastName: leagueMembersTable.lastName,
      email: leagueMembersTable.email, paymentStatus: leagueMembersTable.paymentStatus,
      leagueId: leagueMembersTable.leagueId,
    })
    .from(leagueMembersTable).where(eq(leagueMembersTable.id, memberId));

  if (!member) { { res.status(404).json({ error: "Member entry not found" }); return; } }
  if (member.userId !== (req.user as { id: number }).id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (member.paymentStatus === "paid") { { res.status(400).json({ error: "Already paid" }); return; } }

  const [league] = await db
    .select({ id: leaguesTable.id, name: leaguesTable.name, entryFee: leaguesTable.entryFee, currency: leaguesTable.currency, organizationId: leaguesTable.organizationId })
    .from(leaguesTable).where(eq(leaguesTable.id, member.leagueId));

  if (!league?.entryFee) { { res.status(400).json({ error: "League has no entry fee" }); return; } }

  const currency = (league.currency as string | null) ?? "INR";
  const checkout = await createCheckoutOrder({
    organizationId: league.organizationId,
    amount: Number(league.entryFee),
    currency,
    receipt: `member_${memberId}`,
    description: `Entry fee — ${league.name}`,
    customerEmail: member.email ?? undefined,
    metadata: { memberId: String(memberId), leagueId: String(league.id) },
    sourceType: "league_entry",
    sourceId: memberId,
  });

  await db.update(leagueMembersTable).set({ razorpayOrderId: checkout.orderId }).where(eq(leagueMembersTable.id, memberId));

  res.json({
    processor: checkout.processor,
    orderId: checkout.orderId,
    amount: checkout.amountMinor,
    currency: checkout.currency,
    keyId: checkout.razorpayKeyId,
    stripePublishableKey: checkout.stripePublishableKey,
    clientSecret: checkout.clientSecret,
    name: league.name,
    memberName: `${member.firstName} ${member.lastName}`,
    email: member.email ?? undefined,
  });
});

// POST /api/portal/tournament-player/:playerId/order
// Creates a checkout order for native mobile SDK checkout (iOS/Android).
// Routes through createCheckoutOrder so non-INR clubs receive Stripe credentials
// while INR clubs continue with Razorpay. Response includes `processor` plus the
// processor-specific fields (clientSecret/stripePublishableKey for Stripe;
// orderId/keyId for Razorpay).
router.post("/portal/tournament-player/:playerId/order", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  if (isNaN(playerId)) { { res.status(400).json({ error: "Invalid player ID" }); return; } }

  const [player] = await db
    .select({
      id: playersTable.id, userId: playersTable.userId,
      firstName: playersTable.firstName, lastName: playersTable.lastName,
      email: playersTable.email, paymentStatus: playersTable.paymentStatus,
      tournamentId: playersTable.tournamentId,
    })
    .from(playersTable)
    .where(eq(playersTable.id, playerId));

  if (!player) { { res.status(404).json({ error: "Player entry not found" }); return; } }
  if (player.userId !== (req.user as { id: number }).id) { { res.status(403).json({ error: "Forbidden" }); return; } }
  if (player.paymentStatus === "paid") { { res.status(400).json({ error: "Already paid" }); return; } }

  const [tournament] = await db
    .select({ id: tournamentsTable.id, name: tournamentsTable.name, entryFee: tournamentsTable.entryFee, currency: tournamentsTable.currency, organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, player.tournamentId));

  if (!tournament?.entryFee) { { res.status(400).json({ error: "Tournament has no entry fee" }); return; } }

  const currency = (tournament.currency as string | null) ?? "INR";
  const checkout = await createCheckoutOrder({
    organizationId: tournament.organizationId,
    amount: Number(tournament.entryFee),
    currency,
    receipt: `player_${playerId}`,
    description: `Entry fee — ${tournament.name}`,
    customerEmail: player.email ?? undefined,
    metadata: { playerId: String(playerId), tournamentId: String(tournament.id) },
    sourceType: "tournament_entry",
    sourceId: playerId,
  });

  await db.update(playersTable).set({ razorpayOrderId: checkout.orderId }).where(eq(playersTable.id, playerId));

  res.json({
    processor: checkout.processor,
    orderId: checkout.orderId,
    amount: checkout.amountMinor,
    currency: checkout.currency,
    keyId: checkout.razorpayKeyId,
    stripePublishableKey: checkout.stripePublishableKey,
    clientSecret: checkout.clientSecret,
    name: tournament.name,
    playerName: `${player.firstName} ${player.lastName}`,
    email: player.email ?? undefined,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/portal/stats — comprehensive player stats (scoring, fairways, GIR, putts, handicap trend)
// Query params:
//   ?period=allTime|thisYear|last5rounds|last10rounds|last12rounds|last20rounds  (default: allTime)
//   ?dateFrom=YYYY-MM-DD                   (custom range start, overrides period)
//   ?dateTo=YYYY-MM-DD                     (custom range end, overrides period)
//   ?courseId=<number>                     (filter to a specific course)
//   ?baseline=scratch|10|18               (SG baseline one-off override; when
//                                          omitted the server resolves it from
//                                          the player's pinned preference, or
//                                          auto-derives it from their current
//                                          handicap index — see Task #1643)
//   ?eventType=all|tournament|general      (filter to tournament vs general play; default: all)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/portal/stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const userId = req.user!.id;
  const userEmail = req.user!.email ?? "";

  // ── Parse filter params ───────────────────────────────────────────────────
  const period = (req.query.period as string | undefined) ?? "allTime";
  const filterCourseId = req.query.courseId ? parseInt(req.query.courseId as string, 10) : null;
  // Task #1643 — `?baseline=` is now resolved against the player's pinned
  // preference + handicap-derived auto pick (mirroring the proximity card)
  // a few hundred lines down where we already have the player's handicap
  // index loaded. Anything other than "scratch" | "10" | "18" — including
  // "auto" or a stale value — falls through to auto-derivation.
  const sgBaselineOverride = typeof req.query.baseline === "string"
    && (req.query.baseline === "scratch" || req.query.baseline === "10" || req.query.baseline === "18")
      ? (req.query.baseline as SGBaseline)
      : null;
  const eventType = (req.query.eventType as string | undefined) ?? "all";
  const dateFrom = req.query.dateFrom as string | undefined;
  const dateTo = req.query.dateTo as string | undefined;

  // Find all player records for this user
  const playerRows = await db.select({
    id: playersTable.id, tournamentId: playersTable.tournamentId,
    handicapIndex: playersTable.handicapIndex, handicapOverride: playersTable.handicapOverride,
  }).from(playersTable)
    .where(sql`${playersTable.userId} = ${userId} OR ${playersTable.email} = ${userEmail}`);

  if (playerRows.length === 0) {
    res.json({ roundsPlayed: 0, scoringAvg: null, bestRound: null, worstRound: null, eagles: 0, birdies: 0, pars: 0, bogeys: 0, doublePlus: 0, fairwayPct: null, girPct: null, avgPutts: null, handicapTrend: [], holeAverages: [], recentRounds: [], period, courseId: filterCourseId });
    return;
  }

  const playerIds = playerRows.map(p => p.id);
  const tournamentIds = [...new Set(playerRows.map(p => p.tournamentId))];

  // Fetch all scores for these players
  let allScores = await db.select().from(scoresTable)
    .where(inArray(scoresTable.playerId, playerIds))
    .orderBy(asc(scoresTable.tournamentId), asc(scoresTable.round), asc(scoresTable.holeNumber));

  // Load hole par data for each tournament (via course)
  const tournamentCourseMap = new Map<number, number>();
  const tournamentDateMap = new Map<number, Date>();
  if (tournamentIds.length > 0) {
    const tData = await db.select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId, startDate: tournamentsTable.startDate, name: tournamentsTable.name })
      .from(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));
    for (const t of tData) {
      if (t.courseId) tournamentCourseMap.set(t.id, t.courseId);
      if (t.startDate) tournamentDateMap.set(t.id, new Date(t.startDate));
    }
  }

  // ── Apply period / custom date filter ─────────────────────────────────────
  if (dateFrom || dateTo) {
    const fromDate = dateFrom ? new Date(dateFrom) : new Date(0);
    const toDate = dateTo ? new Date(dateTo + "T23:59:59Z") : new Date();
    allScores = allScores.filter(s => {
      const d = tournamentDateMap.get(s.tournamentId);
      return d ? d >= fromDate && d <= toDate : false;
    });
  } else if (period === "thisYear") {
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    allScores = allScores.filter(s => {
      const d = tournamentDateMap.get(s.tournamentId);
      return d ? d >= yearStart : false;
    });
  }

  // ── Apply courseId filter ─────────────────────────────────────────────────
  if (filterCourseId) {
    const validTournamentIds = new Set(
      [...tournamentCourseMap.entries()]
        .filter(([, cid]) => cid === filterCourseId)
        .map(([tid]) => tid),
    );
    allScores = allScores.filter(s => validTournamentIds.has(s.tournamentId));
  }

  // ── Apply last N rounds filter ────────────────────────────────────────────
  const lastNMatch = period.match(/^last(\d+)rounds$/);
  if (lastNMatch) {
    const n = parseInt(lastNMatch[1], 10);
    const tempRoundMap = new Map<string, { playerId: number; tournamentId: number; round: number; date: Date }>();
    for (const s of allScores) {
      const k = `${s.playerId}-${s.tournamentId}-${s.round}`;
      if (!tempRoundMap.has(k)) {
        const d = tournamentDateMap.get(s.tournamentId) ?? new Date(0);
        tempRoundMap.set(k, { playerId: s.playerId, tournamentId: s.tournamentId, round: s.round, date: d });
      }
    }
    const sortedRounds = [...tempRoundMap.values()].sort((a, b) =>
      a.date.getTime() - b.date.getTime() || a.round - b.round,
    );
    const lastNKeys = new Set(
      sortedRounds.slice(-n).map(r => `${r.playerId}-${r.tournamentId}-${r.round}`),
    );
    allScores = allScores.filter(s =>
      lastNKeys.has(`${s.playerId}-${s.tournamentId}-${s.round}`),
    );
  }

  const courseHoleParMap = new Map<number, Map<number, number>>();
  const uniqueCourseIds = [...new Set(tournamentCourseMap.values())];
  for (const cid of uniqueCourseIds) {
    const holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, cid));
    courseHoleParMap.set(cid, new Map(holes.map(h => [h.holeNumber, h.par])));
  }

  function getHolePar(tournamentId: number, holeNumber: number): number {
    const cid = tournamentCourseMap.get(tournamentId);
    if (!cid) return 4;
    return courseHoleParMap.get(cid)?.get(holeNumber) ?? 4;
  }

  // Group scores by player+tournament+round (include tournamentId to avoid cross-tournament collision)
  type ScoreGroup = typeof allScores;
  const roundGroups = new Map<string, ScoreGroup>();
  for (const s of allScores) {
    const key = `${s.playerId}-${s.tournamentId}-${s.round}`;
    if (!roundGroups.has(key)) roundGroups.set(key, []);
    roundGroups.get(key)!.push(s);
  }

  // Only count rounds with ≥9 scores
  const completedRoundGroups = [...roundGroups.values()].filter(g => g.length >= 9);

  // Build per-round summaries
  interface RoundSummary { playerId: number; tournamentId: number; round: number; gross: number; par: number; toPar: number; birdies: number; eagles: number; pars: number; bogeys: number; doublePlus: number; fairwaysHit: number; fairwayOps: number; girHit: number; girOps: number; putts: number; puttOps: number }
  const roundSummaries: RoundSummary[] = [];

  for (const group of completedRoundGroups) {
    const tid = group[0].tournamentId;
    const round = group[0].round;
    const pid = group[0].playerId;
    const gross = group.reduce((a, s) => a + s.strokes, 0);
    const par = group.reduce((a, s) => a + getHolePar(tid, s.holeNumber), 0);
    const birdies = group.filter(s => s.strokes - getHolePar(tid, s.holeNumber) === -1).length;
    const eagles = group.filter(s => s.strokes - getHolePar(tid, s.holeNumber) <= -2).length;
    const parsCount = group.filter(s => s.strokes - getHolePar(tid, s.holeNumber) === 0).length;
    const bogeys = group.filter(s => s.strokes - getHolePar(tid, s.holeNumber) === 1).length;
    const doublePlus = group.filter(s => s.strokes - getHolePar(tid, s.holeNumber) >= 2).length;
    const fwScores = group.filter(s => s.fairwayHit !== null);
    const girScores = group.filter(s => s.girHit !== null);
    const puttScores = group.filter(s => s.putts !== null);
    roundSummaries.push({
      playerId: pid, tournamentId: tid, round,
      gross, par, toPar: gross - par,
      birdies, eagles, pars: parsCount, bogeys, doublePlus,
      fairwaysHit: fwScores.filter(s => s.fairwayHit).length, fairwayOps: fwScores.length,
      girHit: girScores.filter(s => s.girHit).length, girOps: girScores.length,
      putts: puttScores.reduce((a, s) => a + (s.putts ?? 0), 0), puttOps: puttScores.length,
    });
  }

  // Aggregate career stats
  const totalBirdies = roundSummaries.reduce((a, r) => a + r.birdies, 0);
  const totalEagles = roundSummaries.reduce((a, r) => a + r.eagles, 0);
  const totalPars = roundSummaries.reduce((a, r) => a + r.pars, 0);
  const totalBogeys = roundSummaries.reduce((a, r) => a + r.bogeys, 0);
  const totalDoublePlus = roundSummaries.reduce((a, r) => a + r.doublePlus, 0);
  let totalFwHit = roundSummaries.reduce((a, r) => a + r.fairwaysHit, 0);
  let totalFwOps = roundSummaries.reduce((a, r) => a + r.fairwayOps, 0);
  let totalGIRHit = roundSummaries.reduce((a, r) => a + r.girHit, 0);
  let totalGIROps = roundSummaries.reduce((a, r) => a + r.girOps, 0);
  let totalPutts = roundSummaries.reduce((a, r) => a + r.putts, 0);
  let totalPuttOps = roundSummaries.reduce((a, r) => a + r.puttOps, 0);

  // Putting breakdown — count one-putts and three-putt-or-worse holes across
  // tournament + general play data (matches totalPuttOps denominator).
  let onePutts = 0;
  let threePlusPutts = 0;
  for (const s of allScores) {
    if (s.putts === null) continue;
    if (s.putts === 1) onePutts++;
    else if (s.putts >= 3) threePlusPutts++;
  }

  // Add general play hole scores to the totals (fairway%, GIR%, avg putts)
  try {
    const gpHoles = await db.select({
      fairwayHit: generalPlayHoleScoresTable.fairwayHit,
      gir: generalPlayHoleScoresTable.gir,
      putts: generalPlayHoleScoresTable.putts,
      par: generalPlayHoleScoresTable.par,
    })
      .from(generalPlayHoleScoresTable)
      .innerJoin(generalPlayRoundsTable, eq(generalPlayHoleScoresTable.roundId, generalPlayRoundsTable.id))
      .where(and(
        eq(generalPlayRoundsTable.userId, userId),
        eq(generalPlayRoundsTable.status, "confirmed"),
      ));

    for (const h of gpHoles) {
      // Fairway: only applicable when fairwayHit is recorded (non-par-3 holes)
      if (h.fairwayHit !== null) {
        totalFwOps++;
        if (h.fairwayHit === "hit") totalFwHit++;
      }
      // GIR
      if (h.gir !== null) {
        totalGIROps++;
        if (h.gir) totalGIRHit++;
      }
      // Putts
      if (h.putts !== null) {
        totalPutts += h.putts;
        totalPuttOps++;
        if (h.putts === 1) onePutts++;
        else if (h.putts >= 3) threePlusPutts++;
      }
    }
  } catch {
    // non-fatal — tournament stats still displayed
  }

  const grosses = roundSummaries.map(r => r.gross);
  const scoringAvg = grosses.length > 0 ? Math.round((grosses.reduce((a, v) => a + v, 0) / grosses.length) * 10) / 10 : null;
  const bestRound = grosses.length > 0 ? Math.min(...grosses) : null;
  const worstRound = grosses.length > 0 ? Math.max(...grosses) : null;

  // Recent 12 rounds (for chart)
  const recentRounds = roundSummaries.slice(-12).map(r => ({
    playerId: r.playerId, tournamentId: r.tournamentId, round: r.round, gross: r.gross, par: r.par, toPar: r.toPar,
    birdies: r.birdies, eagles: r.eagles,
    fairwayPct: r.fairwayOps > 0 ? Math.round((r.fairwaysHit / r.fairwayOps) * 100) : null,
    girPct: r.girOps > 0 ? Math.round((r.girHit / r.girOps) * 100) : null,
    avgPutts: r.puttOps > 0 ? Math.round((r.putts / r.puttOps) * 100) / 100 : null,
  }));

  // Hole-by-hole averages (career average score per hole 1-18)
  const holeAggregates = new Map<number, { totalStrokes: number; count: number; totalPar: number }>();
  for (const s of allScores) {
    if (!holeAggregates.has(s.holeNumber)) holeAggregates.set(s.holeNumber, { totalStrokes: 0, count: 0, totalPar: 0 });
    const agg = holeAggregates.get(s.holeNumber)!;
    agg.totalStrokes += s.strokes;
    agg.count++;
    agg.totalPar += getHolePar(s.tournamentId, s.holeNumber);
  }
  const holeAverages = Array.from({ length: 18 }, (_, i) => {
    const hn = i + 1;
    const agg = holeAggregates.get(hn);
    if (!agg || agg.count === 0) return { holeNumber: hn, avgStrokes: null, avgPar: null, avgToPar: null, count: 0 };
    const avgStrokes = Math.round((agg.totalStrokes / agg.count) * 100) / 100;
    const avgPar = Math.round((agg.totalPar / agg.count) * 100) / 100;
    return { holeNumber: hn, avgStrokes, avgPar, avgToPar: Math.round((avgStrokes - avgPar) * 100) / 100, count: agg.count };
  });

  // Handicap trend from handicap_history table
  const handicapTrend = await db.select({ handicapIndex: handicapHistoryTable.handicapIndex, recordedAt: handicapHistoryTable.recordedAt, tournamentId: handicapHistoryTable.tournamentId })
    .from(handicapHistoryTable)
    .where(eq(handicapHistoryTable.userId, userId))
    .orderBy(asc(handicapHistoryTable.recordedAt))
    .limit(24);

  // If no history, derive from player records
  const hcpTrend = handicapTrend.length > 0
    ? handicapTrend.map(h => ({ handicapIndex: Number(h.handicapIndex), recordedAt: h.recordedAt, tournamentId: h.tournamentId }))
    : playerRows.filter(p => p.handicapIndex).map(p => ({ handicapIndex: Number(p.handicapIndex), recordedAt: null, tournamentId: p.tournamentId }));

  // Committee adjustments for this player — annotate the handicap trend
  const committeeAdjRows = playerIds.length > 0
    ? await db.select({
        playerId: handicapAdjustmentsTable.playerId,
        previousHandicapIndex: handicapAdjustmentsTable.previousHandicapIndex,
        newHandicapIndex: handicapAdjustmentsTable.newHandicapIndex,
        adjustmentReason: handicapAdjustmentsTable.adjustmentReason,
        adjustedAt: handicapAdjustmentsTable.adjustedAt,
      })
      .from(handicapAdjustmentsTable)
      .where(inArray(handicapAdjustmentsTable.playerId, playerIds))
      .orderBy(asc(handicapAdjustmentsTable.adjustedAt))
    : [];
  const committeeAdjustments = committeeAdjRows.map(r => ({
    previousHandicapIndex: r.previousHandicapIndex ? Number(r.previousHandicapIndex) : null,
    newHandicapIndex: Number(r.newHandicapIndex),
    adjustmentReason: r.adjustmentReason,
    adjustedAt: r.adjustedAt.toISOString(),
  }));

  // Course names map
  const courseNameMap = new Map<number, string>();
  if (uniqueCourseIds.length > 0) {
    const courseRows = await db.select({ id: coursesTable.id, name: coursesTable.name }).from(coursesTable).where(inArray(coursesTable.id, uniqueCourseIds));
    for (const c of courseRows) courseNameMap.set(c.id, c.name);
  }

  // Course breakdown (with name + best gross)
  const courseStats = new Map<number, { courseId: number; courseName: string; rounds: number; avgGross: number; totalGross: number; bestGross: number | null }>();
  for (const r of roundSummaries) {
    const cid = tournamentCourseMap.get(r.tournamentId);
    if (!cid) continue;
    if (!courseStats.has(cid)) courseStats.set(cid, { courseId: cid, courseName: courseNameMap.get(cid) ?? `Course ${cid}`, rounds: 0, avgGross: 0, totalGross: 0, bestGross: null });
    const cs = courseStats.get(cid)!;
    cs.rounds++; cs.totalGross += r.gross;
    cs.avgGross = Math.round((cs.totalGross / cs.rounds) * 10) / 10;
    if (cs.bestGross === null || r.gross < cs.bestGross) cs.bestGross = r.gross;
  }

  // Short game stats (sand save % + up & down %) — raw counts accumulated from
  // tournament shot tracking + general play hole scores, then a single % computed.
  let sandSavePct: number | null = null;
  let upAndDownPct: number | null = null;
  let sandAttempts = 0, sandSaves = 0, upDownAttempts = 0, upDownSaves = 0;

  if (playerIds.length > 0) {
    const shotRows = await db.select({ playerId: shotsTable.playerId, tournamentId: shotsTable.tournamentId, round: shotsTable.round, holeNumber: shotsTable.holeNumber, shotType: shotsTable.shotType })
      .from(shotsTable).where(inArray(shotsTable.playerId, playerIds));
    // Group by player+tournament+round+hole
    const holeShots = new Map<string, { types: string[] }>();
    for (const shot of shotRows) {
      const key = `${shot.playerId}-${shot.tournamentId}-${shot.round}-${shot.holeNumber}`;
      if (!holeShots.has(key)) holeShots.set(key, { types: [] });
      holeShots.get(key)!.types.push(shot.shotType);
    }
    // Build lookup for scores (par-save = strokes <= par)
    const scoresByKey = new Map<string, number>();
    for (const s of allScores) scoresByKey.set(`${s.playerId}-${s.tournamentId}-${s.round}-${s.holeNumber}`, s.strokes);
    const parsByKey = new Map<string, number>();
    for (const s of allScores) {
      const k = `${s.playerId}-${s.tournamentId}-${s.round}-${s.holeNumber}`;
      parsByKey.set(k, getHolePar(s.tournamentId, s.holeNumber));
    }
    for (const [key, { types }] of holeShots) {
      const strokes = scoresByKey.get(key);
      const par = parsByKey.get(key);
      if (strokes == null || par == null) continue;
      if (types.includes("sand")) {
        sandAttempts++;
        if (strokes <= par) sandSaves++;
      }
      if (types.includes("chip")) {
        upDownAttempts++;
        if (strokes <= par) upDownSaves++;
      }
    }
  }

  // Add general play hole-level scrambling data to raw counts
  try {
    const gpScrambling = await db.select({
      sandSave: generalPlayHoleScoresTable.sandSave,
      upAndDown: generalPlayHoleScoresTable.upAndDown,
    })
      .from(generalPlayHoleScoresTable)
      .innerJoin(generalPlayRoundsTable, eq(generalPlayHoleScoresTable.roundId, generalPlayRoundsTable.id))
      .where(and(
        eq(generalPlayRoundsTable.userId, userId),
        eq(generalPlayRoundsTable.status, "confirmed"),
      ));

    for (const h of gpScrambling) {
      if (h.sandSave !== null) {
        sandAttempts++;
        if (h.sandSave) sandSaves++;
      }
      if (h.upAndDown !== null) {
        upDownAttempts++;
        if (h.upAndDown) upDownSaves++;
      }
    }
  } catch {
    // non-fatal — tournament scrambling data still used
  }

  // Compute combined percentages from accumulated raw counts
  if (sandAttempts >= 5) sandSavePct = Math.round((sandSaves / sandAttempts) * 100);
  if (upDownAttempts >= 5) upAndDownPct = Math.round((upDownSaves / upDownAttempts) * 100);

  // ── Strokes Gained (shot-level engine) ────────────────────────────────────
  // Build per-tournament hole-par maps (primary course) from already-loaded data.
  const tournamentHoleParsForSG = new Map<number, Map<number, number>>();
  for (const [tid, cid] of tournamentCourseMap.entries()) {
    const holeParMap = courseHoleParMap.get(cid);
    if (holeParMap) tournamentHoleParsForSG.set(tid, holeParMap);
  }

  // Build per-round hole-par maps for multi-course championships.
  // Fetch round-course assignments for all tournaments in scope, then load
  // hole details for any extra courses not already in courseHoleParMap.
  const tournamentRoundHoleParsForSG = new Map<number, Map<number, Map<number, number>>>();
  if (tournamentIds.length > 0) {
    const roundAssignments = await db
      .select({ tournamentId: tournamentRoundsTable.tournamentId, roundNumber: tournamentRoundsTable.roundNumber, courseId: tournamentRoundsTable.courseId })
      .from(tournamentRoundsTable)
      .where(inArray(tournamentRoundsTable.tournamentId, tournamentIds));

    // Load hole details for extra courses not yet in courseHoleParMap
    const extraCourseIds = [...new Set(roundAssignments.map(r => r.courseId).filter((cid): cid is number => cid != null && !courseHoleParMap.has(cid)))];
    for (const cid of extraCourseIds) {
      const holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
        .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, cid));
      courseHoleParMap.set(cid, new Map(holes.map(h => [h.holeNumber, h.par])));
    }

    for (const ra of roundAssignments) {
      if (!ra.courseId) continue;
      const holePars = courseHoleParMap.get(ra.courseId);
      if (!holePars) continue;
      if (!tournamentRoundHoleParsForSG.has(ra.tournamentId)) {
        tournamentRoundHoleParsForSG.set(ra.tournamentId, new Map());
      }
      tournamentRoundHoleParsForSG.get(ra.tournamentId)!.set(ra.roundNumber, holePars);
    }
  }

  // Task #1643 — Resolve which SG baseline to use the same way the
  // proximity card does:
  //   1. `?baseline=scratch|10|18` query param (one-off override)
  //   2. `app_users.preferred_sg_baseline` (player's pinned choice)
  //   3. Auto-derived from the player's current handicap index
  //      (≤4 → scratch, ≤12 → 10-hcp, otherwise 18-hcp; thresholds
  //       intentionally mirror `pickPrimaryProximityBaseline`)
  // The handicap index can come from three sources, in order of authority:
  // the official WHS state row, the most recent handicap_history snapshot,
  // or the most recent tournament registration row. Pulled in parallel so
  // the resolution doesn't add extra round-trips.
  const [sgPrefRow, sgWhsRow, sgHcpHistoryRow, sgPlayerHcpRow] = await Promise.all([
    db.select({
      pref: appUsersTable.preferredSgBaseline,
      // Task #2048 — last auto-derived baseline the player has explicitly
      // (or implicitly via lazy-seed) acknowledged. Drives the one-time
      // "your benchmark moved" notice below when the auto-pick crosses a
      // cohort threshold.
      lastSeenAuto: appUsersTable.lastSeenAutoSgBaseline,
    })
      .from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1),
    db.select({ hi: whsPlayerStateTable.currentHandicapIndex })
      .from(whsPlayerStateTable)
      .where(eq(whsPlayerStateTable.userId, userId))
      .orderBy(desc(whsPlayerStateTable.lastRecalcAt))
      .limit(1)
      .catch(() => [] as { hi: string | null }[]),
    db.select({ hi: handicapHistoryTable.handicapIndex })
      .from(handicapHistoryTable)
      .where(eq(handicapHistoryTable.userId, userId))
      .orderBy(desc(handicapHistoryTable.recordedAt))
      .limit(1),
    db.select({ hi: playersTable.handicapIndex })
      .from(playersTable)
      .where(and(eq(playersTable.userId, userId), isNotNull(playersTable.handicapIndex)))
      .orderBy(desc(playersTable.registeredAt))
      .limit(1),
  ]);

  const sgPreference = sgPrefRow[0]?.pref ?? null;
  const sgLastSeenAuto = (sgPrefRow[0]?.lastSeenAuto ?? null) as SGBaseline | null;
  const sgRawHi = sgWhsRow[0]?.hi ?? sgHcpHistoryRow[0]?.hi ?? sgPlayerHcpRow[0]?.hi ?? null;
  const sgHandicapIndex = sgRawHi != null ? parseFloat(String(sgRawHi)) : null;
  const sgResolved = resolveSgBaseline({
    override: sgBaselineOverride,
    preference: sgPreference,
    handicapIndex: sgHandicapIndex,
  });

  // Task #2048 — One-time "your benchmark moved" notice when the player
  // is on auto and the handicap-derived cohort has crossed a threshold
  // since the last value they saw/acknowledged. We only consider the
  // pure handicap-derived value here (`sgAutoDerived`) — it is independent
  // of any one-off `?baseline=` query override or pinned preference, both
  // of which suppress the notice on their own.
  //
  //   - sgPreference !== null (or "auto") → player has a pin → no notice
  //   - sgHandicapIndex == null → "default" cohort → no real change to flag
  //   - sgLastSeenAuto == null → first time we have an auto baseline for
  //       this player; lazy-seed it to current and don't show the notice
  //       so day-1 doesn't say "your baseline moved" out of nowhere
  //   - sgLastSeenAuto !== sgAutoDerived → the cohort moved; surface the
  //       notice so the player can pin the previous one if they prefer
  const isAutoPicked = (sgPreference == null || sgPreference === "auto");
  const sgAutoDerived: SGBaseline | null = sgHandicapIndex !== null && Number.isFinite(sgHandicapIndex)
    ? pickPrimarySgBaseline(sgHandicapIndex)
    : null;
  let sgBaselineChange: { previousBaseline: SGBaseline; currentBaseline: SGBaseline } | null = null;
  if (isAutoPicked && sgAutoDerived !== null) {
    if (sgLastSeenAuto === null) {
      // First sighting — lazy-seed to current. Fire-and-forget so we
      // don't hold the response on the write; the only correctness hazard
      // is a duplicate seed on a parallel first request, which is fine
      // because both writes set the same value.
      void db.update(appUsersTable)
        .set({ lastSeenAutoSgBaseline: sgAutoDerived, updatedAt: new Date() })
        .where(eq(appUsersTable.id, userId))
        .catch(() => { /* non-fatal — notice will surface on next fetch */ });
    } else if (sgLastSeenAuto !== sgAutoDerived) {
      sgBaselineChange = { previousBaseline: sgLastSeenAuto, currentBaseline: sgAutoDerived };
    }
  }

  const sgSummary = await computePlayerSGFromDB(
    playerIds,
    sgResolved.primary,
    tournamentHoleParsForSG,
    tournamentRoundHoleParsForSG,
  );

  // ── General play breakdown (tournament vs. casual rounds) ─────────────────
  let generalPlayBreakdown: {
    tournamentRounds: number; generalPlayRounds: number;
    tournamentScoringAvg: number | null; generalPlayScoringAvg: number | null;
  } = { tournamentRounds: roundSummaries.length, generalPlayRounds: 0, tournamentScoringAvg: scoringAvg, generalPlayScoringAvg: null };

  try {
    const gpRounds = await db
      .select({
        id: generalPlayRoundsTable.id,
        grossScore: generalPlayRoundsTable.grossScore,
        status: generalPlayRoundsTable.status,
        playedAt: generalPlayRoundsTable.playedAt,
      })
      .from(generalPlayRoundsTable)
      .where(and(
        eq(generalPlayRoundsTable.userId, userId),
        eq(generalPlayRoundsTable.status, "confirmed"),
      ));

    // Apply date filters to general play too
    let filteredGpRounds = gpRounds;
    if (dateFrom || dateTo) {
      const fromDate = dateFrom ? new Date(dateFrom) : new Date(0);
      const toDate = dateTo ? new Date(dateTo + "T23:59:59Z") : new Date();
      filteredGpRounds = gpRounds.filter(r => r.playedAt >= fromDate && r.playedAt <= toDate);
    } else if (period === "thisYear") {
      const yearStart = new Date(new Date().getFullYear(), 0, 1);
      filteredGpRounds = gpRounds.filter(r => r.playedAt >= yearStart);
    } else if (lastNMatch) {
      // For last N rounds, combine tournament + general play, take last N across both
      // This is handled at the overall level — skip filtering for GP separately here
    }

    const gpScores = filteredGpRounds.map(r => r.grossScore).filter((v): v is number => v !== null);
    generalPlayBreakdown = {
      tournamentRounds: roundSummaries.length,
      generalPlayRounds: filteredGpRounds.length,
      tournamentScoringAvg: scoringAvg,
      generalPlayScoringAvg: gpScores.length > 0 ? Math.round((gpScores.reduce((a, b) => a + b, 0) / gpScores.length) * 10) / 10 : null,
    };
  } catch {
    // non-fatal
  }

  // ── Cache headers (5 minutes, stale-while-revalidate 60 s) ───────────────
  res.set("Cache-Control", "private, max-age=300, stale-while-revalidate=60");

  res.json({
    roundsPlayed: roundSummaries.length,
    scoringAvg,
    bestRound,
    worstRound,
    eagles: totalEagles,
    birdies: totalBirdies,
    pars: totalPars,
    bogeys: totalBogeys,
    doublePlus: totalDoublePlus,
    fairwayPct: totalFwOps > 0 ? Math.round((totalFwHit / totalFwOps) * 100) : null,
    girPct: totalGIROps > 0 ? Math.round((totalGIRHit / totalGIROps) * 100) : null,
    avgPutts: totalPuttOps > 0 ? Math.round((totalPutts / totalPuttOps) * 100) / 100 : null,
    putting: {
      holesTracked: totalPuttOps,
      onePutts,
      threePlusPutts,
      onePuttPct: totalPuttOps > 0 ? Math.round((onePutts / totalPuttOps) * 100) : null,
      threePlusPuttPct: totalPuttOps > 0 ? Math.round((threePlusPutts / totalPuttOps) * 100) : null,
    },
    handicapTrend: hcpTrend,
    committeeAdjustments,
    holeAverages,
    recentRounds,
    courseBreakdown: [...courseStats.values()].sort((a, b) => b.rounds - a.rounds).map(c => ({ courseId: c.courseId, courseName: c.courseName, rounds: c.rounds, avgGross: c.avgGross, bestGross: c.bestGross })),
    shortGame: { sandSavePct, upAndDownPct },
    eventBreakdown: generalPlayBreakdown,
    period,
    courseId: filterCourseId,
    strokesGained: {
      sgPutting: sgSummary.sgPutting,
      sgApproach: sgSummary.sgApproach,
      sgATG: sgSummary.sgATG,
      sgOffTheTee: sgSummary.sgOTT,
      sgTotal: sgSummary.sgTotal,
      trackedRounds: sgSummary.trackedRounds,
      baseline: sgSummary.baseline,
      roundDetail: sgSummary.roundResults.slice(-12),
      sgPuttingMeasuredRounds: sgSummary.sgPuttingMeasuredRounds,
      sgPuttingEstimatedRounds: sgSummary.sgPuttingEstimatedRounds,
      // Task #1643 — surface the auto-pick + pin-override metadata so the
      // Stats card can show "Auto-picked from your 12.4 handicap" vs
      // "Pinned to 10-hcp" copy and offer the same picker the proximity
      // chart uses (auto / scratch / 10 / 18).
      preferredBaseline: sgPreference ?? "auto",
      primaryBaseline: sgResolved.primary,
      baselineSource: sgResolved.source,
      handicapIndex: sgHandicapIndex !== null && Number.isFinite(sgHandicapIndex) ? sgHandicapIndex : null,
      // Task #2048 — one-time "your benchmark moved" notice. `null` when
      // there's nothing to flag (player on a pin, no handicap on file,
      // first-ever fetch we just lazy-seeded, or the cohort hasn't
      // moved). The UI renders a banner with two actions: "Pin
      // <previous>-hcp" (POST ack with `pin: previousBaseline`) and
      // "Got it" (POST ack with no pin).
      baselineChange: sgBaselineChange,
    },
  });
});

// Task #1643 — Persist the player's pinned strokes-gained baseline so the
// chart remembers it across sessions and devices. Body: { baseline:
// 'auto'|'scratch'|'10'|'18' }. 'auto' clears the pin and re-enables
// handicap-based auto-derivation. Mirrors `/portal/player/proximity-baseline-preference`.
//
// Task #2048 — Also advances `last_seen_auto_sg_baseline` to the player's
// current handicap-derived auto baseline so a later switch back to "auto"
// doesn't immediately re-fire a stale "your baseline moved" notice from
// before the player pinned. (If the auto-pick legitimately changes again
// after this point, the notice will surface as expected.)
router.put("/portal/player/sg-baseline-preference", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const raw = (req.body as { baseline?: unknown }).baseline;
  if (typeof raw !== "string" || !["auto", "scratch", "10", "18"].includes(raw)) {
    res.status(400).json({ error: "baseline must be one of: auto, scratch, 10, 18" });
    return;
  }
  const next = raw === "auto" ? null : raw;
  // Look up the player's current handicap-derived auto baseline so we can
  // sync `last_seen_auto_sg_baseline` in the same UPDATE — avoids a race
  // where a switch to/from auto re-fires a notice for a threshold the
  // player has effectively already acknowledged by interacting with the
  // picker. Same handicap-source priority as the stats endpoint.
  const currentAuto = await resolveCurrentAutoSgBaseline(userId);
  await db.update(appUsersTable)
    .set({
      preferredSgBaseline: next,
      ...(currentAuto !== null ? { lastSeenAutoSgBaseline: currentAuto } : {}),
      updatedAt: new Date(),
    })
    .where(eq(appUsersTable.id, userId));
  res.json({ preferredBaseline: next ?? "auto" });
});

// Task #2048 — Acknowledge a `baselineChange` notice from `/portal/stats`.
//
//   POST /api/portal/player/sg-baseline-change-ack
//   Body: { pin?: 'scratch' | '10' | '18' }
//
// Always advances `last_seen_auto_sg_baseline` to the player's current
// auto-derived baseline so the same notice stops firing on subsequent
// stats fetches (this is the "Dismissal is remembered" requirement from
// the task brief). When `pin` is provided, also sets
// `preferred_sg_baseline` to that cohort — this powers the
// "Pin previous baseline" shortcut so the player can keep comparing
// against the cohort they're used to instead of the freshly-auto-picked
// one. Returns the resulting state so the UI can update without a
// follow-up GET.
router.post("/portal/player/sg-baseline-change-ack", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const rawPin = (req.body as { pin?: unknown }).pin;
  let pinValue: SGBaseline | null = null;
  if (rawPin !== undefined && rawPin !== null) {
    if (typeof rawPin !== "string" || !["scratch", "10", "18"].includes(rawPin)) {
      res.status(400).json({ error: "pin must be one of: scratch, 10, 18 (or omitted to dismiss without pinning)" });
      return;
    }
    pinValue = rawPin as SGBaseline;
  }

  const currentAuto = await resolveCurrentAutoSgBaseline(userId);
  if (currentAuto === null && pinValue === null) {
    // No auto baseline to "ack" against and no pin was requested. We still
    // succeed (idempotent dismissal) but skip the lastSeen write.
    res.json({
      acknowledged: true,
      preferredBaseline: "auto" as const,
      lastSeenAutoSgBaseline: null,
    });
    return;
  }

  await db.update(appUsersTable)
    .set({
      ...(pinValue !== null ? { preferredSgBaseline: pinValue } : {}),
      ...(currentAuto !== null ? { lastSeenAutoSgBaseline: currentAuto } : {}),
      updatedAt: new Date(),
    })
    .where(eq(appUsersTable.id, userId));

  res.json({
    acknowledged: true,
    preferredBaseline: pinValue ?? "auto",
    lastSeenAutoSgBaseline: currentAuto,
  });
});

// Task #2048 — Shared lookup for the player's current handicap-derived
// SG baseline. Mirrors the three-source handicap resolution used by
// `/portal/stats` (WHS state → handicap_history → players row, in that
// order of authority) and returns `null` when no handicap is on file —
// callers treat that as "no auto baseline to record". Kept inline rather
// than promoted to `lib/strokes-gained.ts` because it's the only caller
// that needs the user-id → baseline lookup; `pickPrimarySgBaseline` is
// the pure function and stays in the lib.
async function resolveCurrentAutoSgBaseline(userId: number): Promise<SGBaseline | null> {
  const [whsRow, hcpRow, playerHcpRow] = await Promise.all([
    db.select({ hi: whsPlayerStateTable.currentHandicapIndex })
      .from(whsPlayerStateTable)
      .where(eq(whsPlayerStateTable.userId, userId))
      .orderBy(desc(whsPlayerStateTable.lastRecalcAt))
      .limit(1)
      .catch(() => [] as { hi: string | null }[]),
    db.select({ hi: handicapHistoryTable.handicapIndex })
      .from(handicapHistoryTable)
      .where(eq(handicapHistoryTable.userId, userId))
      .orderBy(desc(handicapHistoryTable.recordedAt))
      .limit(1),
    db.select({ hi: playersTable.handicapIndex })
      .from(playersTable)
      .where(and(eq(playersTable.userId, userId), isNotNull(playersTable.handicapIndex)))
      .orderBy(desc(playersTable.registeredAt))
      .limit(1),
  ]);
  const raw = whsRow[0]?.hi ?? hcpRow[0]?.hi ?? playerHcpRow[0]?.hi ?? null;
  if (raw == null) return null;
  const hi = parseFloat(String(raw));
  if (!Number.isFinite(hi)) return null;
  return pickPrimarySgBaseline(hi);
}

// GET /api/portal/stats/:targetUserId — admin / org-admin view of another user's stats
// Access: caller must be orgAdmin (or sysAdmin) in at least one org the target user also belongs to.
router.get("/portal/stats/:targetUserId", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const callerId = req.user!.id;
  const callerRole = req.user!.role ?? "player";

  // super_admin may view anyone; org_admins are scoped to their org
  if (callerRole !== "org_admin" && callerRole !== "super_admin") {
    res.status(403).json({ error: "Forbidden: org admin access required" });
    return;
  }

  const targetUserId = parseInt(String((req.params as Record<string, string>).targetUserId), 10);
  if (isNaN(targetUserId)) { { res.status(400).json({ error: "Invalid userId" }); return; } }

  // For org_admin: verify caller shares an org with the target user
  if (callerRole === "org_admin") {
    const [callerMembership] = await db
      .select({ organizationId: orgMembershipsTable.organizationId })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, callerId), eq(orgMembershipsTable.role, "org_admin")));

    if (!callerMembership) {
      res.status(403).json({ error: "Forbidden: no active org admin membership found" });
      return;
    }

    const [targetMembership] = await db
      .select({ id: orgMembershipsTable.id })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.userId, targetUserId),
        eq(orgMembershipsTable.organizationId, callerMembership.organizationId),
      ));

    if (!targetMembership) {
      res.status(403).json({ error: "Forbidden: target user is not in your organization" });
      return;
    }
  }

  // Parse query params (same as self-view endpoint)
  const tPeriod = (req.query.period as string | undefined) ?? "allTime";
  // Task #1643 — admins viewing another player's stats see the same
  // auto-pick as the player would (so the numbers match what the player
  // sees), unless they override via `?baseline=`. The override is one-off
  // and never persisted to the target user's preference.
  const tSgBaselineOverride = typeof req.query.baseline === "string"
    && (req.query.baseline === "scratch" || req.query.baseline === "10" || req.query.baseline === "18")
      ? (req.query.baseline as SGBaseline)
      : null;

  // Fetch target user info
  const [targetUser] = await db.select({ displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(appUsersTable).where(eq(appUsersTable.id, targetUserId));

  // Fetch all player records for the target user
  const playerRows = await db.select({
    id: playersTable.id, tournamentId: playersTable.tournamentId,
    handicapIndex: playersTable.handicapIndex, handicapOverride: playersTable.handicapOverride,
  }).from(playersTable).where(eq(playersTable.userId, targetUserId));

  if (playerRows.length === 0) {
    res.set("Cache-Control", "private, max-age=60");
    res.json({ targetUserId, playerName: targetUser?.displayName ?? targetUser?.username ?? null, roundsPlayed: 0, scoringAvg: null, strokesGained: null });
    return;
  }

  const tPlayerIds = playerRows.map(p => p.id);
  const tTournamentIds = [...new Set(playerRows.map(p => p.tournamentId))];

  let tAllScores = await db.select().from(scoresTable)
    .where(inArray(scoresTable.playerId, tPlayerIds))
    .orderBy(asc(scoresTable.tournamentId), asc(scoresTable.round), asc(scoresTable.holeNumber));

  const tTournamentCourseMap = new Map<number, number>();
  const tTournamentDateMap = new Map<number, Date>();
  if (tTournamentIds.length > 0) {
    const tData = await db.select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId, startDate: tournamentsTable.startDate })
      .from(tournamentsTable).where(inArray(tournamentsTable.id, tTournamentIds));
    for (const t of tData) {
      if (t.courseId) tTournamentCourseMap.set(t.id, t.courseId);
      if (t.startDate) tTournamentDateMap.set(t.id, new Date(t.startDate));
    }
  }

  // Apply period filter
  if (tPeriod === "thisYear") {
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    tAllScores = tAllScores.filter(s => { const d = tTournamentDateMap.get(s.tournamentId); return d ? d >= yearStart : false; });
  }
  const tLastNMatch = tPeriod.match(/^last(\d+)rounds$/);
  if (tLastNMatch) {
    const n = parseInt(tLastNMatch[1], 10);
    const tmpMap = new Map<string, { playerId: number; tournamentId: number; round: number; date: Date }>();
    for (const s of tAllScores) {
      const k = `${s.playerId}-${s.tournamentId}-${s.round}`;
      if (!tmpMap.has(k)) tmpMap.set(k, { playerId: s.playerId, tournamentId: s.tournamentId, round: s.round, date: tTournamentDateMap.get(s.tournamentId) ?? new Date(0) });
    }
    const lastNKeys = new Set([...tmpMap.values()].sort((a, b) => a.date.getTime() - b.date.getTime() || a.round - b.round).slice(-n).map(r => `${r.playerId}-${r.tournamentId}-${r.round}`));
    tAllScores = tAllScores.filter(s => lastNKeys.has(`${s.playerId}-${s.tournamentId}-${s.round}`));
  }

  const tCourseHoleParMap = new Map<number, Map<number, number>>();
  const tUniqueCourseIds = [...new Set(tTournamentCourseMap.values())];
  for (const cid of tUniqueCourseIds) {
    const holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, cid));
    tCourseHoleParMap.set(cid, new Map(holes.map(h => [h.holeNumber, h.par])));
  }
  function tGetHolePar(tournamentId: number, holeNumber: number): number {
    const cid = tTournamentCourseMap.get(tournamentId);
    if (!cid) return 4;
    return tCourseHoleParMap.get(cid)?.get(holeNumber) ?? 4;
  }

  const tRoundGroups = new Map<string, typeof tAllScores>();
  for (const s of tAllScores) {
    const key = `${s.playerId}-${s.tournamentId}-${s.round}`;
    if (!tRoundGroups.has(key)) tRoundGroups.set(key, []);
    tRoundGroups.get(key)!.push(s);
  }
  const tCompletedGroups = [...tRoundGroups.values()].filter(g => g.length >= 9);

  interface TRoundSummary { playerId: number; tournamentId: number; round: number; gross: number; par: number; toPar: number; birdies: number; eagles: number; pars: number; bogeys: number; doublePlus: number; fairwaysHit: number; fairwayOps: number; girHit: number; girOps: number; putts: number; puttOps: number }
  const tRoundSummaries: TRoundSummary[] = [];
  for (const group of tCompletedGroups) {
    const tid = group[0].tournamentId; const round = group[0].round; const pid = group[0].playerId;
    const gross = group.reduce((a, s) => a + s.strokes, 0);
    const par = group.reduce((a, s) => a + tGetHolePar(tid, s.holeNumber), 0);
    const birdies = group.filter(s => s.strokes - tGetHolePar(tid, s.holeNumber) === -1).length;
    const eagles = group.filter(s => s.strokes - tGetHolePar(tid, s.holeNumber) <= -2).length;
    const parsCount = group.filter(s => s.strokes - tGetHolePar(tid, s.holeNumber) === 0).length;
    const bogeys = group.filter(s => s.strokes - tGetHolePar(tid, s.holeNumber) === 1).length;
    const doublePlus = group.filter(s => s.strokes - tGetHolePar(tid, s.holeNumber) >= 2).length;
    const fwScores = group.filter(s => s.fairwayHit !== null);
    const girScores = group.filter(s => s.girHit !== null);
    const puttScores = group.filter(s => s.putts !== null);
    tRoundSummaries.push({
      playerId: pid, tournamentId: tid, round, gross, par, toPar: gross - par,
      birdies, eagles, pars: parsCount, bogeys, doublePlus,
      fairwaysHit: fwScores.filter(s => s.fairwayHit).length, fairwayOps: fwScores.length,
      girHit: girScores.filter(s => s.girHit).length, girOps: girScores.length,
      putts: puttScores.reduce((a, s) => a + (s.putts ?? 0), 0), puttOps: puttScores.length,
    });
  }

  const tGrosses = tRoundSummaries.map(r => r.gross);
  const tScoringAvg = tGrosses.length > 0 ? Math.round((tGrosses.reduce((a, v) => a + v, 0) / tGrosses.length) * 10) / 10 : null;
  const tTotalFwHit = tRoundSummaries.reduce((a, r) => a + r.fairwaysHit, 0);
  const tTotalFwOps = tRoundSummaries.reduce((a, r) => a + r.fairwayOps, 0);
  const tTotalGIRHit = tRoundSummaries.reduce((a, r) => a + r.girHit, 0);
  const tTotalGIROps = tRoundSummaries.reduce((a, r) => a + r.girOps, 0);
  const tTotalPutts = tRoundSummaries.reduce((a, r) => a + r.putts, 0);
  const tTotalPuttOps = tRoundSummaries.reduce((a, r) => a + r.puttOps, 0);

  // Handicap trend for target user
  const tHcpHistory = await db.select({ handicapIndex: handicapHistoryTable.handicapIndex, recordedAt: handicapHistoryTable.recordedAt, tournamentId: handicapHistoryTable.tournamentId })
    .from(handicapHistoryTable).where(eq(handicapHistoryTable.userId, targetUserId))
    .orderBy(asc(handicapHistoryTable.recordedAt)).limit(24);
  const tHcpTrend = tHcpHistory.length > 0
    ? tHcpHistory.map(h => ({ handicapIndex: Number(h.handicapIndex), recordedAt: h.recordedAt, tournamentId: h.tournamentId }))
    : playerRows.filter(p => p.handicapIndex).map(p => ({ handicapIndex: Number(p.handicapIndex), recordedAt: null, tournamentId: p.tournamentId }));

  // Course breakdown
  const tCourseStats = new Map<number, { courseId: number; rounds: number; totalGross: number; avgGross: number; bestGross: number | null }>();
  for (const r of tRoundSummaries) {
    const cid = tTournamentCourseMap.get(r.tournamentId);
    if (!cid) continue;
    if (!tCourseStats.has(cid)) tCourseStats.set(cid, { courseId: cid, rounds: 0, totalGross: 0, avgGross: 0, bestGross: null });
    const cs = tCourseStats.get(cid)!;
    cs.rounds++; cs.totalGross += r.gross;
    cs.avgGross = Math.round((cs.totalGross / cs.rounds) * 10) / 10;
    if (cs.bestGross === null || r.gross < cs.bestGross) cs.bestGross = r.gross;
  }

  // SG for target user
  const tTournamentHoleParsForSG = new Map<number, Map<number, number>>();
  for (const [tid, cid] of tTournamentCourseMap.entries()) {
    const holeParMap = tCourseHoleParMap.get(cid);
    if (holeParMap) tTournamentHoleParsForSG.set(tid, holeParMap);
  }
  // Task #1643 — Resolve target user's SG baseline (admin sees the player's
  // own auto-pick by default; query override always wins).
  const [tSgPrefRow, tSgWhsRow, tSgHcpHistoryRow] = await Promise.all([
    db.select({ pref: appUsersTable.preferredSgBaseline })
      .from(appUsersTable).where(eq(appUsersTable.id, targetUserId)).limit(1),
    db.select({ hi: whsPlayerStateTable.currentHandicapIndex })
      .from(whsPlayerStateTable)
      .where(eq(whsPlayerStateTable.userId, targetUserId))
      .orderBy(desc(whsPlayerStateTable.lastRecalcAt))
      .limit(1)
      .catch(() => [] as { hi: string | null }[]),
    db.select({ hi: handicapHistoryTable.handicapIndex })
      .from(handicapHistoryTable)
      .where(eq(handicapHistoryTable.userId, targetUserId))
      .orderBy(desc(handicapHistoryTable.recordedAt))
      .limit(1),
  ]);
  const tSgPreference = tSgPrefRow[0]?.pref ?? null;
  const tFallbackHi = playerRows.find(p => p.handicapIndex != null)?.handicapIndex ?? null;
  const tSgRawHi = tSgWhsRow[0]?.hi ?? tSgHcpHistoryRow[0]?.hi ?? tFallbackHi ?? null;
  const tSgHandicapIndex = tSgRawHi != null ? parseFloat(String(tSgRawHi)) : null;
  const tSgResolved = resolveSgBaseline({
    override: tSgBaselineOverride,
    preference: tSgPreference,
    handicapIndex: tSgHandicapIndex,
  });
  const tSgSummary = await computePlayerSGFromDB(tPlayerIds, tSgResolved.primary, tTournamentHoleParsForSG);

  // Hole averages
  const tHoleAggregates = new Map<number, { totalStrokes: number; count: number; totalPar: number }>();
  for (const s of tAllScores) {
    if (!tHoleAggregates.has(s.holeNumber)) tHoleAggregates.set(s.holeNumber, { totalStrokes: 0, count: 0, totalPar: 0 });
    const agg = tHoleAggregates.get(s.holeNumber)!;
    agg.totalStrokes += s.strokes; agg.count++; agg.totalPar += tGetHolePar(s.tournamentId, s.holeNumber);
  }
  const tHoleAverages = Array.from({ length: 18 }, (_, i) => {
    const hn = i + 1; const agg = tHoleAggregates.get(hn);
    if (!agg || agg.count === 0) return { holeNumber: hn, avgStrokes: null, avgPar: null, avgToPar: null, count: 0 };
    const avgStrokes = Math.round((agg.totalStrokes / agg.count) * 100) / 100;
    const avgPar = Math.round((agg.totalPar / agg.count) * 100) / 100;
    return { holeNumber: hn, avgStrokes, avgPar, avgToPar: Math.round((avgStrokes - avgPar) * 100) / 100, count: agg.count };
  });

  const tRecentRounds = tRoundSummaries.slice(-12).map(r => ({
    playerId: r.playerId, tournamentId: r.tournamentId, round: r.round, gross: r.gross, par: r.par, toPar: r.toPar,
    birdies: r.birdies, eagles: r.eagles,
    fairwayPct: r.fairwayOps > 0 ? Math.round((r.fairwaysHit / r.fairwayOps) * 100) : null,
    girPct: r.girOps > 0 ? Math.round((r.girHit / r.girOps) * 100) : null,
    avgPutts: r.puttOps > 0 ? Math.round((r.putts / r.puttOps) * 100) / 100 : null,
  }));

  res.set("Cache-Control", "private, max-age=300, stale-while-revalidate=60");
  res.json({
    targetUserId,
    playerName: targetUser?.displayName ?? targetUser?.username ?? null,
    roundsPlayed: tRoundSummaries.length,
    scoringAvg: tScoringAvg,
    bestRound: tGrosses.length > 0 ? Math.min(...tGrosses) : null,
    worstRound: tGrosses.length > 0 ? Math.max(...tGrosses) : null,
    eagles: tRoundSummaries.reduce((a, r) => a + r.eagles, 0),
    birdies: tRoundSummaries.reduce((a, r) => a + r.birdies, 0),
    pars: tRoundSummaries.reduce((a, r) => a + r.pars, 0),
    bogeys: tRoundSummaries.reduce((a, r) => a + r.bogeys, 0),
    doublePlus: tRoundSummaries.reduce((a, r) => a + r.doublePlus, 0),
    fairwayPct: tTotalFwOps > 0 ? Math.round((tTotalFwHit / tTotalFwOps) * 100) : null,
    girPct: tTotalGIROps > 0 ? Math.round((tTotalGIRHit / tTotalGIROps) * 100) : null,
    avgPutts: tTotalPuttOps > 0 ? Math.round((tTotalPutts / tTotalPuttOps) * 100) / 100 : null,
    handicapTrend: tHcpTrend,
    holeAverages: tHoleAverages,
    recentRounds: tRecentRounds,
    courseBreakdown: [...tCourseStats.values()].sort((a, b) => b.rounds - a.rounds),
    period: tPeriod,
    strokesGained: {
      sgPutting: tSgSummary.sgPutting,
      sgApproach: tSgSummary.sgApproach,
      sgATG: tSgSummary.sgATG,
      sgOffTheTee: tSgSummary.sgOTT,
      sgTotal: tSgSummary.sgTotal,
      trackedRounds: tSgSummary.trackedRounds,
      baseline: tSgSummary.baseline,
      roundDetail: tSgSummary.roundResults.slice(-12),
      sgPuttingMeasuredRounds: tSgSummary.sgPuttingMeasuredRounds,
      sgPuttingEstimatedRounds: tSgSummary.sgPuttingEstimatedRounds,
      // Task #1643 — surface the target player's preference + auto-pick
      // metadata so admin tools can show the same source copy and avoid
      // accidentally pinning the wrong cohort while reviewing.
      preferredBaseline: tSgPreference ?? "auto",
      primaryBaseline: tSgResolved.primary,
      baselineSource: tSgResolved.source,
      handicapIndex: tSgHandicapIndex !== null && Number.isFinite(tSgHandicapIndex) ? tSgHandicapIndex : null,
    },
  });
});

// Task #2047 — Coach/admin pins or unpins a player's SG baseline on their
// behalf from the admin stats view. The picker on the player-side stats
// page already PUTs `/portal/player/sg-baseline-preference`; this endpoint
// is the admin-side mirror that (a) checks the same org-scoping rules as
// the GET admin stats endpoint above and (b) writes a member_audit_log
// row attributing the change to the coach. After the pin lands the
// player will see the pinned-source copy on their next Stats open
// (their existing GET reads `app_users.preferred_sg_baseline`).
//
// Body: { baseline: 'auto'|'scratch'|'10'|'18' }. 'auto' clears the pin
// and re-enables handicap-derived auto-pick (mirrors the player-self route).
router.put("/portal/stats/:targetUserId/sg-baseline-preference", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const callerId = req.user!.id;
  const callerRole = req.user!.role ?? "player";

  // Same role gate as the GET admin stats endpoint: only org_admin /
  // super_admin may pin a baseline on behalf of a player.
  if (callerRole !== "org_admin" && callerRole !== "super_admin") {
    res.status(403).json({ error: "Forbidden: org admin access required" });
    return;
  }

  const targetUserId = parseInt(String((req.params as Record<string, string>).targetUserId), 10);
  if (isNaN(targetUserId)) { res.status(400).json({ error: "Invalid userId" }); return; }

  const raw = (req.body as { baseline?: unknown }).baseline;
  if (typeof raw !== "string" || !["auto", "scratch", "10", "18"].includes(raw)) {
    res.status(400).json({ error: "baseline must be one of: auto, scratch, 10, 18" });
    return;
  }

  // Resolve org context for both permission scoping and the audit row.
  // org_admin: must share an org with the target (same shape as GET).
  // super_admin: best-effort lookup so the audit can still link to a
  // member; falls back to a system-level audit row when no shared org
  // is found (member_audit_log.organization_id is nullable).
  let orgId: number | null = null;
  if (callerRole === "org_admin") {
    const [callerMembership] = await db
      .select({ organizationId: orgMembershipsTable.organizationId })
      .from(orgMembershipsTable)
      .where(and(eq(orgMembershipsTable.userId, callerId), eq(orgMembershipsTable.role, "org_admin")));

    if (!callerMembership) {
      res.status(403).json({ error: "Forbidden: no active org admin membership found" });
      return;
    }

    const [targetMembership] = await db
      .select({ id: orgMembershipsTable.id })
      .from(orgMembershipsTable)
      .where(and(
        eq(orgMembershipsTable.userId, targetUserId),
        eq(orgMembershipsTable.organizationId, callerMembership.organizationId),
      ));

    if (!targetMembership) {
      res.status(403).json({ error: "Forbidden: target user is not in your organization" });
      return;
    }
    orgId = callerMembership.organizationId;
  } else {
    const [tm] = await db
      .select({ organizationId: orgMembershipsTable.organizationId })
      .from(orgMembershipsTable)
      .where(eq(orgMembershipsTable.userId, targetUserId))
      .limit(1);
    orgId = tm?.organizationId ?? null;
  }

  // Capture the prior pin so the audit row records a clean from→to delta
  // (and so we can confirm the target user actually exists before mutating).
  const [priorRow] = await db
    .select({ pref: appUsersTable.preferredSgBaseline, displayName: appUsersTable.displayName, username: appUsersTable.username })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, targetUserId));
  if (!priorRow) {
    res.status(404).json({ error: "Target user not found" });
    return;
  }

  const next = raw === "auto" ? null : raw;
  const prior = priorRow.pref;

  await db.update(appUsersTable)
    .set({ preferredSgBaseline: next, updatedAt: new Date() })
    .where(eq(appUsersTable.id, targetUserId));

  // Best-effort: link the audit row to the target's club_members row in
  // the resolved org so the entry shows up on their member-360 timeline.
  let clubMemberId: number | null = null;
  if (orgId !== null) {
    const [cm] = await db
      .select({ id: clubMembersTable.id })
      .from(clubMembersTable)
      .where(and(eq(clubMembersTable.userId, targetUserId), eq(clubMembersTable.organizationId, orgId)))
      .limit(1);
    clubMemberId = cm?.id ?? null;
  }

  // Audit row — direct insert (rather than via recordMemberAudit) so we
  // can persist a system-level row (organization_id NULL) when a
  // super_admin pins for a player with no current org membership.
  // Failures are swallowed deliberately so the pin still lands even if
  // the audit table is briefly unavailable; this matches the silent-
  // fallback pattern used by `recordMemberAudit` itself.
  const targetLabel = priorRow.displayName ?? priorRow.username ?? `user ${targetUserId}`;
  const labelOf = (b: string | null) => b === null ? "auto" : b === "scratch" ? "Tour/Scratch" : `${b}-hcp`;
  const reason = next === null
    ? `Cleared SG baseline pin for ${targetLabel} (re-enabled handicap auto-pick)`
    : `Pinned SG baseline to ${labelOf(next)} for ${targetLabel}`;
  try {
    const actor = req.user as { id: number; displayName?: string | null; email?: string | null; role?: string | null };
    await db.insert(memberAuditLogTable).values({
      organizationId: orgId,
      clubMemberId,
      actorUserId: actor.id,
      actorName: actor.displayName ?? actor.email ?? null,
      actorRole: actor.role ?? null,
      entity: "sg_baseline_preference",
      entityId: targetUserId,
      action: "update",
      fieldChanges: {
        preferredSgBaseline: { from: prior ?? "auto", to: next ?? "auto" },
      },
      reason,
      ipAddress: (req.ip ?? (req.headers["x-forwarded-for"] as string | undefined) ?? null) as string | null,
      userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
    });
  } catch {
    // non-fatal — preference is the source of truth, audit is best-effort
  }

  res.json({ targetUserId, preferredBaseline: next ?? "auto" });
});

// GET /api/portal/org-members — admin/coach: list org members for analytics player picker
// Returns a list of members in the caller's org (name + userId) for use in the admin analytics view.
router.get("/portal/org-members", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const callerRole = req.user!.role ?? "player";
  if (!["org_admin", "super_admin", "tournament_director"].includes(callerRole)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const callerId = req.user!.id;

  // Find the caller's org
  let orgId: number | null = null;
  if (callerRole === "super_admin") {
    // super_admin can pass ?orgId=
    orgId = req.query.orgId ? parseInt(req.query.orgId as string, 10) : null;
    if (!orgId) { { res.json([]); return; } }
  } else {
    const [membership] = await db.select({ organizationId: orgMembershipsTable.organizationId })
      .from(orgMembershipsTable).where(eq(orgMembershipsTable.userId, callerId));
    orgId = membership?.organizationId ?? null;
  }
  if (!orgId) { { res.json([]); return; } }

  const members = await db
    .select({
      userId: orgMembershipsTable.userId,
      role: orgMembershipsTable.role,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      email: appUsersTable.email,
    })
    .from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(orgMembershipsTable.userId, appUsersTable.id))
    .where(eq(orgMembershipsTable.organizationId, orgId))
    .orderBy(asc(appUsersTable.displayName));

  res.json(members.map(m => ({
    userId: m.userId,
    role: m.role,
    displayName: m.displayName ?? m.username,
    email: m.email,
  })));
});

// GET /api/portal/achievements — achievements earned by the current user
router.get("/portal/achievements", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const achievements = await db.select()
    .from(achievementsTable)
    .where(eq(achievementsTable.userId, req.user!.id))
    .orderBy(desc(achievementsTable.earnedAt));
  res.json(achievements);
});

// GET /api/portal/wearable-connections — wearable device links for the current user
router.get("/portal/wearable-connections", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const connections = await db.select().from(wearableConnectionsTable).where(eq(wearableConnectionsTable.userId, req.user!.id));
  res.json(connections);
});

// POST /api/portal/wearable-connections — register a wearable connection (manual / GPX placeholder)
router.post("/portal/wearable-connections", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const { provider } = req.body as { provider?: string };
  if (!provider) { { res.status(400).json({ error: "provider required" }); return; } }
  const validProviders = ["garmin", "apple_watch", "apple_health", "fitbit", "arccos", "gpx", "manual", "health_connect"];
  if (!validProviders.includes(provider)) { { res.status(400).json({ error: "unknown provider" }); return; } }

  const [conn] = await db.insert(wearableConnectionsTable).values({
    userId: req.user!.id, provider, status: "connected", updatedAt: new Date(),
  }).onConflictDoUpdate({ target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider], set: { status: "connected", updatedAt: new Date() } }).returning();
  res.json(conn);
});

// DELETE /api/portal/wearable-connections/:provider — remove a wearable connection
router.delete("/portal/wearable-connections/:provider", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  await db.delete(wearableConnectionsTable)
    .where(and(eq(wearableConnectionsTable.userId, req.user!.id), eq(wearableConnectionsTable.provider, (req.params as Record<string, string>).provider)));
  res.json({ deleted: true });
});

// ── Wearable OAuth flows ──────────────────────────────────────────────────────

// GET /api/portal/wearables/garmin/init — return Garmin OAuth2 authorization URL
router.get("/portal/wearables/garmin/init", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const result = getGarminOAuthUrl(req.user!.id, baseUrl);
  if ("error" in result) { { res.status(503).json({ error: result.error }); return; } }
  res.json(result);
});

// GET /api/portal/wearables/garmin/callback — Garmin OAuth2 callback
router.get("/portal/wearables/garmin/callback", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const code = req.query.oauth_token as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code) { { res.status(400).json({ error: "Missing oauth_token" }); return; } }
  if (!state) { { res.status(400).json({ error: "Missing state — possible CSRF" }); return; } }
  const result = await handleGarminCallback(code, state, req.user!.id);
  if (!result.ok) { { res.status(502).json({ error: result.error }); return; } }
  res.json({ connected: true, provider: "garmin" });
});

// GET /api/portal/wearables/arccos/init — return Arccos OAuth2 authorization URL
router.get("/portal/wearables/arccos/init", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const result = getArccosOAuthUrl(req.user!.id, baseUrl);
  if ("error" in result) { { res.status(503).json({ error: result.error }); return; } }
  res.json(result);
});

// GET /api/portal/wearables/arccos/callback — Arccos OAuth2 callback
router.get("/portal/wearables/arccos/callback", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code) { { res.status(400).json({ error: "Missing code" }); return; } }
  if (!state) { { res.status(400).json({ error: "Missing state — possible CSRF" }); return; } }
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const result = await handleArccosCallback(code, state, req.user!.id, baseUrl);
  if (!result.ok) { { res.status(502).json({ error: result.error }); return; } }
  res.json({ connected: true, provider: "arccos" });
});

// POST /api/portal/wearables/gpx — upload a GPX file (text body, max 5 MB)
// Optional query params to enable shot ingestion:
//   playerId, tournamentId, round, courseId — when all present, waypoints are
//   mapped to holes and inserted into the shots table.
router.post("/portal/wearables/gpx", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const gpxContent: string = typeof req.body === "string" ? req.body : (req.body as { content?: string }).content ?? "";
  if (!gpxContent) { { res.status(400).json({ error: "GPX content required in request body" }); return; } }

  // Parse optional round-context query params
  const { playerId: pId, tournamentId: tId, round: rnd, courseId: cId } = req.query as Record<string, string | undefined>;
  const hasContext = pId && tId && rnd && cId;
  let context: { playerId: number; tournamentId: number; round: number; courseId: number } | undefined;

  if (hasContext) {
    const parsedPlayerId = parseInt(pId);
    const parsedTournamentId = parseInt(tId);
    if (isNaN(parsedPlayerId) || isNaN(parsedTournamentId)) {
      res.status(400).json({ error: "Invalid context parameters" });
      return;
    }

    // Authz: verify the authenticated user owns this player record
    const [player] = await db
      .select({ userId: playersTable.userId, tournamentId: playersTable.tournamentId })
      .from(playersTable)
      .where(eq(playersTable.id, parsedPlayerId));

    if (!player) {
      res.status(404).json({ error: "Player record not found" });
      return;
    }
    if (player.userId !== req.user!.id) {
      res.status(403).json({ error: "Forbidden: you can only upload GPX for your own player record" });
      return;
    }
    if (player.tournamentId !== parsedTournamentId) {
      res.status(400).json({ error: "Player does not belong to the specified tournament" });
      return;
    }

    context = {
      playerId: parsedPlayerId,
      tournamentId: parsedTournamentId,
      round: parseInt(rnd),
      courseId: parseInt(cId),
    };
  }

  const result = await processGPXUpload(req.user!.id, gpxContent, context);
  if (!result.ok) { { res.status(422).json({ error: result.error }); return; } }
  res.json({
    connected: true,
    provider: "gpx",
    shotsInserted: result.shotsInserted,
    track: {
      name: result.track.name,
      points: result.track.points.length,
      totalDistanceKm: Math.round(result.track.totalDistanceMeters / 10) / 100,
      durationMinutes: result.track.durationSeconds ? Math.round(result.track.durationSeconds / 60) : null,
      startTime: result.track.startTime,
    },
  });
});

// POST /api/portal/wearables/:provider/sync — trigger manual data sync for a connected wearable
router.post("/portal/wearables/:provider/sync", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const provider = (req.params as Record<string, string>).provider as "garmin" | "apple_health" | "arccos" | "gpx" | "whoop" | "google_fit";
  const syncResult = await syncWearableData(req.user!.id, provider);
  res.json(syncResult);
});

// Helper: best-effort look up the (organizationId, clubMemberId) pair for the
// current user so wearable / wellness actions can be audited under the user's
// home club. Returns null when the user has no club membership (e.g. solo
// players using the public portal) — in that case the audit is silently skipped.
async function lookupAuditScope(userId: number): Promise<{ organizationId: number; clubMemberId: number | null } | null> {
  const [row] = await db.select({
    organizationId: clubMembersTable.organizationId,
    clubMemberId: clubMembersTable.id,
  }).from(clubMembersTable).where(eq(clubMembersTable.userId, userId)).limit(1);
  if (!row) return null;
  return row;
}

async function auditWearableEvent(
  req: Request,
  userId: number,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const scope = await lookupAuditScope(userId);
  if (!scope) return;
  await recordMemberAudit({
    req,
    organizationId: scope.organizationId,
    clubMemberId: scope.clubMemberId,
    entity: "wearable_connection",
    entityId: userId,
    action,
    metadata,
  }).catch(() => {});
}

// ─── WHOOP & GOOGLE FIT OAUTH ────────────────────────────────────────────────

router.get("/portal/wearables/whoop/init", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const result = getWhoopOAuthUrl(req.user!.id, baseUrl);
  if ("error" in result) { { res.status(503).json({ error: result.error }); return; } }
  res.json(result);
});

router.get("/portal/wearables/whoop/callback", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code) { { res.status(400).json({ error: "Missing code" }); return; } }
  if (!state) { { res.status(400).json({ error: "Missing state — possible CSRF" }); return; } }
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const result = await handleWhoopCallback(code, state, req.user!.id, baseUrl);
  if (!result.ok) { { res.status(502).json({ error: result.error }); return; } }
  await auditWearableEvent(req, req.user!.id, "wearable.connect", { provider: "whoop" });
  res.json({ connected: true, provider: "whoop" });
});

router.get("/portal/wearables/google_fit/init", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const result = getGoogleFitOAuthUrl(req.user!.id, baseUrl);
  if ("error" in result) { { res.status(503).json({ error: result.error }); return; } }
  res.json(result);
});

router.get("/portal/wearables/google_fit/callback", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code) { { res.status(400).json({ error: "Missing code" }); return; } }
  if (!state) { { res.status(400).json({ error: "Missing state — possible CSRF" }); return; } }
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const result = await handleGoogleFitCallback(code, state, req.user!.id, baseUrl);
  if (!result.ok) { { res.status(502).json({ error: result.error }); return; } }
  await auditWearableEvent(req, req.user!.id, "wearable.connect", { provider: "google_fit" });
  res.json({ connected: true, provider: "google_fit" });
});

// ─── WELLNESS DATA & READINESS ───────────────────────────────────────────────

// GET /api/portal/wellness/today — returns today's aggregated wellness snapshot
// plus a coaching readiness recommendation. Used by the home screen pre-round
// readiness card and the round setup flow.
router.get("/portal/wellness/today", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const days = await getAggregatedWellnessDays(req.user!.id, 2);
  const today = days[0] ?? null;
  const recommendation = computeReadinessRecommendation(
    today?.readinessScore ?? null,
    today?.sleepMinutes ?? null,
  );
  res.json({ today, recommendation });
});

// GET /api/portal/wellness/daily?rangeDays=30|60|90 — wellness dashboard time
// series for the player's chosen range. The range is persisted on
// `user_health_prefs` (Task #1091) so it follows the player across devices;
// when no `rangeDays` (or legacy `days`) param is supplied the route reads
// the stored preference, falling back to a 30-day default. Also returns the
// player's handicap-index trend over the same window so the dashboard can
// overlay recovery metrics against handicap movement.
router.get("/portal/wellness/daily", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  // rangeDays: visible range (in days) for the dashboard charts. Constrained
  // to a fixed allow-list (30/60/90) so the UI selector and backend stay in
  // sync. The legacy `?days=N` query param is also accepted for backwards
  // compatibility — when it falls inside the allow-list it persists, otherwise
  // it just controls this single response.
  //
  // Task #1091 — like the trailing window (Task #946 below), the player's
  // chosen range is persisted on `user_health_prefs` so it follows them across
  // devices. When the client passes `?rangeDays=N` (or a valid `?days=N`) we
  // upsert it; otherwise we read the stored preference (or fall back to the
  // default 30). The resolved value is echoed back in the response so the
  // client can sync its local cache.
  const ALLOWED_RANGE_DAYS = [30, 60, 90] as const;
  const rawRangeDays = req.query.rangeDays ?? req.query.days;
  const hasRequestedRange = rawRangeDays != null;
  const requestedRange = parseInt(String(rawRangeDays ?? ""));
  const requestedRangeValid =
    hasRequestedRange && (ALLOWED_RANGE_DAYS as readonly number[]).includes(requestedRange);
  let rangeDaysStored = false;
  let days = 30;
  if (requestedRangeValid) {
    days = requestedRange;
    await db
      .insert(userHealthPrefsTable)
      .values({ userId: req.user!.id, wellnessRangeDays: days })
      .onConflictDoUpdate({
        target: userHealthPrefsTable.userId,
        set: { wellnessRangeDays: days, updatedAt: new Date() },
      });
    rangeDaysStored = true;
  } else if (hasRequestedRange) {
    // Out-of-allow-list `?days=N` — honour the request for this response only
    // (legacy behaviour) but don't persist it. Clamp to the historical 1..90
    // bounds so callers passing arbitrary day counts still work.
    days = Math.max(1, Math.min(90, requestedRange || 30));
  } else {
    const [pref] = await db
      .select({ wellnessRangeDays: userHealthPrefsTable.wellnessRangeDays })
      .from(userHealthPrefsTable)
      .where(eq(userHealthPrefsTable.userId, req.user!.id));
    if (
      pref?.wellnessRangeDays != null &&
      (ALLOWED_RANGE_DAYS as readonly number[]).includes(pref.wellnessRangeDays)
    ) {
      days = pref.wellnessRangeDays;
      rangeDaysStored = true;
    }
  }
  // trailingWindow: how many recent rounds the scoring-average overlay averages
  // over. Constrained to a fixed allow-list so the UI selector and backend stay
  // in sync; falls back to 5 if missing or out-of-range.
  //
  // Task #946 — the player's choice is persisted on `user_health_prefs` so it
  // follows them across devices. When the client passes ?trailingWindow=N with
  // a valid value we upsert it; otherwise we read the stored preference (or
  // fall back to the default 5). Either way the resolved value is echoed back
  // in the response so the client can sync its local cache.
  const ALLOWED_TRAILING_WINDOWS = [3, 5, 10, 20] as const;
  const hasRequestedWindow = req.query.trailingWindow != null;
  const requestedWindow = parseInt(String(req.query.trailingWindow ?? ""));
  const requestedWindowValid =
    hasRequestedWindow && (ALLOWED_TRAILING_WINDOWS as readonly number[]).includes(requestedWindow);
  let TRAILING_WINDOW = 5;
  // `trailingWindowStored` tells the client whether the resolved value came
  // from the user's persisted profile (true) or the server-side default (false).
  // The mobile app uses this to decide whether to upload its local AsyncStorage
  // cache once after the upgrade — backfilling pre-existing per-device choices
  // without clobbering values set on other devices.
  let trailingWindowStored = false;
  if (requestedWindowValid) {
    TRAILING_WINDOW = requestedWindow;
    await db
      .insert(userHealthPrefsTable)
      .values({ userId: req.user!.id, wellnessTrailingWindow: TRAILING_WINDOW })
      .onConflictDoUpdate({
        target: userHealthPrefsTable.userId,
        set: { wellnessTrailingWindow: TRAILING_WINDOW, updatedAt: new Date() },
      });
    trailingWindowStored = true;
  } else {
    const [pref] = await db
      .select({ wellnessTrailingWindow: userHealthPrefsTable.wellnessTrailingWindow })
      .from(userHealthPrefsTable)
      .where(eq(userHealthPrefsTable.userId, req.user!.id));
    if (
      pref?.wellnessTrailingWindow != null &&
      (ALLOWED_TRAILING_WINDOWS as readonly number[]).includes(pref.wellnessTrailingWindow)
    ) {
      TRAILING_WINDOW = pref.wellnessTrailingWindow;
      trailingWindowStored = true;
    }
  }
  const series = await getAggregatedWellnessDays(req.user!.id, days);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const hcpRows = await db
    .select({
      handicapIndex: handicapHistoryTable.handicapIndex,
      recordedAt: handicapHistoryTable.recordedAt,
    })
    .from(handicapHistoryTable)
    .where(and(
      eq(handicapHistoryTable.userId, req.user!.id),
      gte(handicapHistoryTable.recordedAt, since),
    ))
    .orderBy(asc(handicapHistoryTable.recordedAt));
  const handicapTrend = hcpRows.map((h) => ({
    handicapIndex: Number(h.handicapIndex),
    recordedAt: h.recordedAt ? h.recordedAt.toISOString() : null,
  }));

  // ── Scoring-average overlay ───────────────────────────────────────────────
  // Trailing 5-round scoring average. We pull every confirmed round (tournament
  // submissions + general play) for the user, ordered oldest-first, then walk
  // forward computing the trailing-window average ending at each round date.
  // The wellness chart only plots points whose date lands inside the visible
  // window, but earlier rounds are needed to "seed" the trailing window for
  // points near the start of the range.
  type RawRound = { date: Date; gross: number };
  const rawRounds: RawRound[] = [];
  // Tournament rounds via roundSubmissionsTable (countersigned/approved).
  // We let DB errors propagate — they indicate real schema/auth issues that
  // should surface rather than silently produce an empty overlay.
  const subRows = await db
    .select({
      totalStrokes: roundSubmissionsTable.totalStrokes,
      submittedAt: roundSubmissionsTable.submittedAt,
      reviewedAt: roundSubmissionsTable.reviewedAt,
      startDate: tournamentsTable.startDate,
      status: roundSubmissionsTable.status,
    })
    .from(roundSubmissionsTable)
    .innerJoin(playersTable, eq(playersTable.id, roundSubmissionsTable.playerId))
    .innerJoin(tournamentsTable, eq(tournamentsTable.id, roundSubmissionsTable.tournamentId))
    .where(and(
      eq(playersTable.userId, req.user!.id),
      inArray(roundSubmissionsTable.status, ["countersigned", "approved"]),
    ));
  for (const r of subRows) {
    if (r.totalStrokes == null) continue;
    const d = r.startDate ?? r.reviewedAt ?? r.submittedAt;
    if (!d) continue;
    rawRounds.push({ date: d, gross: r.totalStrokes });
  }
  const gpRows = await db
    .select({
      grossScore: generalPlayRoundsTable.grossScore,
      playedAt: generalPlayRoundsTable.playedAt,
    })
    .from(generalPlayRoundsTable)
    .where(and(
      eq(generalPlayRoundsTable.userId, req.user!.id),
      eq(generalPlayRoundsTable.status, "confirmed"),
    ));
  for (const r of gpRows) {
    if (r.grossScore == null) continue;
    rawRounds.push({ date: r.playedAt, gross: r.grossScore });
  }
  rawRounds.sort((a, b) => a.date.getTime() - b.date.getTime());
  const scoringTrend: { scoringAvg: number; recordedAt: string; roundsInWindow: number }[] = [];
  const windowStartMs = since.getTime();
  for (let i = 0; i < rawRounds.length; i++) {
    const r = rawRounds[i];
    // Only emit points inside the visible window — earlier rounds still seed
    // the trailing window via the slice below.
    if (r.date.getTime() < windowStartMs) continue;
    const lo = Math.max(0, i - (TRAILING_WINDOW - 1));
    const slice = rawRounds.slice(lo, i + 1);
    const sum = slice.reduce((a, b) => a + b.gross, 0);
    scoringTrend.push({
      scoringAvg: Math.round((sum / slice.length) * 10) / 10,
      recordedAt: r.date.toISOString(),
      roundsInWindow: slice.length,
    });
  }

  res.json({
    days,
    series,
    handicapTrend,
    scoringTrend,
    trailingWindow: TRAILING_WINDOW,
    trailingWindowStored,
    rangeDays: days,
    rangeDaysStored,
  });
});

// POST /api/portal/wellness/daily — push a daily wellness metric from the
// mobile app (Apple Health, Google Fit fallback for HealthKit-bridged data,
// or manual entry). Body: { metricDate, source, readinessScore?, sleepMinutes?, ... }
router.post("/portal/wellness/daily", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const body = req.body as Record<string, unknown>;
  const metricDate = String(body.metricDate ?? "").slice(0, 10);
  const source = String(body.source ?? "manual") as WellnessProvider;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(metricDate)) {
    res.status(400).json({ error: "metricDate must be YYYY-MM-DD" });
    return;
  }
  if (!WELLNESS_PROVIDERS.includes(source)) {
    res.status(400).json({ error: `source must be one of ${WELLNESS_PROVIDERS.join(", ")}` });
    return;
  }
  await upsertWellnessMetric({
    userId: req.user!.id,
    metricDate,
    source,
    readinessScore: typeof body.readinessScore === "number" ? body.readinessScore : null,
    sleepMinutes: typeof body.sleepMinutes === "number" ? body.sleepMinutes : null,
    sleepScore: typeof body.sleepScore === "number" ? body.sleepScore : null,
    hrvMs: typeof body.hrvMs === "number" ? body.hrvMs : null,
    restingHr: typeof body.restingHr === "number" ? body.restingHr : null,
    steps: typeof body.steps === "number" ? body.steps : null,
    activeCalories: typeof body.activeCalories === "number" ? body.activeCalories : null,
    strainScore: typeof body.strainScore === "number" ? body.strainScore : null,
  });
  res.json({ ok: true });
});

// DELETE /api/portal/wellness/disconnect/:provider — revoke a wellness provider
// and purge stored daily metrics for that source. Audited.
router.delete("/portal/wellness/disconnect/:provider", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const rawProvider = (req.params as Record<string, string>).provider;
  // Health Connect (Android) is a "badge-only" provider — its data lives in
  // the wellness store under source: "google_fit" so the connection row can
  // safely be removed without purging metrics (which would also wipe data
  // from an actual Google Fit OAuth connection if one exists).
  if (rawProvider === "health_connect") {
    await db.delete(wearableConnectionsTable)
      .where(and(eq(wearableConnectionsTable.userId, req.user!.id), eq(wearableConnectionsTable.provider, "health_connect")));
    await auditWearableEvent(req, req.user!.id, "wearable.disconnect", { provider: "health_connect", purgedDailyMetrics: false });
    res.json({ ok: true, provider: "health_connect" });
    return;
  }
  const provider = rawProvider as WellnessProvider;
  if (!WELLNESS_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: `Unknown provider '${provider}'` });
    return;
  }
  await db.delete(wearableConnectionsTable)
    .where(and(eq(wearableConnectionsTable.userId, req.user!.id), eq(wearableConnectionsTable.provider, provider)));
  await db.delete(wellnessDailyMetricsTable)
    .where(and(eq(wellnessDailyMetricsTable.userId, req.user!.id), eq(wellnessDailyMetricsTable.source, provider)));
  await auditWearableEvent(req, req.user!.id, "wearable.disconnect", { provider, purgedDailyMetrics: true });
  res.json({ ok: true, provider });
});

// GET /api/portal/wellness/consent — list this user's wellness consent flags
router.get("/portal/wellness/consent", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const rows = await db.select().from(wellnessConsentsTable)
    .where(eq(wellnessConsentsTable.userId, req.user!.id));
  const SCOPES = ["share_with_coach", "share_with_club", "show_on_leaderboard", "export_csv"] as const;
  const result = SCOPES.map(scope => {
    const r = rows.find(x => x.scope === scope);
    return { scope, granted: r?.granted ?? false, grantedAt: r?.grantedAt ?? null };
  });
  res.json({ consents: result });
});

// PATCH /api/portal/wellness/consent — set a single scope { scope, granted }
router.patch("/portal/wellness/consent", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const body = req.body as { scope?: string; granted?: boolean };
  const SCOPES = new Set(["share_with_coach", "share_with_club", "show_on_leaderboard", "export_csv"]);
  if (!body.scope || !SCOPES.has(body.scope)) {
    res.status(400).json({ error: "Invalid consent scope" });
    return;
  }
  const granted = !!body.granted;
  await db.insert(wellnessConsentsTable).values({
    userId: req.user!.id,
    scope: body.scope,
    granted,
    grantedAt: new Date(),
    source: "mobile_app",
    ipAddress: req.ip ?? null,
  }).onConflictDoUpdate({
    target: [wellnessConsentsTable.userId, wellnessConsentsTable.scope],
    set: { granted, grantedAt: new Date(), source: "mobile_app", ipAddress: req.ip ?? null },
  });
  const scope = await lookupAuditScope(req.user!.id);
  if (scope) {
    await recordMemberAudit({
      req,
      organizationId: scope.organizationId,
      clubMemberId: scope.clubMemberId,
      entity: "wellness_consent",
      entityId: req.user!.id,
      action: granted ? "wellness_consent.grant" : "wellness_consent.revoke",
      metadata: { scope: body.scope },
    }).catch(() => {});
  }
  res.json({ ok: true, scope: body.scope, granted });
});

// GET /api/portal/wellness/correlation?days=60 — bucketed performance vs.
// readiness AND sleep duration, for the stats overlay. Each round (identified
// by player+round+date) is dropped into both a readiness band (full /
// conservative / rest / unknown) and a sleep band (good ≥7.5h / moderate
// 6–7.5h / short <6h / unknown). Average gross score and average SG-total are
// reported per bucket so the player can compare scoring + strokes-gained
// against recovery state.
router.get("/portal/wellness/correlation", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const days = Math.max(7, Math.min(365, parseInt(String(req.query.days ?? "60")) || 60));
  const series = await getAggregatedWellnessDays(req.user!.id, days);

  // Pull every player record for this user, then compute per-round SG via
  // computePlayerSGFromDB and join each round to its scheduled date so we can
  // correlate strokes-gained against the day's readiness/sleep band.
  const userPlayers = await db
    .select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(eq(playersTable.userId, req.user!.id));
  const playerIds = userPlayers.map(p => p.id);

  type RoundAgg = { date: string; tournamentId: number; round: number; totalScore: number; sgTotal: number | null };
  const roundsByKey = new Map<string, RoundAgg>();

  if (playerIds.length > 0) {
    const cutoff = new Date(Date.now() - days * 86400 * 1000);
    const holes = await db
      .select({ playerId: scoresTable.playerId, score: scoresTable.strokes, recordedAt: scoresTable.submittedAt, round: scoresTable.round, tournamentId: scoresTable.tournamentId })
      .from(scoresTable)
      .where(gte(scoresTable.submittedAt, cutoff));
    for (const h of holes) {
      if (!playerIds.includes(h.playerId) || !h.recordedAt) continue;
      const date = new Date(h.recordedAt).toISOString().slice(0, 10);
      const key = `${date}__${h.playerId}__${h.round}`;
      const existing = roundsByKey.get(key) ?? { date, tournamentId: h.tournamentId, round: h.round, totalScore: 0, sgTotal: null };
      existing.totalScore += h.score ?? 0;
      roundsByKey.set(key, existing);
    }

    // Per-round SG: compute once per user and join by (tournamentId, round) to
    // the date keys we already grouped above.
    try {
      const sg = await computePlayerSGFromDB(playerIds);
      const sgByKey = new Map<string, number>(); // tournamentId__round → sgTotal
      for (const r of sg.roundResults) {
        if (r.sgTotal != null) sgByKey.set(`${r.tournamentId}__${r.round}`, r.sgTotal);
      }
      for (const round of roundsByKey.values()) {
        const sgVal = sgByKey.get(`${round.tournamentId}__${round.round}`);
        if (sgVal != null) round.sgTotal = sgVal;
      }
    } catch {
      // SG is best-effort — leave sgTotal null on failure.
    }
  }

  type Bucket = { rounds: number; totalScore: number; avgScore: number; sgRounds: number; sgTotal: number; avgSgTotal: number | null };
  const empty = (): Bucket => ({ rounds: 0, totalScore: 0, avgScore: 0, sgRounds: 0, sgTotal: 0, avgSgTotal: null });

  const readinessBuckets = { rest: empty(), conservative: empty(), full: empty(), unknown: empty() };
  const sleepBuckets = { short: empty(), moderate: empty(), good: empty(), unknown: empty() };
  const wellnessByDate = new Map(series.map(d => [d.metricDate, d]));

  function sleepBand(min: number | null): keyof typeof sleepBuckets {
    if (min == null) return "unknown";
    if (min >= 450) return "good";       // ≥ 7h 30m
    if (min >= 360) return "moderate";   // 6h – 7h 29m
    return "short";                      // < 6h
  }

  // sampleSize counts only rounds that actually have a matched wellness day —
  // the UI labels this number "tagged with wellness data", so untagged rounds
  // must not inflate the count.
  let taggedRounds = 0;
  for (const round of roundsByKey.values()) {
    const wd = wellnessByDate.get(round.date);
    const rec = computeReadinessRecommendation(wd?.readinessScore ?? null, wd?.sleepMinutes ?? null);
    const rBucket: keyof typeof readinessBuckets = (wd?.readinessScore == null && wd?.sleepMinutes == null) ? "unknown" : rec.level;
    const sBucket = sleepBand(wd?.sleepMinutes ?? null);
    if (wd) taggedRounds += 1;

    for (const b of [readinessBuckets[rBucket], sleepBuckets[sBucket]]) {
      b.rounds += 1;
      b.totalScore += round.totalScore;
      if (round.sgTotal != null) {
        b.sgRounds += 1;
        b.sgTotal += round.sgTotal;
      }
    }
  }
  for (const b of [...Object.values(readinessBuckets), ...Object.values(sleepBuckets)]) {
    b.avgScore = b.rounds > 0 ? Math.round((b.totalScore / b.rounds) * 10) / 10 : 0;
    b.avgSgTotal = b.sgRounds > 0 ? Math.round((b.sgTotal / b.sgRounds) * 100) / 100 : null;
  }

  res.json({
    days,
    sampleSize: taggedRounds,
    totalRounds: roundsByKey.size,
    buckets: readinessBuckets,        // keep legacy name for existing UI
    sleepBuckets,
  });
});

// END WELLNESS ROUTES

// ─── HEART-RATE / STRESS OVERLAY (task 365) ──────────────────────────────────
// HR/HRV samples streamed from Apple Watch / Wear OS during a round, tagged
// to the active hole/shot. All endpoints check the per-user opt-in flag —
// capture is OFF by default and can be revoked at any time.

// GET /api/portal/health-prefs — current opt-in + baseline HR
router.get("/portal/health-prefs", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const prefs = await getUserHealthPrefs(req.user!.id);
  res.json(prefs);
});

// PUT /api/portal/health-prefs — toggle capture / set baseline HR
router.put("/portal/health-prefs", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const { hrCaptureEnabled, baselineHrBpm } = req.body as {
    hrCaptureEnabled?: boolean; baselineHrBpm?: number | null;
  };
  if (baselineHrBpm != null && (baselineHrBpm < 30 || baselineHrBpm > 130)) {
    res.status(400).json({ error: "baselineHrBpm must be between 30 and 130" });
    return;
  }
  const next = await setUserHealthPrefs(req.user!.id, { hrCaptureEnabled, baselineHrBpm });
  res.json(next);
});

// POST /api/portal/hr-samples/session — open or close the active HR-capture
// session for the calling user. The phone bridge calls this on hrStart
// (action="start") and hrStop (action="end"). The portal ingest endpoint
// refuses sample batches that arrive while no session is active, which
// catches stragglers from the watch after the phone process has been
// killed mid-round (Task #717).
router.post("/portal/hr-samples/session", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const action = (req.body as { action?: string })?.action;
  if (action !== "start" && action !== "end") {
    res.status(400).json({ error: "action must be 'start' or 'end'" });
    return;
  }
  if (action === "start") await markHrSessionActive(req.user!.id);
  else await markHrSessionEnded(req.user!.id);
  res.json({ ok: true, action });
});

// POST /api/portal/hr-samples — batch ingest of HR/HRV samples from the watch.
// Body: { tournamentId?, generalPlayRoundId?, playerId?, round?, samples: [...] }
router.post("/portal/hr-samples", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const body = req.body as {
    tournamentId?: number | null;
    generalPlayRoundId?: number | null;
    playerId?: number | null;
    round?: number;
    samples?: IngestHrSample[];
  };
  if (!Array.isArray(body.samples)) { { res.status(400).json({ error: "samples[] required" }); return; } }
  if (body.samples.length > 500) { { res.status(413).json({ error: "max 500 samples per batch" }); return; } }

  const result = await ingestHrSamples({
    userId: req.user!.id,
    tournamentId: body.tournamentId ?? null,
    generalPlayRoundId: body.generalPlayRoundId ?? null,
    playerId: body.playerId ?? null,
    round: body.round ?? 1,
  }, body.samples);
  res.json(result);
});

// GET /api/portal/hr-samples — list rounds for which the user has HR samples (most recent first).
router.get("/portal/hr-samples", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const rounds = await listHrSampleRoundsForUser(req.user!.id);
  res.json(rounds);
});

// GET /api/portal/hr-samples/round?tournamentId=&round=  (or generalPlayRoundId)
// Returns per-hole HR strip + per-shot waveform for one round.
router.get("/portal/hr-samples/round", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = req.query.tournamentId ? Number(req.query.tournamentId) : null;
  const generalPlayRoundId = req.query.generalPlayRoundId ? Number(req.query.generalPlayRoundId) : null;
  const round = req.query.round ? Number(req.query.round) : 1;
  if (!tournamentId && !generalPlayRoundId) {
    res.status(400).json({ error: "tournamentId or generalPlayRoundId required" });
    return;
  }
  const data = await getRoundHrStrip({ userId: req.user!.id, tournamentId, generalPlayRoundId, round });
  res.json(data);
});

// GET /api/portal/hr-samples/correlation — bogey-rate correlation widget.
router.get("/portal/hr-samples/correlation", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const thresholdBpm = req.query.thresholdBpm ? Number(req.query.thresholdBpm) : 15;
  const result = await getHrScoringCorrelation({ userId: req.user!.id, thresholdBpm });
  res.json(result);
});

// DELETE /api/portal/hr-samples — purge all HR data and revoke the consent flag.
router.delete("/portal/hr-samples", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const result = await deleteAllHrSamplesForUser(req.user!.id);
  res.json(result);
});

// ─── APPLE WATCH & WEAR OS COMPANION ─────────────────────────────────────────
// Compact endpoints for smartwatch display — minimal JSON, fast response

// GET /api/portal/watch/live-score — session or watchToken auth; hole-by-hole scores for active round.
router.get("/portal/watch/live-score", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  // Query by userId only — email fallback risks matching players with blank email under Bearer-token auth
  const playerRows = await db.select({ id: playersTable.id, tournamentId: playersTable.tournamentId, handicapIndex: playersTable.handicapIndex })
    .from(playersTable)
    .where(eq(playersTable.userId, userId))
    .limit(5);

  if (playerRows.length === 0) { { res.json({ hasActiveRound: false }); return; } }

  // Find most recent tournament with scores
  const ids = playerRows.map(p => p.tournamentId);
  const latestTournament = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(inArray(tournamentsTable.id, ids))
    .orderBy(desc(tournamentsTable.startDate))
    .limit(1)
    .then(r => r[0]);

  if (!latestTournament) { { res.json({ hasActiveRound: false }); return; } }

  const player = playerRows.find(p => p.tournamentId === latestTournament.id);
  if (!player) { { res.json({ hasActiveRound: false }); return; } }

  // Get most recent round scores
  const latestRound = await db.select({ round: scoresTable.round })
    .from(scoresTable)
    .where(and(eq(scoresTable.playerId, player.id), eq(scoresTable.tournamentId, latestTournament.id)))
    .orderBy(desc(scoresTable.round))
    .limit(1).then(r => r[0]?.round ?? 1);

  // Fetch tournament courseId separately to avoid join-order dependency
  const tournamentCourseRow = await db
    .select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, latestTournament.id))
    .limit(1)
    .then(r => r[0]);
  const tournamentCourseId = tournamentCourseRow?.courseId ?? 0;

  const holes = await db.select({
    holeNumber: scoresTable.holeNumber,
    strokes: scoresTable.strokes,
    par: holeDetailsTable.par,
    isVerified: scoresTable.isVerified,
  })
    .from(scoresTable)
    .leftJoin(holeDetailsTable, and(
      eq(holeDetailsTable.courseId, tournamentCourseId),
      eq(holeDetailsTable.holeNumber, scoresTable.holeNumber),
    ))
    .where(and(eq(scoresTable.playerId, player.id), eq(scoresTable.round, latestRound), eq(scoresTable.tournamentId, latestTournament.id)))
    .orderBy(asc(scoresTable.holeNumber));

  const totalStrokes = holes.reduce((s, h) => s + h.strokes, 0);
  const totalPar = holes.reduce((s, h) => s + (h.par ?? 4), 0);
  const toPar = totalStrokes - totalPar;
  const currentHole = holes.length + 1;
  const awaitingMarkerCount = holes.reduce((n, h) => n + (h.isVerified ? 0 : 1), 0);

  res.json({
    hasActiveRound: true,
    tournamentId: latestTournament.id,
    playerId: player.id,
    tournamentName: latestTournament.name,
    round: latestRound,
    holesPlayed: holes.length,
    currentHole: Math.min(currentHole, 18),
    totalStrokes,
    toPar,
    toParDisplay: toPar === 0 ? "E" : toPar > 0 ? `+${toPar}` : String(toPar),
    awaitingMarkerCount,
    holes: holes.map(h => ({
      holeNumber: h.holeNumber,
      strokes: h.strokes,
      par: h.par ?? 4,
      toPar: h.strokes - (h.par ?? 4),
      isVerified: h.isVerified,
      awaitingMarker: !h.isVerified,
    })),
  });
});

// GET /api/portal/watch/leaderboard — session or watchToken auth; top-10 leaderboard.
router.get("/portal/watch/leaderboard", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  // Optional tournamentId override from query params (watch can specify)
  const qtid = req.query.tournamentId ? parseInt(req.query.tournamentId as string, 10) : null;

  // Query by userId only — email fallback risks matching players with blank email under Bearer-token auth
  const playerRows = await db.select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(eq(playersTable.userId, userId))
    .limit(10);

  if (playerRows.length === 0) { { res.json({ leaderboard: [] }); return; } }

  // When caller requests a specific tournament, verify the authenticated user is enrolled in it.
  // Without this check an arbitrary tournamentId query param would expose cross-tournament data.
  if (qtid !== null) {
    const enrolled = playerRows.some(p => p.tournamentId === qtid);
    if (!enrolled) { { res.status(403).json({ error: "Not enrolled in requested tournament" }); return; } }
  }

  const tournamentId = qtid ?? playerRows[0].tournamentId;
  const [tournament] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.json({ leaderboard: [] }); return; } }

  const myPlayerId = playerRows.find(p => p.tournamentId === tournamentId)?.id ?? playerRows[0].id;

  // Aggregate scores by player — include hole count for holesPlayed and course par for toPar
  const allPlayers = await db.select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName })
    .from(playersTable).where(eq(playersTable.tournamentId, tournamentId));

  const allScores = await db.select({
    playerId: scoresTable.playerId,
    strokes: scoresTable.strokes,
    holeNumber: scoresTable.holeNumber,
  })
    .from(scoresTable).where(eq(scoresTable.tournamentId, tournamentId));

  const scoreMap = new Map<number, { total: number; holes: number }>();
  for (const s of allScores) {
    const cur = scoreMap.get(s.playerId) ?? { total: 0, holes: 0 };
    scoreMap.set(s.playerId, { total: cur.total + s.strokes, holes: cur.holes + 1 });
  }

  // Get course par for toPar calculation (assume par 72 if not available)
  const [tourCourse] = await db.select({ par: coursesTable.par })
    .from(coursesTable)
    .innerJoin(tournamentsTable, eq(tournamentsTable.courseId, coursesTable.id))
    .where(eq(tournamentsTable.id, tournamentId));
  const coursePar = tourCourse?.par ?? 72;
  const holePar = coursePar / 18; // average per-hole par for toPar normalisation

  const leaderboard = allPlayers
    .filter(p => scoreMap.has(p.id))
    .map(p => {
      const sc = scoreMap.get(p.id)!;
      const expectedPar = Math.round(sc.holes * holePar);
      return {
        playerId: p.id,
        name: `${p.firstName} ${p.lastName[0]}.`,
        total: sc.total,
        toPar: sc.total - expectedPar,
        holesPlayed: sc.holes,
        isMe: p.id === myPlayerId,
      };
    })
    .sort((a, b) => a.toPar - b.toPar)
    .slice(0, 10)
    .map((p, i) => ({ pos: i + 1, ...p }));

  res.json({ tournamentName: tournament.name, leaderboard });
});

// GET /api/portal/watch/status — session or watchToken auth; pairing state + active tournament info.
router.get("/portal/watch/status", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const [appleWatch] = await db.select({ status: wearableConnectionsTable.status, updatedAt: wearableConnectionsTable.updatedAt })
    .from(wearableConnectionsTable)
    .where(and(eq(wearableConnectionsTable.userId, userId), eq(wearableConnectionsTable.provider, "apple_watch")));

  const [wearOS] = await db.select({ status: wearableConnectionsTable.status, updatedAt: wearableConnectionsTable.updatedAt })
    .from(wearableConnectionsTable)
    .where(and(eq(wearableConnectionsTable.userId, userId), eq(wearableConnectionsTable.provider, "wear_os")));

  // Garmin Connect IQ companion (data field / app on Garmin watches).
  // Stored as provider "garmin_ciq" — distinct from the OAuth-based Garmin
  // Connect Health-API connection ("garmin"), which imports completed rounds
  // rather than acting as a live, on-watch experience.
  const [garminCiq] = await db.select({ status: wearableConnectionsTable.status, updatedAt: wearableConnectionsTable.updatedAt })
    .from(wearableConnectionsTable)
    .where(and(eq(wearableConnectionsTable.userId, userId), eq(wearableConnectionsTable.provider, "garmin_ciq")));

  // Fetch the most recent unexpired pairing code for this user (if any)
  const [pendingChallenge] = await db
    .select({ code: watchPairingChallengesTable.code })
    .from(watchPairingChallengesTable)
    .where(
      and(
        eq(watchPairingChallengesTable.userId, userId),
        sql`${watchPairingChallengesTable.expiresAt} > now()`,
        sql`${watchPairingChallengesTable.usedAt} is null`,
      ),
    )
    .orderBy(desc(watchPairingChallengesTable.createdAt))
    .limit(1);

  res.json({
    appleWatch: appleWatch ? { connected: appleWatch.status === "connected", lastSync: appleWatch.updatedAt } : null,
    wearOS: wearOS ? { connected: wearOS.status === "connected", lastSync: wearOS.updatedAt } : null,
    garminCiq: garminCiq ? { connected: garminCiq.status === "connected", lastSync: garminCiq.updatedAt } : null,
    pairingCode: pendingChallenge?.code ?? null,
    capabilities: ["live_score", "leaderboard", "hole_scoring", "distance_to_pin", "shot_tracking", "ws_watch"],
  });
});

function getUserIdFromWatchToken(req: Request): number | null {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return _verifyWatchToken(authHeader.slice(7));
}

// GET /api/portal/watch/pairing-code — session-authenticated; returns a fresh one-time 6-digit code + challengeId.
router.get("/portal/watch/pairing-code", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  // Expire any old unused codes for this user
  await db.delete(watchPairingChallengesTable)
    .where(eq(watchPairingChallengesTable.userId, userId));

  // Generate a cryptographically random 6-digit code (000000–999999)
  const code = String(parseInt(randomBytes(3).toString("hex"), 16) % 1_000_000).padStart(6, "0");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  const [inserted] = await db
    .insert(watchPairingChallengesTable)
    .values({ userId, code, platform: "any", expiresAt })
    .returning({ id: watchPairingChallengesTable.id });

  res.json({
    code,
    challengeId: inserted?.id?.toString() ?? null,
    expiresAt: expiresAt.toISOString(),
    expiresInSeconds: 600,
  });
});

// In-memory rate limiter for the public pairing endpoint (5 attempts per IP per 5 min)
const _pairAttempts = new Map<string, { count: number; resetAt: number }>();
function checkPairRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = _pairAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    _pairAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

// POST /api/public/watch/pair — public; watch submits 6-digit code (+ optional challengeId) to obtain a watchToken.
router.post("/public/watch/pair", async (req: Request, res: Response) => {
  const ip = (req.headers["x-forwarded-for"] as string ?? req.socket.remoteAddress ?? "unknown").split(",")[0]!.trim();
  if (!checkPairRateLimit(ip)) {
    res.status(429).json({ error: "Too many pairing attempts. Wait 5 minutes and try again." });
    return;
  }

  const { code, challengeId, platform } = req.body as { code?: string; challengeId?: string; platform?: string };
  if (!code || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "A 6-digit numeric pairing code is required" });
    return;
  }

  // Garmin Connect IQ has no companion bridge to deliver a challengeId, so we
  // permit code-only pairing for that platform. Security still relies on the
  // 10-minute one-shot window, the 5-attempt lockout, and per-IP rate limiting.
  const allowCodeOnly = platform === "garmin_ciq";

  if (!challengeId && !allowCodeOnly) {
    res.status(400).json({ error: "challengeId is required — open KHARAGOLF on your phone and tap Pair first." });
    return;
  }

  const challengeIdNum = challengeId ? parseInt(challengeId, 10) : null;
  if (challengeId && (challengeIdNum === null || isNaN(challengeIdNum))) {
    res.status(400).json({ error: "Invalid challengeId" });
    return;
  }

  const challengeWhere = and(
    eq(watchPairingChallengesTable.code, code),
    ...(challengeIdNum !== null ? [eq(watchPairingChallengesTable.id, challengeIdNum)] : []),
    sql`${watchPairingChallengesTable.expiresAt} > now()`,
    sql`${watchPairingChallengesTable.usedAt} is null`,
    sql`${watchPairingChallengesTable.attemptCount} < 5`,
  );

  const candidates = await db
    .select({ id: watchPairingChallengesTable.id, userId: watchPairingChallengesTable.userId, attemptCount: watchPairingChallengesTable.attemptCount })
    .from(watchPairingChallengesTable)
    .where(challengeWhere)
    .orderBy(desc(watchPairingChallengesTable.createdAt))
    .limit(2);

  // Code-only path (Garmin Connect IQ): if two different users happen to have
  // the same active 6-digit code we cannot safely choose between them — refuse
  // and force the user to request a fresh code rather than risk pairing the
  // watch to the wrong account.
  let challenge: typeof candidates[number] | undefined;
  if (candidates.length === 2 && candidates[0]!.userId !== candidates[1]!.userId) {
    challenge = undefined;
  } else {
    challenge = candidates[0];
  }

  // Preserve per-challenge attempt accounting: when the caller supplied a
  // challengeId, every attempt against that id consumes one of its 5 slots
  // (even if the code was wrong) so a brute-force still hits the lockout.
  if (challengeIdNum !== null) {
    await db.update(watchPairingChallengesTable)
      .set({ attemptCount: sql`${watchPairingChallengesTable.attemptCount} + 1` })
      .where(eq(watchPairingChallengesTable.id, challengeIdNum));
  } else if (challenge) {
    await db.update(watchPairingChallengesTable)
      .set({ attemptCount: sql`${watchPairingChallengesTable.attemptCount} + 1` })
      .where(eq(watchPairingChallengesTable.id, challenge.id));
  }

  if (!challenge) {
    res.status(400).json({ error: "Invalid, expired, or locked pairing code. Request a new code from your phone." });
    return;
  }

  await db.update(watchPairingChallengesTable)
    .set({ usedAt: new Date() })
    .where(eq(watchPairingChallengesTable.id, challenge.id));

  const userId = challenge.userId;
  const provider = resolveWatchProvider(platform);

  await db.insert(wearableConnectionsTable).values({
    userId,
    provider,
    status: "connected",
    connectedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
    set: { status: "connected", connectedAt: new Date(), updatedAt: new Date() },
  });

  const watchToken = issueWatchToken(userId);
  res.json({ ok: true, watchToken, expiresIn: "4h" });
});

// Map an opaque watch platform identifier to the wearable_connections.provider value.
// "garmin_ciq" is the live, on-watch Connect IQ companion (data field / app);
// "garmin" (without _ciq) is reserved for the OAuth Health-API import path.
function resolveWatchProvider(platform: string | undefined): "wear_os" | "garmin_ciq" | "apple_watch" {
  if (platform === "wear_os") return "wear_os";
  if (platform === "garmin_ciq") return "garmin_ciq";
  return "apple_watch";
}

// POST /api/portal/watch/sync — session-authenticated; re-marks connection active and issues fresh watchToken.
router.post("/portal/watch/sync", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const platform = (req.body as { platform?: string }).platform ?? "apple_watch";
  const provider = resolveWatchProvider(platform);

  await db.insert(wearableConnectionsTable).values({
    userId, provider, status: "connected", connectedAt: new Date(), updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
    set: { status: "connected", updatedAt: new Date() },
  });

  const watchToken = issueWatchToken(userId);
  res.json({ ok: true, watchToken, expiresIn: "4h" });
});

// POST /api/portal/watch/pair-confirm — session-authenticated; validates challenge code, returns watchToken.
router.post("/portal/watch/pair-confirm", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const { code, challengeId, platform } = req.body as { code?: string; challengeId?: string; platform?: string };

  if (!code || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "A 6-digit numeric pairing code is required" });
    return;
  }
  if (!challengeId) {
    res.status(400).json({ error: "challengeId is required" });
    return;
  }
  const challengeIdNum = parseInt(challengeId, 10);
  if (isNaN(challengeIdNum)) {
    res.status(400).json({ error: "Invalid challengeId" });
    return;
  }

  const [challenge] = await db
    .select({ id: watchPairingChallengesTable.id })
    .from(watchPairingChallengesTable)
    .where(
      and(
        eq(watchPairingChallengesTable.userId, userId),
        eq(watchPairingChallengesTable.code, code),
        eq(watchPairingChallengesTable.id, challengeIdNum),
        sql`${watchPairingChallengesTable.expiresAt} > now()`,
        sql`${watchPairingChallengesTable.usedAt} is null`,
      ),
    )
    .limit(1);

  if (!challenge) {
    res.status(400).json({ error: "Invalid or expired pairing code" });
    return;
  }

  // Mark challenge as used
  await db
    .update(watchPairingChallengesTable)
    .set({ usedAt: new Date() })
    .where(eq(watchPairingChallengesTable.id, challenge.id));

  const provider = resolveWatchProvider(platform);
  await db.insert(wearableConnectionsTable).values({
    userId,
    provider,
    status: "connected",
    connectedAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [wearableConnectionsTable.userId, wearableConnectionsTable.provider],
    set: { status: "connected", connectedAt: new Date(), updatedAt: new Date() },
  });

  const watchToken = issueWatchToken(userId);
  res.json({ ok: true, watchToken, expiresIn: "4h" });
});

// POST /api/portal/watch/submit-score — watchToken auth; saves hole strokes from standalone watch.
router.post("/portal/watch/submit-score", async (req: Request, res: Response) => {
  let userId: number | null = null;

  // Prefer session auth, fall back to watch token
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { tournamentId, playerId, round, holeNumber, strokes } = req.body as {
    tournamentId?: number; playerId?: number; round?: number; holeNumber?: number; strokes?: number;
  };
  if (!tournamentId || !playerId || !round || !holeNumber || strokes === undefined) {
    res.status(400).json({ error: "tournamentId, playerId, round, holeNumber, strokes required" });
    return;
  }
  if (strokes < 1 || strokes > 20) {
    res.status(400).json({ error: "strokes must be between 1 and 20" });
    return;
  }

  // Validate that this player belongs to the authenticated user AND is enrolled in the given tournament
  const [player] = await db
    .select({ id: playersTable.id, userId: playersTable.userId, tournamentId: playersTable.tournamentId })
    .from(playersTable).where(eq(playersTable.id, playerId));
  if (!player || player.userId !== userId) {
    res.status(403).json({ error: "Forbidden — player does not belong to this account" });
    return;
  }
  if (player.tournamentId !== tournamentId) {
    res.status(403).json({ error: "Forbidden — player is not enrolled in the specified tournament" });
    return;
  }

  // Card lock: prevent score edits once player has signed the card (submitted+)
  const [submission] = await db
    .select({ status: roundSubmissionsTable.status })
    .from(roundSubmissionsTable)
    .where(and(eq(roundSubmissionsTable.playerId, playerId), eq(roundSubmissionsTable.round, round)));
  if (submission && !["pending"].includes(submission.status)) {
    // Only allow changes when card is still in 'pending' (before player signs)
    res.status(409).json({ error: `Scorecard is locked (status: ${submission.status}). Scores cannot be changed after signing.` });
    return;
  }

  // Standalone watch round: when the score was entered offline on the watch,
  // honor the client's `submittedAt` timestamp (clamped to the last 12 h) so
  // marker validation re-runs against the correct play time. `isVerified` is
  // forced false so re-validation cannot be skipped.
  const submittedOffline = (req.body as { submittedOffline?: boolean }).submittedOffline === true;
  const clientSubmittedAt = (req.body as { clientSubmittedAt?: number }).clientSubmittedAt;
  const nowMs = Date.now();
  const MAX_BACKDATE_MS = 12 * 60 * 60 * 1000;
  const submittedAt = submittedOffline && typeof clientSubmittedAt === "number" && Number.isFinite(clientSubmittedAt)
    ? new Date(Math.max(nowMs - MAX_BACKDATE_MS, Math.min(nowMs, clientSubmittedAt)))
    : new Date(nowMs);
  const updatedAt = new Date(nowMs);

  await db.insert(scoresTable).values({
    tournamentId, playerId, round, holeNumber, strokes,
    isVerified: false, submittedAt, updatedAt,
  }).onConflictDoUpdate({
    target: [scoresTable.playerId, scoresTable.round, scoresTable.holeNumber],
    set: { strokes, isVerified: false, submittedAt, updatedAt },
  });

  // Update player's current hole tracking
  await db.update(playersTable)
    .set({ currentHole: holeNumber, currentRound: round })
    .where(eq(playersTable.id, playerId));

  // Broadcast live hole_score_entered SSE event so markers can follow along in real-time
  try {
    const [playerRow] = await db.select({ firstName: playersTable.firstName, lastName: playersTable.lastName })
      .from(playersTable).where(eq(playersTable.id, playerId));
    if (playerRow) {
      const scoreEvent = {
        tournamentId, playerId, round, holeNumber, strokes,
        playerName: `${playerRow.firstName} ${playerRow.lastName}`,
        occurredAt: new Date().toISOString(),
      };
      notifyHoleScoreEntered(tournamentId, scoreEvent);
      // Also notify marker live view SSE clients for this player's submission
      const [activeSubmission] = await db
        .select({ markerShareToken: roundSubmissionsTable.markerShareToken, markerShareTokenExpiresAt: roundSubmissionsTable.markerShareTokenExpiresAt })
        .from(roundSubmissionsTable)
        .where(and(eq(roundSubmissionsTable.playerId, playerId), eq(roundSubmissionsTable.round, round)));
      if (activeSubmission?.markerShareToken && activeSubmission.markerShareTokenExpiresAt && activeSubmission.markerShareTokenExpiresAt > new Date()) {
        notifyMarkerLiveScore(activeSubmission.markerShareToken, scoreEvent);
      }
    }
  } catch { /* non-fatal */ }

  res.json({ ok: true, holeNumber, strokes });
});

// POST /api/portal/watch/motion — watchToken or session auth.
// Receives a small batch of accelerometer-peak events from a paired watch
// (Apple Watch / Wear OS / Garmin) while a round is in progress. Events are
// persisted to the `watch_motion_buffer` Postgres table (durable across API
// restarts — Task #527) and drained by /portal/shots/detect at hole/round
// boundary so the auto-detect engine can fuse them with phone GPS.
router.post("/portal/watch/motion", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) userId = req.user!.id;
  else userId = getUserIdFromWatchToken(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const body = req.body as { events?: Array<{ timestamp?: number; peakG?: number }> };
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length > 500) {
    res.status(413).json({ error: "Maximum 500 events per request" });
    return;
  }
  const valid: MotionEvent[] = [];
  for (const e of events) {
    if (typeof e?.timestamp === "number" && typeof e?.peakG === "number" && Number.isFinite(e.timestamp) && Number.isFinite(e.peakG)) {
      valid.push({ timestamp: e.timestamp, peakG: e.peakG });
    }
  }
  const buffered = await bufferMotionEvents(userId, valid);
  res.json({ ok: true, accepted: valid.length, buffered });
});

// DELETE /api/portal/watch/score — watchToken or session auth; reverses the most
// recent score submission for a hole. Used by the watch's voice-undo flow when
// the recogniser misheard, and by the manual "Undo last" button.
router.delete("/portal/watch/score", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) userId = req.user!.id;
  else userId = getUserIdFromWatchToken(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const tournamentId = Number(req.query.tournamentId);
  const playerId     = Number(req.query.playerId);
  const round        = Number(req.query.round ?? 1);
  const holeNumber   = Number(req.query.holeNumber);
  if (!tournamentId || !playerId || !round || !holeNumber) {
    res.status(400).json({ error: "tournamentId, playerId, round, holeNumber required" });
    return;
  }

  const [player] = await db
    .select({ id: playersTable.id, userId: playersTable.userId, tournamentId: playersTable.tournamentId })
    .from(playersTable).where(eq(playersTable.id, playerId));
  if (!player || player.userId !== userId) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (player.tournamentId !== tournamentId) {
    res.status(403).json({ error: "Forbidden — player not in tournament" });
    return;
  }

  // Card lock — once submitted, reversal is disallowed; user must contact a marker/scorer.
  const [submission] = await db
    .select({ status: roundSubmissionsTable.status })
    .from(roundSubmissionsTable)
    .where(and(eq(roundSubmissionsTable.playerId, playerId), eq(roundSubmissionsTable.round, round)));
  if (submission && submission.status !== "pending") {
    res.status(409).json({ error: `Scorecard locked (status: ${submission.status})` });
    return;
  }

  await db.delete(scoresTable).where(and(
    eq(scoresTable.playerId, playerId),
    eq(scoresTable.round, round),
    eq(scoresTable.holeNumber, holeNumber),
  ));
  res.json({ ok: true, holeNumber, reverted: true });
});

// POST /api/portal/watch/submit-shot — watchToken auth; ingests GPS shot waypoint from watch.
// Accepts either tournamentId (tournament rounds) or generalPlayRoundId (casual play).
router.post("/portal/watch/submit-shot", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  // Task #469 — block live GPS shot ingestion when the member has withdrawn GPS consent.
  if (!await userHasConsent(userId, "gps")) {
    res.status(403).json({
      error: "GPS shot tracking is turned off in your privacy settings. Enable GPS consent to record shots.",
      code: "CONSENT_REQUIRED",
      consentRequired: { category: "gps" },
    });
    return;
  }

  const {
    tournamentId, generalPlayRoundId, playerId, round = 1,
    holeNumber, shotNumber,
    latitude, longitude, distanceToPin, distanceCarried,
    shotType,
    club, missDirection, lieType, shotShape, penaltyReason,
  } = req.body as {
    tournamentId?: number; generalPlayRoundId?: number;
    playerId?: number; round?: number;
    holeNumber?: number; shotNumber?: number;
    latitude?: number; longitude?: number;
    distanceToPin?: number; distanceCarried?: number;
    shotType?: string;
    club?: string; missDirection?: string; lieType?: string;
    shotShape?: string; penaltyReason?: string;
  };

  if (!holeNumber || !shotNumber) {
    res.status(400).json({ error: "holeNumber and shotNumber required" });
    return;
  }

  // ── General play path ──────────────────────────────────────────────
  if (generalPlayRoundId) {
    const [gpRound] = await db.select({ id: generalPlayRoundsTable.id, userId: generalPlayRoundsTable.userId })
      .from(generalPlayRoundsTable)
      .where(eq(generalPlayRoundsTable.id, generalPlayRoundId))
      .limit(1);
    if (!gpRound || gpRound.userId !== userId) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    await db.insert(shotsTable).values({
      generalPlayRoundId,
      userId,
      round,
      holeNumber,
      shotNumber,
      shotType: (shotType as typeof shotsTable.$inferInsert["shotType"]) ?? "fairway",
      club: club ?? null,
      missDirection: missDirection ?? null,
      lieType: lieType ?? null,
      shotShape: shotShape ?? null,
      penaltyReason: penaltyReason ?? null,
      latitude: latitude != null ? String(latitude) : null,
      longitude: longitude != null ? String(longitude) : null,
      distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
      distanceCarried: distanceCarried != null ? String(distanceCarried) : null,
      source: "watch",
    }).onConflictDoUpdate({
      target: [shotsTable.userId, shotsTable.generalPlayRoundId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
      targetWhere: sql`user_id IS NOT NULL AND general_play_round_id IS NOT NULL`,
      set: {
        shotType: (shotType as typeof shotsTable.$inferInsert["shotType"]) ?? "fairway",
        club: club ?? null,
        missDirection: missDirection ?? null,
        lieType: lieType ?? null,
        shotShape: shotShape ?? null,
        penaltyReason: penaltyReason ?? null,
        latitude: latitude != null ? String(latitude) : null,
        longitude: longitude != null ? String(longitude) : null,
        distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
        distanceCarried: distanceCarried != null ? String(distanceCarried) : null,
        // Re-affirm source on conflict — a previously-inserted default
        // ('manual') row should be reclassified once the watch overwrites it.
        source: "watch",
      },
    });
    res.json({ ok: true, holeNumber, shotNumber });
    return;
  }

  // ── Tournament path ────────────────────────────────────────────────
  let resolvedPlayerId = playerId;
  if (!resolvedPlayerId) {
    const [p] = await db.select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
      .from(playersTable)
      .where(eq(playersTable.userId, userId))
      .orderBy(desc(playersTable.registeredAt))
      .limit(1);
    if (!p) { { res.status(404).json({ error: "No tournament enrollment found" }); return; } }
    resolvedPlayerId = p.id;
  }

  const [player] = await db.select({ id: playersTable.id, userId: playersTable.userId, tournamentId: playersTable.tournamentId })
    .from(playersTable).where(eq(playersTable.id, resolvedPlayerId));
  if (!player || player.userId !== userId) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  if (tournamentId && player.tournamentId !== tournamentId) {
    res.status(403).json({ error: "Forbidden — player is not enrolled in the specified tournament" }); return;
  }

  const resolvedTournamentId = tournamentId ?? player.tournamentId;

  await db.insert(shotsTable).values({
    tournamentId: resolvedTournamentId,
    playerId: resolvedPlayerId,
    round,
    holeNumber,
    shotNumber,
    shotType: (shotType as typeof shotsTable.$inferInsert["shotType"]) ?? "fairway",
    club: club ?? null,
    missDirection: missDirection ?? null,
    lieType: lieType ?? null,
    shotShape: shotShape ?? null,
    penaltyReason: penaltyReason ?? null,
    latitude: latitude != null ? String(latitude) : null,
    longitude: longitude != null ? String(longitude) : null,
    distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
    distanceCarried: distanceCarried != null ? String(distanceCarried) : null,
    source: "watch",
  }).onConflictDoUpdate({
    target: [shotsTable.playerId, shotsTable.tournamentId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
    targetWhere: sql`player_id IS NOT NULL AND tournament_id IS NOT NULL`,
    set: {
      shotType: (shotType as typeof shotsTable.$inferInsert["shotType"]) ?? "fairway",
      club: club ?? null,
      missDirection: missDirection ?? null,
      lieType: lieType ?? null,
      shotShape: shotShape ?? null,
      penaltyReason: penaltyReason ?? null,
      latitude: latitude != null ? String(latitude) : null,
      longitude: longitude != null ? String(longitude) : null,
      distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
      distanceCarried: distanceCarried != null ? String(distanceCarried) : null,
      source: "watch",
    },
  });

  res.json({ ok: true, holeNumber, shotNumber });
});

// GET /api/portal/watch/hole-context — session or watchToken auth; par/yardage/GPS for current hole.
router.get("/portal/watch/hole-context", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const tournamentIdStr = req.query.tournamentId as string | undefined;
  const holeNumberStr = req.query.hole as string | undefined;
  if (!tournamentIdStr || !holeNumberStr) {
    res.status(400).json({ error: "tournamentId and hole query params required" });
    return;
  }

  const tournamentId = parseInt(tournamentIdStr, 10);
  const holeNumber = parseInt(holeNumberStr, 10);

  // Optional player position; lets the watch supply its current GPS so the
  // headwind/tailwind component is computed against the actual shot line
  // instead of a course-centre approximation. Both coords must be present
  // and finite — partial input falls back to the course centre rather than
  // mixing lat from the watch with lng from the course.
  const rawLat = req.query.lat ? parseFloat(String(req.query.lat)) : NaN;
  const rawLng = req.query.lng ? parseFloat(String(req.query.lng)) : NaN;
  const playerLatQ = Number.isFinite(rawLat) && Number.isFinite(rawLng) ? rawLat : null;
  const playerLngQ = Number.isFinite(rawLat) && Number.isFinite(rawLng) ? rawLng : null;

  // Verify the authenticated user is enrolled in the requested tournament.
  // Query by userId only — no email fallback, which could match blank-email rows under Bearer-token auth.
  const [enrollment] = await db.select({ id: playersTable.id })
    .from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.userId, userId)))
    .limit(1);
  if (!enrollment) { { res.status(403).json({ error: "Not enrolled in requested tournament" }); return; } }

  const [tournament] = await db.select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament?.courseId) { { res.status(404).json({ error: "Tournament or course not found" }); return; } }

  const [hole] = await db.select({
    holeNumber: holeDetailsTable.holeNumber,
    par: holeDetailsTable.par,
    handicap: holeDetailsTable.handicap,
    yardageBlue: holeDetailsTable.yardageBlue,
    yardageWhite: holeDetailsTable.yardageWhite,
    yardageRed: holeDetailsTable.yardageRed,
    greenCentreLat: holeDetailsTable.greenCentreLat,
    greenCentreLng: holeDetailsTable.greenCentreLng,
  })
  .from(holeDetailsTable)
  .where(and(eq(holeDetailsTable.courseId, tournament.courseId), eq(holeDetailsTable.holeNumber, holeNumber)));

  if (!hole) { { res.status(404).json({ error: "Hole not found" }); return; } }

  // Plays-like yardage from on-course weather + tee→green elevation.
  // Falls back to course centre as the tee proxy when the watch did not
  // include its GPS; computePlaysLikeForHole returns null when neither
  // wind nor elevation are available, so we omit the field cleanly.
  const [course] = await db.select({
    latitude: coursesTable.latitude,
    longitude: coursesTable.longitude,
  }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId));

  const rawYards = hole.yardageWhite ?? hole.yardageBlue ?? hole.yardageRed ?? null;
  const playsLike = await computePlaysLikeForHole({
    rawYards,
    greenLat: hole.greenCentreLat,
    greenLng: hole.greenCentreLng,
    playerLat: Number.isFinite(playerLatQ) ? playerLatQ : null,
    playerLng: Number.isFinite(playerLngQ) ? playerLngQ : null,
    courseLat: course?.latitude ?? null,
    courseLng: course?.longitude ?? null,
  });

  // Surface the wind / elevation breakdown alongside the rounded yardage so
  // the phone scorecard can render "plays X yds (+W wind / +E elev)" with the
  // same numbers the watch widget already shows. Existing `playsLikeYards`
  // shape is preserved so the watch / Wear OS clients remain backwards
  // compatible — they simply ignore the new fields.
  res.json(playsLike != null
    ? {
        ...hole,
        playsLikeYards: playsLike.playsLikeYards,
        playsLikeWindAdj: playsLike.windAdj,
        playsLikeElevAdj: playsLike.elevAdj,
        // Task #878 — bearing-to-green + wind's "from" bearing so the
        // phone scorecard can rotate a small wind arrow next to the
        // breakdown (head/cross/tail-wind at a glance).
        playsLikeBearingDeg: playsLike.bearingDeg,
        playsLikeWindDirDeg: playsLike.windDirDeg,
      }
    : hole);
});

// GET /api/portal/watch/active-context — session or watchToken auth.
//
// Convenience endpoint tailored for the Garmin Connect IQ companion (which
// has no opportunity to discover the active tournament/round/hole on its own).
// Finds the user's most recent in-progress tournament, picks the first
// unscored hole of the current round, and returns everything the watch needs
// to render distance + PlaysLike + score in a single request.
router.get("/portal/watch/active-context", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  // Optional player position (Garmin CIQ data field passes its live GPS
  // fix here so the plays-like wind component is computed against the
  // actual shot line instead of the course-centre approximation). Both
  // coords must be present and finite — partial input falls back to the
  // course centre.
  const acRawLat = req.query.lat ? parseFloat(String(req.query.lat)) : NaN;
  const acRawLng = req.query.lng ? parseFloat(String(req.query.lng)) : NaN;
  const acPlayerLat = Number.isFinite(acRawLat) && Number.isFinite(acRawLng) ? acRawLat : null;
  const acPlayerLng = Number.isFinite(acRawLat) && Number.isFinite(acRawLng) ? acRawLng : null;

  // Find most recent in-progress tournament the user is enrolled in.
  const [enrollment] = await db
    .select({
      playerId:     playersTable.id,
      tournamentId: tournamentsTable.id,
      courseId:     tournamentsTable.courseId,
      currentRound: playersTable.currentRound,
    })
    .from(playersTable)
    .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
    .where(and(eq(playersTable.userId, userId), eq(tournamentsTable.status, "active")))
    .orderBy(desc(tournamentsTable.startDate))
    .limit(1);

  if (!enrollment?.tournamentId || !enrollment.courseId) {
    res.json({ active: false });
    return;
  }

  // Use the player's tracked current round (defaults to 1 if never set).
  const round = enrollment.currentRound ?? 1;

  // Pull all hole metadata for this course up front so we can use real per-hole
  // pars when computing toPar (instead of a flat par-4 approximation).
  const courseHoles = await db.select({
    holeNumber:     holeDetailsTable.holeNumber,
    par:            holeDetailsTable.par,
    yardageWhite:   holeDetailsTable.yardageWhite,
    greenCentreLat: holeDetailsTable.greenCentreLat,
    greenCentreLng: holeDetailsTable.greenCentreLng,
  })
  .from(holeDetailsTable)
  .where(eq(holeDetailsTable.courseId, enrollment.courseId));

  const holeMap = new Map<number, typeof courseHoles[number]>();
  for (const h of courseHoles) { holeMap.set(h.holeNumber, h); }

  // Compute first unscored hole.
  const existingScores = await db
    .select({ holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(and(
      eq(scoresTable.tournamentId, enrollment.tournamentId),
      eq(scoresTable.playerId, enrollment.playerId),
      eq(scoresTable.round, round),
    ));
  const scoredMap = new Map<number, number>();
  for (const s of existingScores) { scoredMap.set(s.holeNumber, s.strokes ?? 0); }
  const unscored = Array.from({ length: 18 }, (_, i) => i + 1).filter(h => !scoredMap.has(h));
  const holeNumber = unscored.length > 0 ? Math.min(...unscored) : 18;

  const hole = holeMap.get(holeNumber) ?? null;

  // Compute toPar using the real per-hole par from courseHoles, falling back
  // to par 4 only when a hole is missing course-detail metadata.
  let totalStrokes = 0;
  let totalPar = 0;
  for (const [hn, strokes] of scoredMap) {
    totalStrokes += strokes;
    totalPar += holeMap.get(hn)?.par ?? 4;
  }
  const toPar = totalStrokes - totalPar;

  // Plays-like yardage from on-course weather + tee→green elevation. Uses
  // the (optional) Garmin-supplied lat/lng as the player's tee position so
  // the wind component reflects the actual shot line; falls back to the
  // course centre when GPS is omitted.
  const [acCourse] = enrollment.courseId
    ? await db.select({
        latitude:  coursesTable.latitude,
        longitude: coursesTable.longitude,
      }).from(coursesTable).where(eq(coursesTable.id, enrollment.courseId))
    : [null];
  const acPlaysLike = await computePlaysLikeForHole({
    rawYards:  hole?.yardageWhite ?? null,
    greenLat:  hole?.greenCentreLat ?? null,
    greenLng:  hole?.greenCentreLng ?? null,
    playerLat: acPlayerLat,
    playerLng: acPlayerLng,
    courseLat: acCourse?.latitude ?? null,
    courseLng: acCourse?.longitude ?? null,
  });

  res.json({
    active:             true,
    tournamentId:       enrollment.tournamentId,
    playerId:           enrollment.playerId,
    round,
    holeNumber,
    par:                hole?.par ?? 4,
    yardage:            hole?.yardageWhite ?? null,
    greenLat:           hole?.greenCentreLat ? parseFloat(hole.greenCentreLat) : null,
    greenLon:           hole?.greenCentreLng ? parseFloat(hole.greenCentreLng) : null,
    greenElevationFeet: null, // reserved for future PlaysLike enhancement (per-hole elevation)
    // Plays-like yardage + per-factor breakdown so the Garmin field, web
    // portal, and any other client can render the same "142y · -4 wind ·
    // +6 elev" breakdown without recomputing anything (Task #721).
    playsLikeYards:     acPlaysLike?.playsLikeYards ?? null,
    playsLikeWindAdj:   acPlaysLike?.windAdj ?? null,
    playsLikeElevAdj:   acPlaysLike?.elevAdj ?? null,
    // Task #878 — bearing-to-green + wind's "from" compass bearing so
    // the Garmin field / web portal can rotate a tiny arrow next to the
    // wind yardage. `null` when plays-like itself is unavailable so
    // existing clients keep their pre-Task-#878 rendering path.
    playsLikeBearingDeg: acPlaysLike?.bearingDeg ?? null,
    playsLikeWindDirDeg: acPlaysLike?.windDirDeg ?? null,
    holeStrokes:        scoredMap.get(holeNumber) ?? 0,
    toPar,
    holesPlayed:        scoredMap.size,
  });
});

// GET /api/portal/watch/course-cache — session or watchToken auth.
// Returns a single payload the watch can store on disk so that an entire
// standalone round (no phone) can play through with hole maps, pin positions,
// and the player's profile already in memory. Issued at the moment the round
// is created and re-issued on every successful WS reconnect.
router.get("/portal/watch/course-cache", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const tournamentIdStr = req.query.tournamentId as string | undefined;
  const roundStr = (req.query.round as string | undefined) ?? "1";
  if (!tournamentIdStr) { { res.status(400).json({ error: "tournamentId query param required" }); return; } }
  const tournamentId = parseInt(tournamentIdStr, 10);
  const round = parseInt(roundStr, 10);
  if (isNaN(tournamentId) || isNaN(round)) { { res.status(400).json({ error: "tournamentId and round must be numeric" }); return; } }

  // Verify enrollment.
  const [player] = await db.select({
    id: playersTable.id,
    firstName: playersTable.firstName,
    lastName: playersTable.lastName,
    handicapIndex: playersTable.handicapIndex,
    handicapOverride: playersTable.handicapOverride,
    teamName: playersTable.teamName,
  })
    .from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.userId, userId)))
    .limit(1);
  if (!player) { { res.status(403).json({ error: "Not enrolled in requested tournament" }); return; } }

  // Resolve courseId for this specific round (may differ from tournament default).
  const [roundRow] = await db.select({ courseId: tournamentRoundsTable.courseId })
    .from(tournamentRoundsTable)
    .where(and(eq(tournamentRoundsTable.tournamentId, tournamentId), eq(tournamentRoundsTable.roundNumber, round)))
    .limit(1);
  const [tournament] = await db.select({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    format: tournamentsTable.format,
    courseId: tournamentsTable.courseId,
  })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  const courseId = roundRow?.courseId ?? tournament.courseId;
  if (!courseId) { { res.status(404).json({ error: "Course not configured for this tournament" }); return; } }

  const [course] = await db.select({
    id: coursesTable.id,
    name: coursesTable.name,
    location: coursesTable.location,
    holes: coursesTable.holes,
    par: coursesTable.par,
    rating: coursesTable.rating,
    slope: coursesTable.slope,
    yardage: coursesTable.yardage,
  })
    .from(coursesTable).where(eq(coursesTable.id, courseId));

  const holes = await db.select({
    holeNumber: holeDetailsTable.holeNumber,
    par: holeDetailsTable.par,
    handicap: holeDetailsTable.handicap,
    yardageBlue: holeDetailsTable.yardageBlue,
    yardageWhite: holeDetailsTable.yardageWhite,
    yardageRed: holeDetailsTable.yardageRed,
    greenFrontLat: holeDetailsTable.greenFrontLat,
    greenFrontLng: holeDetailsTable.greenFrontLng,
    greenCentreLat: holeDetailsTable.greenCentreLat,
    greenCentreLng: holeDetailsTable.greenCentreLng,
    greenBackLat: holeDetailsTable.greenBackLat,
    greenBackLng: holeDetailsTable.greenBackLng,
  })
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, courseId))
    .orderBy(holeDetailsTable.holeNumber);

  res.json({
    cachedAt: new Date().toISOString(),
    tournament: {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      round,
    },
    player: {
      id: player.id,
      firstName: player.firstName,
      lastName: player.lastName,
      handicapIndex: player.handicapIndex,
      handicapOverride: player.handicapOverride,
      teamName: player.teamName,
    },
    course: course ?? { id: courseId, name: "", holes: 18, par: 72 },
    holes,
  });
});

// GET /api/portal/watch/cached-round — watchToken or session auth; returns cached tournament/player/course/holes for offline play.
router.get("/portal/watch/cached-round", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const tournamentIdStr = req.query.tournamentId as string | undefined;
  const roundStr = (req.query.round as string | undefined) ?? "1";
  if (!tournamentIdStr) { { res.status(400).json({ error: "tournamentId query param required" }); return; } }
  const tournamentId = parseInt(tournamentIdStr, 10);
  const round = parseInt(roundStr, 10);
  if (isNaN(tournamentId) || isNaN(round)) { { res.status(400).json({ error: "tournamentId and round must be numeric" }); return; } }

  // Verify enrollment.
  const [player] = await db.select({
    id: playersTable.id,
    firstName: playersTable.firstName,
    lastName: playersTable.lastName,
    handicapIndex: playersTable.handicapIndex,
    handicapOverride: playersTable.handicapOverride,
    teamName: playersTable.teamName,
  })
    .from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.userId, userId)))
    .limit(1);
  if (!player) { { res.status(403).json({ error: "Not enrolled in requested tournament" }); return; } }

  // Resolve courseId for this specific round (may differ from tournament default).
  const [roundRow] = await db.select({ courseId: tournamentRoundsTable.courseId })
    .from(tournamentRoundsTable)
    .where(and(eq(tournamentRoundsTable.tournamentId, tournamentId), eq(tournamentRoundsTable.roundNumber, round)))
    .limit(1);
  const [tournament] = await db.select({
    id: tournamentsTable.id,
    name: tournamentsTable.name,
    format: tournamentsTable.format,
    courseId: tournamentsTable.courseId,
  })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  const courseId = roundRow?.courseId ?? tournament.courseId;
  if (!courseId) { { res.status(404).json({ error: "Course not configured for this tournament" }); return; } }

  const [course] = await db.select({
    id: coursesTable.id,
    name: coursesTable.name,
    location: coursesTable.location,
    holes: coursesTable.holes,
    par: coursesTable.par,
    rating: coursesTable.rating,
    slope: coursesTable.slope,
    yardage: coursesTable.yardage,
  })
    .from(coursesTable).where(eq(coursesTable.id, courseId));

  const holes = await db.select({
    holeNumber: holeDetailsTable.holeNumber,
    par: holeDetailsTable.par,
    handicap: holeDetailsTable.handicap,
    yardageBlue: holeDetailsTable.yardageBlue,
    yardageWhite: holeDetailsTable.yardageWhite,
    yardageRed: holeDetailsTable.yardageRed,
    greenFrontLat: holeDetailsTable.greenFrontLat,
    greenFrontLng: holeDetailsTable.greenFrontLng,
    greenCentreLat: holeDetailsTable.greenCentreLat,
    greenCentreLng: holeDetailsTable.greenCentreLng,
    greenBackLat: holeDetailsTable.greenBackLat,
    greenBackLng: holeDetailsTable.greenBackLng,
  })
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, courseId))
    .orderBy(holeDetailsTable.holeNumber);

  res.json({
    cachedAt: new Date().toISOString(),
    tournament: {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      round,
    },
    player: {
      id: player.id,
      firstName: player.firstName,
      lastName: player.lastName,
      handicapIndex: player.handicapIndex,
      handicapOverride: player.handicapOverride,
      teamName: player.teamName,
    },
    course: course ?? { id: courseId, name: "", holes: 18, par: 72 },
    holes,
  });
});

// POST /api/portal/watch/sync-round — watchToken auth; infers shot types from GPS waypoints after round completion.
router.post("/portal/watch/sync-round", async (req: Request, res: Response) => {
  let userId: number | null = null;
  if (req.isAuthenticated()) {
    userId = req.user!.id;
  } else {
    userId = getUserIdFromWatchToken(req);
  }
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const { tournamentId: tIdRaw, round: roundRaw } = req.body as { tournamentId?: unknown; round?: unknown };
  const tournamentId = typeof tIdRaw === "number" ? tIdRaw : parseInt(String(tIdRaw ?? ""), 10);
  const round = typeof roundRaw === "number" ? roundRaw : parseInt(String(roundRaw ?? "1"), 10);
  if (isNaN(tournamentId) || isNaN(round)) {
    res.status(400).json({ error: "tournamentId and round are required" });
    return;
  }

  // Verify enrollment
  const [player] = await db.select({ id: playersTable.id })
    .from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId), eq(playersTable.userId, userId)))
    .limit(1);
  if (!player) { { res.status(403).json({ error: "Not enrolled in this tournament" }); return; } }

  // Resolve courseId (round override → tournament default)
  const [roundRow] = await db.select({ courseId: tournamentRoundsTable.courseId })
    .from(tournamentRoundsTable)
    .where(and(eq(tournamentRoundsTable.tournamentId, tournamentId), eq(tournamentRoundsTable.roundNumber, round)))
    .limit(1);
  const [tournament] = await db.select({ courseId: tournamentsTable.courseId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  const courseId = roundRow?.courseId ?? tournament?.courseId;
  if (!courseId) { { res.status(404).json({ error: "Course not found for this tournament" }); return; } }

  // Fetch stored watch shot waypoints for this player/round that have GPS coordinates
  const rawShots = await db.select({
    id: shotsTable.id,
    latitude: shotsTable.latitude,
    longitude: shotsTable.longitude,
    recordedAt: shotsTable.recordedAt,
  })
    .from(shotsTable)
    .where(and(
      eq(shotsTable.playerId, player.id),
      eq(shotsTable.tournamentId, tournamentId),
      eq(shotsTable.round, round),
      sql`${shotsTable.latitude} is not null`,
      sql`${shotsTable.longitude} is not null`,
    ))
    .orderBy(asc(shotsTable.recordedAt));

  if (rawShots.length === 0) {
    res.json({ ok: true, shotsInferred: 0, message: "No GPS waypoints to process" });
    return;
  }

  // Convert to GPXPoint[] for the inference pipeline
  const points = rawShots.map(s => ({
    lat: parseFloat(s.latitude!),
    lon: parseFloat(s.longitude!),
    elevation: null,
    time: s.recordedAt ? s.recordedAt.toISOString() : null,
  }));

  const context: GPXRoundContext = { playerId: player.id, tournamentId, round, courseId };
  const inferredShots = await buildShotsFromGPX(points, context);

  // Upsert inferred shot data (enrich stored rows with shotType + distanceToPin)
  let updated = 0;
  for (let i = 0; i < inferredShots.length && i < rawShots.length; i++) {
    const inferred = inferredShots[i]!;
    const raw = rawShots[i]!;
    await db.update(shotsTable)
      .set({
        holeNumber: inferred.holeNumber,
        shotNumber: inferred.shotNumber,
        shotType: inferred.shotType ?? "fairway",
        distanceToPin: inferred.distanceToPin ?? null,
      })
      .where(eq(shotsTable.id, raw.id));
    updated++;
  }

  res.json({ ok: true, shotsInferred: updated });
});

// ─── MEMBER SELF-SERVICE SUBSCRIPTION ─────────────────────────────────────────

// GET /api/portal/membership
// Returns the current player's club membership record (if any) along with
// their active subscription and tier details.
router.get("/portal/membership", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const [member] = await db.select({
    id: clubMembersTable.id,
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
    subscriptionStatus: clubMembersTable.subscriptionStatus,
    renewalDate: clubMembersTable.renewalDate,
    organizationId: clubMembersTable.organizationId,
    tierId: clubMembersTable.tierId,
    tierName: membershipTiersTable.name,
    annualFee: membershipTiersTable.annualFee,
    currency: membershipTiersTable.currency,
  })
  .from(clubMembersTable)
  .leftJoin(membershipTiersTable, eq(membershipTiersTable.id, clubMembersTable.tierId))
  .where(eq(clubMembersTable.userId, userId));

  if (!member) { { res.json(null); return; } }

  const [activeSub] = await db.select().from(memberSubscriptionsTable)
    .where(and(eq(memberSubscriptionsTable.clubMemberId, member.id)))
    .orderBy(desc(memberSubscriptionsTable.createdAt));

  res.json({ ...member, subscription: activeSub ?? null });
});

// POST /api/portal/membership/cancel-subscription
// Lets a player cancel their own active subscription (self-service).
// They must own the club member record (userId must match).
// Razorpay cancellation is attempted first; the DB is only updated on success.
// If Razorpay is unavailable (no key configured), the subscription is marked cancelled
// locally and an operator-review flag is logged for manual reconciliation.
router.post("/portal/membership/cancel-subscription", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const log = baseLogger.child({ endpoint: "portal/membership/cancel-subscription", userId });

  const [member] = await db.select({ id: clubMembersTable.id })
    .from(clubMembersTable).where(eq(clubMembersTable.userId, userId));
  if (!member) { { res.status(404).json({ error: "No club membership found for your account" }); return; } }

  const [sub] = await db.select().from(memberSubscriptionsTable)
    .where(eq(memberSubscriptionsTable.clubMemberId, member.id))
    .orderBy(desc(memberSubscriptionsTable.createdAt));

  if (!sub || ["cancelled", "expired"].includes(sub.status)) {
    res.status(400).json({ error: "No active subscription to cancel" }); return;
  }

  // Cancel in Razorpay first. Only update the local DB after success.
  if (sub.razorpaySubscriptionId) {
    try {
      await cancelRazorpaySubscription(sub.razorpaySubscriptionId, true);
      log.info({ razorpaySubId: sub.razorpaySubscriptionId }, "Razorpay subscription cancel_at_cycle_end accepted");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ razorpaySubId: sub.razorpaySubscriptionId, err: msg }, "Razorpay subscription cancellation failed — aborting local update");
      res.status(502).json({ error: "Could not cancel subscription with the payment provider. Please try again or contact support.", detail: msg });
      return;
    }
  } else {
    // No Razorpay subscription ID means the subscription was created outside Razorpay
    // (e.g. offline/manual). Log for operator review and allow local cancel.
    log.warn({ subId: sub.id, memberId: member.id }, "No razorpaySubscriptionId on subscription — cancelling locally only; operator should reconcile");
  }

  await db.update(memberSubscriptionsTable).set({
    status: "cancelled",
    cancelledAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(memberSubscriptionsTable.id, sub.id));

  await db.update(clubMembersTable).set({
    subscriptionStatus: "cancelled",
    updatedAt: new Date(),
  }).where(eq(clubMembersTable.id, member.id));

  log.info({ subId: sub.id, memberId: member.id }, "Subscription cancelled successfully");
  res.json({ ok: true, message: "Subscription cancelled. You will retain access until the end of your current billing period." });
});

// ─── GET /api/portal/membership/tiers ─────────────────────────────────────────
// Returns active membership tiers for the org the current user belongs to.
// Used by the self-subscribe flow so a player can pick a tier.
router.get("/portal/membership/tiers", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const [user] = await db.select({ organizationId: appUsersTable.organizationId })
    .from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user?.organizationId) { { res.json([]); return; } }

  const tiers = await db.select({
    id: membershipTiersTable.id,
    name: membershipTiersTable.name,
    description: membershipTiersTable.description,
    annualFee: membershipTiersTable.annualFee,
    billingPeriod: membershipTiersTable.billingPeriod,
    currency: membershipTiersTable.currency,
    gracePeriodDays: membershipTiersTable.gracePeriodDays,
    razorpayPlanId: membershipTiersTable.razorpayPlanId,
  })
  .from(membershipTiersTable)
  .where(and(
    eq(membershipTiersTable.organizationId, user.organizationId),
    eq(membershipTiersTable.isActive, true),
  ))
  .orderBy(asc(membershipTiersTable.name));

  res.json(tiers);
});

// ─── POST /api/portal/membership/subscribe ─────────────────────────────────────
// Self-service subscription: a player selects a tier and creates a Razorpay
// subscription (if the tier has a razorpayPlanId), or a pending manual subscription.
router.post("/portal/membership/subscribe", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const log = baseLogger.child({ endpoint: "portal/membership/subscribe", userId });

  const { tierId } = req.body as { tierId?: number };
  if (!tierId) { { res.status(400).json({ error: "tierId is required" }); return; } }

  const [user] = await db.select({
    organizationId: appUsersTable.organizationId,
    email: appUsersTable.email,
    displayName: appUsersTable.displayName,
  }).from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user?.organizationId) { { res.status(400).json({ error: "Your account is not linked to an organization" }); return; } }

  // Verify the tier belongs to the user's org
  const [tier] = await db.select().from(membershipTiersTable)
    .where(and(
      eq(membershipTiersTable.id, tierId),
      eq(membershipTiersTable.organizationId, user.organizationId),
      eq(membershipTiersTable.isActive, true),
    ));
  if (!tier) { { res.status(404).json({ error: "Membership tier not found" }); return; } }

  // Check if the user already has an active club member record
  const [existing] = await db.select().from(clubMembersTable)
    .where(and(eq(clubMembersTable.userId, userId), eq(clubMembersTable.organizationId, user.organizationId)));

  let member = existing;
  if (!member) {
    const nameParts = (user.displayName ?? "").split(" ");
    const [newMember] = await db.insert(clubMembersTable).values({
      organizationId: user.organizationId,
      tierId,
      userId,
      firstName: nameParts[0] ?? "Member",
      lastName: nameParts.slice(1).join(" ") || "-",
      email: user.email ?? undefined,
      joinDate: new Date(),
      subscriptionStatus: "pending",
    }).returning();
    member = newMember;
  } else {
    // Update tier if member exists with a different tier
    await db.update(clubMembersTable).set({ tierId, updatedAt: new Date() })
      .where(eq(clubMembersTable.id, member.id));
  }

  let razorpaySubId: string | null = null;
  let subscribeUrl: string | null = null;

  if (tier.razorpayPlanId) {
    try {
      const razorpay = getRazorpayClient();
      const sub = await (razorpay as unknown as {
        subscriptions: { create: (o: Record<string, unknown>) => Promise<{ id: string; short_url?: string }> };
      }).subscriptions.create({
        plan_id: tier.razorpayPlanId,
        quantity: 1,
        // monthly plans: 12 billing cycles per year; annual plans: 5-year horizon
        total_count: (tier.billingPeriod ?? "annual") === "monthly" ? 12 : 5,
        notes: { clubMemberId: String(member.id), userId: String(userId), tierId: String(tierId) },
        notify_info: { notify_email: user.email ?? undefined },
      });
      razorpaySubId = sub.id;
      subscribeUrl = sub.short_url ?? null;
      log.info({ razorpaySubId, tierId }, "Razorpay subscription created for self-subscribe");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg, tierId }, "Failed to create Razorpay subscription — creating pending record");
    }
  }

  // Insert the subscription record
  const [newSub] = await db.insert(memberSubscriptionsTable).values({
    clubMemberId: member.id,
    organizationId: user.organizationId,
    tierId,
    razorpaySubscriptionId: razorpaySubId,
    razorpayPlanId: tier.razorpayPlanId ?? null,
    status: razorpaySubId ? "pending" : "pending",
    nextBillingDate: null,
  }).returning();

  if (razorpaySubId) {
    await db.update(clubMembersTable).set({ subscriptionStatus: "pending", updatedAt: new Date() })
      .where(eq(clubMembersTable.id, member.id));
  }

  res.json({
    ok: true,
    memberId: member.id,
    subscriptionId: newSub.id,
    razorpaySubscriptionId: razorpaySubId,
    subscribeUrl,
    message: razorpaySubId
      ? "Subscription created. Complete payment via the provided URL to activate."
      : "Subscription request recorded. An admin will activate your membership.",
  });
});

// ─── GET /api/portal/membership/directory ─────────────────────────────────────
// Returns the public member directory for the org — only members who opted in
// (showInDirectory = true) with active/pending subscriptions are shown.
router.get("/portal/membership/directory", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const [user] = await db.select({ organizationId: appUsersTable.organizationId })
    .from(appUsersTable).where(eq(appUsersTable.id, userId));
  if (!user?.organizationId) { { res.json([]); return; } }

  const members = await db.select({
    id: clubMembersTable.id,
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
    handicapIndex: clubMembersTable.handicapIndex,
    joinDate: clubMembersTable.joinDate,
    subscriptionStatus: clubMembersTable.subscriptionStatus,
    tierName: membershipTiersTable.name,
  })
  .from(clubMembersTable)
  .leftJoin(membershipTiersTable, eq(membershipTiersTable.id, clubMembersTable.tierId))
  .where(and(
    eq(clubMembersTable.organizationId, user.organizationId),
    eq(clubMembersTable.showInDirectory, true),
    sql`${clubMembersTable.subscriptionStatus} IN ('active', 'pending', 'past_due')`,
  ))
  .orderBy(clubMembersTable.lastName, clubMembersTable.firstName);

  res.json(members);
});

// ─── PATCH /api/portal/membership/directory-opt-in ────────────────────────────
// Lets the current member toggle their own directory visibility.
router.patch("/portal/membership/directory-opt-in", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const { showInDirectory } = req.body as { showInDirectory?: boolean };
  if (typeof showInDirectory !== "boolean") { { res.status(400).json({ error: "showInDirectory (boolean) is required" }); return; } }

  const [member] = await db.select({ id: clubMembersTable.id })
    .from(clubMembersTable).where(eq(clubMembersTable.userId, userId));
  if (!member) { { res.status(404).json({ error: "No club membership found for your account" }); return; } }

  await db.update(clubMembersTable)
    .set({ showInDirectory, updatedAt: new Date() })
    .where(eq(clubMembersTable.id, member.id));

  res.json({ ok: true, showInDirectory });
});

// ─── GET /api/portal/membership/card ──────────────────────────────────────────
// Generates and streams a PNG digital membership card for the current player.
router.get("/portal/membership/card", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const [member] = await db.select({
    id: clubMembersTable.id,
    firstName: clubMembersTable.firstName,
    lastName: clubMembersTable.lastName,
    memberNumber: clubMembersTable.memberNumber,
    subscriptionStatus: clubMembersTable.subscriptionStatus,
    renewalDate: clubMembersTable.renewalDate,
    tierId: clubMembersTable.tierId,
    organizationId: clubMembersTable.organizationId,
    tierName: membershipTiersTable.name,
  })
  .from(clubMembersTable)
  .leftJoin(membershipTiersTable, eq(membershipTiersTable.id, clubMembersTable.tierId))
  .where(eq(clubMembersTable.userId, userId));

  if (!member) { { res.status(404).json({ error: "No club membership found for your account" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable).where(eq(organizationsTable.id, member.organizationId));

  // Task #1758 — when the club has saved a custom theme via the
  // club-theming UI, prefer that logo / primary colour for the player's
  // own membership card. Falls back to the legacy `organizations.*`
  // columns and then to the KHARAGOLF defaults below.
  const branded = await resolveOrgBranding(member.organizationId, org);

  const { Resvg } = await import("@resvg/resvg-js");

  // Credit-card proportions at 3× scale: 856 × 540 px
  const W = 856;
  const H = 540;

  // Fetch org logo and base64-encode it for SVG embedding (best-effort)
  let logoDataUri = "";
  if (branded.logoUrl) {
    try {
      const logoRes = await fetch(branded.logoUrl);
      if (logoRes.ok) {
        const buf = await logoRes.arrayBuffer();
        const ct = logoRes.headers.get("content-type") ?? "image/png";
        logoDataUri = `data:${ct};base64,${Buffer.from(buf).toString("base64")}`;
      }
    } catch {
      // Logo fetch failed — omit logo from card
    }
  }

  const accentColor = branded.primaryColor ?? "#22c55e";
  const accentColorSafe = /^#[0-9a-fA-F]{3,6}$/.test(accentColor) ? accentColor : "#22c55e";

  const orgName = (org?.name ?? "KHARAGOLF").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const memberName = `${member.firstName} ${member.lastName}`.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
  const tierLabel = (member.tierName ?? "Member").toUpperCase();
  const memberNo = member.memberNumber ? `Member #${member.memberNumber}` : "";
  const statusColor = member.subscriptionStatus === "active" ? "#22c55e"
    : member.subscriptionStatus === "past_due" ? "#f59e0b" : "#6b7280";
  const statusLabel = (member.subscriptionStatus ?? "").replace(/_/g, " ").toUpperCase();
  const renewalStr = member.renewalDate
    ? `Valid until ${new Date(member.renewalDate).toLocaleDateString("en-IN", { year: "numeric", month: "short" })}`
    : "";
  const issueStr = `Issued ${new Date().toLocaleDateString("en-IN", { year: "numeric", month: "short" })}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#0a1628"/>
        <stop offset="100%" stop-color="#111827"/>
      </linearGradient>
    </defs>
    <!-- Background -->
    <rect width="${W}" height="${H}" fill="url(#bg)" rx="18"/>
    <!-- Accent stripe -->
    <rect x="0" y="0" width="16" height="${H}" fill="${accentColorSafe}" rx="18"/>
    <rect x="0" y="18" width="16" height="${H - 36}" fill="${accentColorSafe}"/>
    <!-- Glow circle -->
    <circle cx="${W - 90}" cy="110" r="180" fill="${accentColorSafe}" fill-opacity="0.06"/>
    <!-- Org logo (if available) -->
    ${logoDataUri ? `<image href="${logoDataUri}" x="${W - 156}" y="24" width="120" height="52" preserveAspectRatio="xMidYMid meet"/>` : ""}
    <!-- Org name -->
    <text x="46" y="74" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="bold" fill="${accentColorSafe}">${orgName}</text>
    <!-- Tier badge -->
    ${!logoDataUri ? `<text x="${W - 30}" y="56" font-family="Arial,Helvetica,sans-serif" font-size="22" fill="${accentColorSafe}" text-anchor="end">${tierLabel}</text>` : `<text x="${W - 30}" y="${H / 2 - 20}" font-family="Arial,Helvetica,sans-serif" font-size="22" fill="${accentColorSafe}" text-anchor="end">${tierLabel}</text>`}
    <!-- Member name -->
    <text x="46" y="230" font-family="Arial,Helvetica,sans-serif" font-size="62" font-weight="bold" fill="#ffffff">${memberName}</text>
    <!-- Member number -->
    ${memberNo ? `<text x="46" y="296" font-family="Arial,Helvetica,sans-serif" font-size="28" fill="#9ca3af">${memberNo}</text>` : ""}
    <!-- Status -->
    <rect x="44" y="320" width="${statusLabel.length * 14 + 24}" height="36" fill="${statusColor}" fill-opacity="0.15" rx="8"/>
    <text x="56" y="344" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="bold" fill="${statusColor}">${statusLabel}</text>
    <!-- Validity -->
    ${renewalStr ? `<text x="46" y="${H - 56}" font-family="Arial,Helvetica,sans-serif" font-size="24" fill="#6b7280">${renewalStr}</text>` : ""}
    <!-- Issue date -->
    <text x="${W - 30}" y="${H - 28}" font-family="Arial,Helvetica,sans-serif" font-size="20" fill="#374151" text-anchor="end">${issueStr}</text>
  </svg>`;

  const resvg = new Resvg(svg, { font: { loadSystemFonts: false } });
  const pngData = resvg.render();
  const pngBuffer = pngData.asPng();

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Disposition", `attachment; filename="membership-card.png"`);
  res.send(pngBuffer);
});

// ─── GET /api/portal/ghin ─────────────────────────────────────────────────────
// Returns the GHIN number from the player's most recent tournament registration.
router.get("/portal/ghin", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  // Find the most recent player record linked to this user
  const [player] = await db
    .select({ id: playersTable.id, ghinNumber: playersTable.ghinNumber })
    .from(playersTable)
    .where(eq(playersTable.userId, userId))
    .orderBy(sql`${playersTable.id} DESC`)
    .limit(1);

  res.json({ ghinNumber: player?.ghinNumber ?? null });
});

// ─── PATCH /api/portal/ghin ───────────────────────────────────────────────────
// Updates the GHIN number on all of the player's tournament registrations.
router.patch("/portal/ghin", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const { ghinNumber } = req.body as { ghinNumber?: string };

  const cleaned = ghinNumber ? String(ghinNumber).trim() : null;

  await db
    .update(playersTable)
    .set({ ghinNumber: cleaned })
    .where(eq(playersTable.userId, userId));

  // Also update clubMembersTable if a member record exists
  await db
    .update(clubMembersTable)
    .set({ whsGhinNumber: cleaned })
    .where(eq(clubMembersTable.userId, userId));

  res.json({ ghinNumber: cleaned });
});

// POST /api/portal/tournament-player/:playerId/scorecard/share
// Generate (or retrieve) a share token for the player's scorecard.
router.post("/portal/tournament-player/:playerId/scorecard/share", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  if (isNaN(playerId)) { { res.status(400).json({ error: "Invalid player ID" }); return; } }

  const [player] = await db
    .select({ id: playersTable.id, userId: playersTable.userId, shareToken: playersTable.shareToken })
    .from(playersTable).where(eq(playersTable.id, playerId));
  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }
  if (player.userId !== (req.user as { id: number }).id) { { res.status(403).json({ error: "Forbidden" }); return; } }

  let token = player.shareToken;
  if (!token) {
    const { randomBytes } = await import("crypto");
    token = randomBytes(24).toString("hex");
    await db.update(playersTable).set({ shareToken: token }).where(eq(playersTable.id, playerId));
  }

  const baseUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "https://kharagolf.replit.app";
  res.json({ shareUrl: `${baseUrl}/scorecard/${token}`, shareToken: token });
});

/* ─── Handicap Simulator ────────────────────────────────────────────────────── */

// GET /api/portal/handicap/simulate
// Query params: handicapIndex, courseRating, courseSlope, coursePar, handicapAllowance, grossScore
// Returns: input, result (courseHandicap, playingHandicap, netScore, netToPar, projectedHandicapIndex), simulations[]
router.get("/portal/handicap/simulate", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const handicapIndex = parseFloat(String(req.query.handicapIndex ?? "0"));
  const courseRating = parseFloat(String(req.query.courseRating ?? "72"));
  // Accept both courseSlope (canonical) and slope (alias)
  const courseSlope = parseFloat(String(req.query.courseSlope ?? req.query.slope ?? "113"));
  // Accept both coursePar (canonical) and par (alias)
  const coursePar = parseInt(String(req.query.coursePar ?? req.query.par ?? "72"));
  // Accept both handicapAllowance (canonical) and allowancePct (alias)
  const handicapAllowance = parseInt(String(req.query.handicapAllowance ?? req.query.allowancePct ?? "100"));
  const grossScore = parseInt(String(req.query.grossScore ?? "0"));

  if (isNaN(handicapIndex) || isNaN(courseRating) || isNaN(courseSlope) || isNaN(coursePar)) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }

  // WHS Course Handicap = HI × (Slope ÷ 113) + (CR − Par)
  const courseHandicap = handicapIndex * (courseSlope / 113) + (courseRating - coursePar);
  const playingHandicap = Math.round(courseHandicap * (handicapAllowance / 100));
  const netScore = grossScore > 0 ? grossScore - playingHandicap : null;
  const netToPar = netScore !== null ? netScore - coursePar : null;
  const grossToPar = grossScore > 0 ? grossScore - coursePar : null;

  // WHS Score Differential = (113 / Slope) × (Gross Score − CR − PCC)
  // PCC (Playing Conditions Calculation) defaults to 0
  let projectedHandicapIndex: number | null = null;
  let differential: number | null = null;
  if (grossScore > 0) {
    const scoreDiff = (113 / courseSlope) * (grossScore - courseRating);
    differential = Math.round(scoreDiff * 10) / 10;
    // Projected HI = 0.96 × (best 8 of 20 diffs); approximate with single round
    projectedHandicapIndex = Math.round(scoreDiff * 0.96 * 10) / 10;
    if (projectedHandicapIndex < 0) projectedHandicapIndex = 0;
    if (projectedHandicapIndex > 54) projectedHandicapIndex = 54;
  }

  // Flat summary fields for easy client consumption
  const netPar = coursePar - playingHandicap;
  const parDiff = netPar - coursePar;

  // Simulate across a range of HIs for the chart
  const simulations = Array.from({ length: 37 }, (_, i) => {
    const hi = (i - 4) * 0.5 + Math.round(handicapIndex * 2) / 2 - 9;
    const ch = hi * (courseSlope / 113) + (courseRating - coursePar);
    const ph = Math.round(ch * (handicapAllowance / 100));
    return { handicapIndex: Math.round(hi * 10) / 10, courseHandicap: Math.round(ch * 10) / 10, playingHandicap: ph };
  }).filter(s => s.handicapIndex >= 0 && s.handicapIndex <= 54);

  res.json({
    input: { handicapIndex, courseRating, courseSlope, coursePar, handicapAllowance, grossScore: grossScore || null },
    result: {
      courseHandicap: Math.round(courseHandicap * 10) / 10,
      playingHandicap,
      netScore,
      netToPar,
      grossToPar,
      differential,
      projectedHandicapIndex,
      // Flat aliases for simple clients
      netPar,
      parDiff,
    },
    simulations,
    // Top-level flat aliases for clients that don't unpack result
    courseHandicap: Math.round(courseHandicap * 10) / 10,
    playingHandicap,
    netPar,
    parDiff,
    differential,
    projectedHandicapIndex,
  });
});

// ─── ROUND REPLAY SHOTS (portal) ─────────────────────────────────────────────

// GET /api/portal/rounds/:round/shots?tournamentId=X or ?generalPlayRoundId=Y
// Returns shots for the authenticated user in a given round.
router.get("/portal/rounds/:round/shots", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const round = parseInt(String((req.params as Record<string, string>).round));
  if (isNaN(round)) { { res.status(400).json({ error: "Invalid round" }); return; } }

  const generalPlayRoundId = req.query.generalPlayRoundId ? parseInt(req.query.generalPlayRoundId as string) : null;
  const tournamentId = req.query.tournamentId ? parseInt(req.query.tournamentId as string) : null;

  if (!generalPlayRoundId && !tournamentId) {
    res.status(400).json({ error: "tournamentId or generalPlayRoundId required" }); return;
  }

  let shots: (typeof shotsTable.$inferSelect)[];

  if (generalPlayRoundId) {
    const [gpRound] = await db.select({ id: generalPlayRoundsTable.id, userId: generalPlayRoundsTable.userId })
      .from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId)).limit(1);
    if (!gpRound || gpRound.userId !== userId) { { res.json([]); return; } }

    shots = await db.select().from(shotsTable)
      .where(and(eq(shotsTable.userId, userId), eq(shotsTable.generalPlayRoundId, generalPlayRoundId), eq(shotsTable.round, round)))
      .orderBy(asc(shotsTable.holeNumber), asc(shotsTable.shotNumber));
  } else {
    const [playerRow] = await db.select({ id: playersTable.id }).from(playersTable)
      .where(and(eq(playersTable.userId, userId), eq(playersTable.tournamentId, tournamentId!)))
      .limit(1);
    if (!playerRow) { { res.json([]); return; } }

    shots = await db.select().from(shotsTable)
      .where(and(eq(shotsTable.playerId, playerRow.id), eq(shotsTable.round, round)))
      .orderBy(asc(shotsTable.holeNumber), asc(shotsTable.shotNumber));
  }

  const byHole: Record<number, typeof shots> = {};
  for (const s of shots) {
    const h = s.holeNumber ?? 0;
    if (!byHole[h]) byHole[h] = [];
    byHole[h].push(s);
  }

  res.json(Object.entries(byHole).sort(([a], [b]) => parseInt(a) - parseInt(b)).map(([hole, hShots]) => ({ hole: parseInt(hole), shots: hShots })));
});

// GET /api/portal/rounds/:round/source-breakdown?tournamentId=X or ?generalPlayRoundId=Y
// Task #709 — counts how many shots in the given round came from each source
// (watch / phone / scorer / manual). Lets the round summary show a small "78%
// watch / 18% phone / 4% manual" badge so the player can gauge how reliable
// their tracking was, and we can surface high-manual rounds as a data-quality
// flag in tournament admin.
router.get("/portal/rounds/:round/source-breakdown", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const round = parseInt(String((req.params as Record<string, string>).round));
  if (isNaN(round)) { { res.status(400).json({ error: "Invalid round" }); return; } }

  const generalPlayRoundId = req.query.generalPlayRoundId ? parseInt(req.query.generalPlayRoundId as string) : null;
  const tournamentId = req.query.tournamentId ? parseInt(req.query.tournamentId as string) : null;
  if (!generalPlayRoundId && !tournamentId) {
    res.status(400).json({ error: "tournamentId or generalPlayRoundId required" }); return;
  }

  let whereClause;
  if (generalPlayRoundId) {
    const [gpRound] = await db.select({ id: generalPlayRoundsTable.id, userId: generalPlayRoundsTable.userId })
      .from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId)).limit(1);
    if (!gpRound || gpRound.userId !== userId) {
      res.json({ counts: { watch: 0, phone: 0, manual: 0, scorer: 0 }, total: 0 }); return;
    }
    whereClause = and(eq(shotsTable.userId, userId), eq(shotsTable.generalPlayRoundId, generalPlayRoundId), eq(shotsTable.round, round));
  } else {
    const [playerRow] = await db.select({ id: playersTable.id }).from(playersTable)
      .where(and(eq(playersTable.userId, userId), eq(playersTable.tournamentId, tournamentId!)))
      .limit(1);
    if (!playerRow) {
      res.json({ counts: { watch: 0, phone: 0, manual: 0, scorer: 0 }, total: 0 }); return;
    }
    whereClause = and(eq(shotsTable.playerId, playerRow.id), eq(shotsTable.round, round));
  }

  const rows = await db.select({ source: shotsTable.source, n: count(shotsTable.id) })
    .from(shotsTable).where(whereClause).groupBy(shotsTable.source);

  const counts = { watch: 0, phone: 0, manual: 0, scorer: 0 } as Record<"watch"|"phone"|"manual"|"scorer", number>;
  let total = 0;
  for (const r of rows) {
    const src = (r.source ?? "manual") as keyof typeof counts;
    const n = Number(r.n);
    if (src in counts) counts[src] = n;
    total += n;
  }
  res.json({ counts, total });
});

// ─── SHOT EDIT / DELETE / MANUAL ADD ────────────────────────────────────────

/** Verify the authenticated user owns the given shot row. Returns the row or null. */
async function loadOwnedShot(shotId: number, userId: number): Promise<typeof shotsTable.$inferSelect | null> {
  const [row] = await db.select().from(shotsTable).where(eq(shotsTable.id, shotId)).limit(1);
  if (!row) return null;
  if (row.userId === userId) return row;
  if (row.playerId !== null) {
    const [p] = await db.select({ userId: playersTable.userId }).from(playersTable).where(eq(playersTable.id, row.playerId)).limit(1);
    if (p?.userId === userId) return row;
  }
  return null;
}

// Allowed shot_type enum values (mirrors shotTypeEnum in lib/db/schema/golf.ts).
// Used by PATCH and POST /portal/shots routes to reject malformed shotType
// payloads before they corrupt SG/category analytics.
const ALLOWED_SHOT_TYPES = new Set([
  "tee", "fairway", "approach", "chip", "sand", "putt", "penalty", "recovery",
]);

// PATCH /api/portal/shots/:id — edit fields of an existing shot.
router.patch("/portal/shots/:id", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const id = parseInt(String((req.params as Record<string, string>).id), 10);
  if (isNaN(id)) { { res.status(400).json({ error: "Invalid shot id" }); return; } }
  const owned = await loadOwnedShot(id, userId);
  if (!owned) { { res.status(404).json({ error: "Shot not found" }); return; } }

  const b = req.body as Record<string, unknown>;
  const set: Partial<typeof shotsTable.$inferInsert> = {};
  if (typeof b.shotType === "string") {
    if (!ALLOWED_SHOT_TYPES.has(b.shotType)) {
      res.status(400).json({ error: `Invalid shotType. Allowed: ${[...ALLOWED_SHOT_TYPES].join(", ")}` });
      return;
    }
    set.shotType = b.shotType as typeof shotsTable.$inferInsert["shotType"];
  }
  if (typeof b.club === "string" || b.club === null) set.club = b.club as string | null;
  if (typeof b.lieType === "string" || b.lieType === null) set.lieType = b.lieType as string | null;
  if (typeof b.missDirection === "string" || b.missDirection === null) set.missDirection = b.missDirection as string | null;
  if (typeof b.shotShape === "string" || b.shotShape === null) set.shotShape = b.shotShape as string | null;
  if (typeof b.penaltyReason === "string" || b.penaltyReason === null) set.penaltyReason = b.penaltyReason as string | null;
  if (typeof b.distanceToPin === "number") set.distanceToPin = String(b.distanceToPin);
  if (typeof b.distanceCarried === "number") set.distanceCarried = String(b.distanceCarried);
  if (typeof b.latitude === "number") set.latitude = String(b.latitude);
  if (typeof b.longitude === "number") set.longitude = String(b.longitude);
  if (typeof b.holeNumber === "number") set.holeNumber = b.holeNumber;
  if (typeof b.shotNumber === "number") set.shotNumber = b.shotNumber;

  if (Object.keys(set).length === 0) { { res.status(400).json({ error: "No editable fields supplied" }); return; } }

  const [updated] = await db.update(shotsTable).set(set).where(eq(shotsTable.id, id)).returning();
  res.json({ ok: true, shot: updated });
});

// DELETE /api/portal/shots/:id — remove a shot and resequence later shots in the same hole.
// Returns the full deleted row as `deletedShot` so the client can offer an
// Undo affordance that re-creates it via POST /portal/shots/restore (Task #1009).
router.delete("/portal/shots/:id", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const id = parseInt(String((req.params as Record<string, string>).id), 10);
  if (isNaN(id)) { { res.status(400).json({ error: "Invalid shot id" }); return; } }
  const owned = await loadOwnedShot(id, userId);
  if (!owned) { { res.status(404).json({ error: "Shot not found" }); return; } }

  await db.delete(shotsTable).where(eq(shotsTable.id, id));

  // Resequence remaining shots on this hole so shotNumber stays contiguous (1..N).
  const conds = [eq(shotsTable.round, owned.round), eq(shotsTable.holeNumber, owned.holeNumber)];
  if (owned.playerId !== null && owned.tournamentId !== null) {
    conds.push(eq(shotsTable.playerId, owned.playerId), eq(shotsTable.tournamentId, owned.tournamentId));
  } else if (owned.userId !== null && owned.generalPlayRoundId !== null) {
    conds.push(eq(shotsTable.userId, owned.userId), eq(shotsTable.generalPlayRoundId, owned.generalPlayRoundId));
  }
  const remaining = await db.select({ id: shotsTable.id }).from(shotsTable).where(and(...conds)).orderBy(asc(shotsTable.shotNumber));
  for (let i = 0; i < remaining.length; i++) {
    await db.update(shotsTable).set({ shotNumber: i + 1 }).where(eq(shotsTable.id, remaining[i].id));
  }
  res.json({ ok: true, deletedId: id, resequenced: remaining.length, deletedShot: owned });
});

// POST /api/portal/shots/restore — recreate a previously-deleted shot from the
// snapshot returned by DELETE /portal/shots/:id (Task #1009). Inserts the
// shot at its original shotNumber, shifting any later shots in the same
// (round, hole) group up by 1 to keep the sequence contiguous. Returns the
// freshly-inserted row (with a NEW id) so the client can update its state.
router.post("/portal/shots/restore", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const snap = req.body as Partial<typeof shotsTable.$inferSelect> & {
    tournamentId?: number | null;
    generalPlayRoundId?: number | null;
    playerId?: number | null;
    userId?: number | null;
  };
  if (typeof snap.holeNumber !== "number" || typeof snap.shotNumber !== "number") {
    res.status(400).json({ error: "holeNumber and shotNumber required" }); return;
  }
  // Validate enum payloads — the snapshot normally comes back from the
  // server's DELETE response but a malicious client could POST anything.
  if (snap.shotType != null && !ALLOWED_SHOT_TYPES.has(snap.shotType as string)) {
    res.status(400).json({ error: `Invalid shotType. Allowed: ${[...ALLOWED_SHOT_TYPES].join(", ")}` });
    return;
  }
  const ALLOWED_SOURCES = new Set(["watch", "manual", "scorecard"]);
  if (snap.source != null && !ALLOWED_SOURCES.has(snap.source as string)) {
    res.status(400).json({ error: "Invalid source" }); return;
  }
  const round = typeof snap.round === "number" ? snap.round : 1;

  // Verify ownership of the (player|user) the snapshot is pinned to.
  const insert: typeof shotsTable.$inferInsert = {
    round,
    holeNumber: snap.holeNumber,
    shotNumber: snap.shotNumber,
    shotType: (snap.shotType as typeof shotsTable.$inferInsert["shotType"]) ?? "fairway",
    club: snap.club ?? null,
    lieType: snap.lieType ?? null,
    missDirection: snap.missDirection ?? null,
    shotShape: snap.shotShape ?? null,
    penaltyReason: snap.penaltyReason ?? null,
    latitude: snap.latitude == null ? null : String(snap.latitude),
    longitude: snap.longitude == null ? null : String(snap.longitude),
    distanceToPin: snap.distanceToPin == null ? null : String(snap.distanceToPin),
    distanceCarried: snap.distanceCarried == null ? null : String(snap.distanceCarried),
    source: (snap.source as typeof shotsTable.$inferInsert["source"]) ?? "manual",
  };

  const conds = [eq(shotsTable.round, round), eq(shotsTable.holeNumber, snap.holeNumber)];
  if (snap.generalPlayRoundId) {
    const [gp] = await db.select({ userId: generalPlayRoundsTable.userId }).from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, snap.generalPlayRoundId)).limit(1);
    if (!gp || gp.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }
    insert.generalPlayRoundId = snap.generalPlayRoundId;
    insert.userId = userId;
    conds.push(eq(shotsTable.generalPlayRoundId, snap.generalPlayRoundId), eq(shotsTable.userId, userId));
  } else if (snap.tournamentId) {
    const [p] = await db.select({ id: playersTable.id }).from(playersTable)
      .where(and(eq(playersTable.userId, userId), eq(playersTable.tournamentId, snap.tournamentId))).limit(1);
    if (!p) { { res.status(403).json({ error: "Not enrolled in this tournament" }); return; } }
    insert.tournamentId = snap.tournamentId;
    insert.playerId = p.id;
    conds.push(eq(shotsTable.tournamentId, snap.tournamentId), eq(shotsTable.playerId, p.id));
  } else {
    res.status(400).json({ error: "tournamentId or generalPlayRoundId required" }); return;
  }

  // Shift any existing shots whose shotNumber is >= the snapshot's shotNumber
  // up by 1 to make room. Update from highest down so the unique index on
  // (..., shotNumber) never sees a transient collision.
  const later = await db.select({ id: shotsTable.id, shotNumber: shotsTable.shotNumber })
    .from(shotsTable)
    .where(and(...conds, sql`${shotsTable.shotNumber} >= ${snap.shotNumber}`))
    .orderBy(desc(shotsTable.shotNumber));
  for (const r of later) {
    await db.update(shotsTable).set({ shotNumber: r.shotNumber + 1 }).where(eq(shotsTable.id, r.id));
  }

  const [row] = await db.insert(shotsTable).values(insert).returning();
  res.json({ ok: true, shot: row });
});

// POST /api/portal/shots/manual — add a single shot manually (mobile shot-review UI).
// Accepts the same body shape as /portal/watch/submit-shot but without a watchToken.
router.post("/portal/shots/manual", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  // Task #469 — manual shot entry persists GPS coordinates; gate on GPS consent.
  if (!await requireConsent(req, res, "gps")) return;
  const b = req.body as {
    tournamentId?: number; generalPlayRoundId?: number; round?: number;
    holeNumber: number; shotNumber: number; shotType?: string;
    club?: string; lieType?: string; missDirection?: string;
    distanceToPin?: number; distanceCarried?: number;
    latitude?: number; longitude?: number;
  };
  if (!b.holeNumber || !b.shotNumber) { { res.status(400).json({ error: "holeNumber and shotNumber required" }); return; } }
  if (b.shotType !== undefined && !ALLOWED_SHOT_TYPES.has(b.shotType)) {
    res.status(400).json({ error: `Invalid shotType. Allowed: ${[...ALLOWED_SHOT_TYPES].join(", ")}` });
    return;
  }
  const round = b.round ?? 1;

  const insert: typeof shotsTable.$inferInsert = {
    round, holeNumber: b.holeNumber, shotNumber: b.shotNumber,
    shotType: (b.shotType as typeof shotsTable.$inferInsert["shotType"]) ?? "fairway",
    club: b.club ?? null, lieType: b.lieType ?? null, missDirection: b.missDirection ?? null,
    distanceToPin: b.distanceToPin != null ? String(b.distanceToPin) : null,
    distanceCarried: b.distanceCarried != null ? String(b.distanceCarried) : null,
    latitude: b.latitude != null ? String(b.latitude) : null,
    longitude: b.longitude != null ? String(b.longitude) : null,
    source: "manual",
  };

  if (b.generalPlayRoundId) {
    const [gp] = await db.select({ userId: generalPlayRoundsTable.userId }).from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, b.generalPlayRoundId)).limit(1);
    if (!gp || gp.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }
    insert.generalPlayRoundId = b.generalPlayRoundId;
    insert.userId = userId;
  } else if (b.tournamentId) {
    const [p] = await db.select({ id: playersTable.id }).from(playersTable)
      .where(and(eq(playersTable.userId, userId), eq(playersTable.tournamentId, b.tournamentId))).limit(1);
    if (!p) { { res.status(403).json({ error: "Not enrolled in this tournament" }); return; } }
    insert.tournamentId = b.tournamentId;
    insert.playerId = p.id;
  } else {
    res.status(400).json({ error: "tournamentId or generalPlayRoundId required" }); return;
  }

  const [row] = await db.insert(shotsTable).values(insert).returning();
  res.json({ ok: true, shot: row });
});

// POST /api/portal/shots/detect — fuse phone GPS samples + watch motion peaks into proposed shots.
// If `commit: true`, also persists the detected shots; otherwise returns them for user review.
router.post("/portal/shots/detect", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  // Task #469 — shot detection ingests raw GPS sample streams; gate on GPS consent.
  if (!await requireConsent(req, res, "gps")) return;
  const b = req.body as {
    tournamentId?: number; generalPlayRoundId?: number; round?: number;
    courseId?: number;
    gps?: GPSSample[]; motion?: MotionEvent[];
    /**
     * Optional wearable shot rows already classified by Garmin/Arccos/Apple.
     * The mobile/wearable sync flow passes these in explicitly; we do not auto-
     * hydrate from `shotsTable` because the schema does not yet record a row's
     * origin source, so re-running detect could otherwise re-ingest previously
     * inferred shots as high-confidence wearable signals.
     */
    wearableShots?: Array<{ lat: number; lng: number; timestamp: number; shotType?: string | null; club?: string | null }>;
    sensitivity?: "low" | "medium" | "high";
    commit?: boolean;
    /**
     * Optional explicit subset of proposals the player approved (and possibly
     * edited) in the round-end review modal. When provided on a commit call,
     * we persist exactly these rows instead of re-running detection — this
     * lets the player drop misfired auto-detected shots and tweak
     * shotType/club before saving. See task #526.
     */
    acceptedShots?: Array<{
      holeNumber: number;
      shotNumber: number;
      shotType: string;
      club?: string | null;
      latitude: number;
      longitude: number;
      distanceToPinYards: number;
      recordedAt: string;
      source?: string;
      confidence?: number;
    }>;
  };
  const round = b.round ?? 1;
  if (!Array.isArray(b.gps) || b.gps.length === 0) { { res.status(400).json({ error: "gps samples required" }); return; } }

  let courseId = b.courseId ?? null;
  let playerId: number | null = null;
  if (b.tournamentId) {
    const [p] = await db.select({ id: playersTable.id }).from(playersTable)
      .where(and(eq(playersTable.userId, userId), eq(playersTable.tournamentId, b.tournamentId))).limit(1);
    if (!p) { { res.status(403).json({ error: "Not enrolled in this tournament" }); return; } }
    playerId = p.id;
    if (!courseId) {
      const [t] = await db.select({ courseId: tournamentsTable.courseId }).from(tournamentsTable).where(eq(tournamentsTable.id, b.tournamentId));
      courseId = t?.courseId ?? null;
    }
  } else if (b.generalPlayRoundId) {
    const [gp] = await db.select({ userId: generalPlayRoundsTable.userId, courseId: generalPlayRoundsTable.courseId })
      .from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, b.generalPlayRoundId)).limit(1);
    if (!gp || gp.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }
    if (!courseId) courseId = gp.courseId ?? null;
  } else {
    res.status(400).json({ error: "tournamentId or generalPlayRoundId required" }); return;
  }
  if (!courseId) { { res.status(400).json({ error: "courseId required (could not derive from round)" }); return; } }

  const sens = SENSITIVITY_PRESETS[b.sensitivity ?? "medium"];

  // Merge any GPS samples the phone chunk-streamed during the round (Task #525)
  // with whatever the request body just supplied. Dedupe by timestamp so a
  // client that resends its full local buffer at round-end does not double
  // count earlier chunks. The contextKey scopes the buffer to this round.
  const ctxKey = b.tournamentId ? `t:${b.tournamentId}:r:${round}` : `g:${b.generalPlayRoundId}:r:${round}`;
  const mergedGps = await mergeBufferedGPS(userId, ctxKey, b.gps!);

  // Merge any motion peaks the watch streamed while the round was in progress.
  // We bound the drain to the GPS sample window (±5 min slack) so a stale
  // event from a previous round can't get pulled in mid-detection.
  const gpsTimestamps = mergedGps.map(g => g.timestamp).filter(t => Number.isFinite(t));
  const lo = gpsTimestamps.length ? Math.min(...gpsTimestamps) - 5 * 60 * 1000 : undefined;
  const hi = gpsTimestamps.length ? Math.max(...gpsTimestamps) + 5 * 60 * 1000 : undefined;
  // For review (commit:false) we peek so a subsequent commit detect call
  // sees the same buffered watch motion and produces the same proposals
  // the user just approved. Only drain (i.e. consume) when committing.
  const buffered = b.commit
    ? await drainMotionEvents(userId, lo, hi)
    : await peekMotionEvents(userId, lo, hi);
  const motion = [...(b.motion ?? []), ...buffered];

  const detected = await detectShotsFromSignals({
    courseId,
    gps: mergedGps,
    motion,
    wearableShots: b.wearableShots ?? [],
    sensitivity: sens,
  });

  let inserted = 0;
  // When the client provided an explicit accepted subset (review modal), use
  // exactly those rows (with any shotType/club edits applied). Otherwise fall
  // back to persisting everything the engine detected on this call.
  const VALID_TYPES: ReadonlySet<DetectedShotType> = new Set([
    "tee", "fairway", "approach", "chip", "sand", "putt",
  ]);
  let toCommit: DetectedShot[] = detected;
  if (b.commit && Array.isArray(b.acceptedShots)) {
    toCommit = b.acceptedShots
      .filter(a => VALID_TYPES.has(a.shotType as DetectedShotType))
      .map<DetectedShot>(a => ({
        holeNumber: a.holeNumber,
        shotNumber: a.shotNumber,
        shotType: a.shotType as DetectedShotType,
        club: a.club ?? null,
        latitude: a.latitude,
        longitude: a.longitude,
        distanceToPinYards: a.distanceToPinYards,
        recordedAt: new Date(a.recordedAt),
        source: (a.source as DetectedShot["source"]) ?? "gps",
        confidence: typeof a.confidence === "number" ? a.confidence : 0.5,
      }));
  }
  if (b.commit) {
    if (toCommit.length > 0) {
      const rows = detectedShotsToInsert(toCommit, {
        tournamentId: b.tournamentId ?? null, generalPlayRoundId: b.generalPlayRoundId ?? null,
        playerId, userId: b.generalPlayRoundId ? userId : null, round,
      });
      if (b.tournamentId) {
        const r = await db.insert(shotsTable).values(rows).onConflictDoNothing({
          target: [shotsTable.playerId, shotsTable.tournamentId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
        }).returning({ id: shotsTable.id });
        inserted = r.length;
      } else {
        const r = await db.insert(shotsTable).values(rows).onConflictDoNothing({
          target: [shotsTable.userId, shotsTable.generalPlayRoundId, shotsTable.round, shotsTable.holeNumber, shotsTable.shotNumber],
        }).returning({ id: shotsTable.id });
        inserted = r.length;
      }
    }
    // Buffer is one-shot: once a commit has been issued for the round, drop
    // any GPS samples we were holding even when zero shots were detected.
    // Otherwise a subsequent (re-finished) detect call could replay stale
    // samples — and "commit semantics" should always finalise the buffer.
    await clearGPSSamples(userId, ctxKey);
  }

  res.json({ ok: true, sensitivity: b.sensitivity ?? "medium", proposed: detected, inserted });
});

// POST /api/portal/shots/ingest — Task #525.
// Accepts a small chunk of GPS samples streamed from the phone *during* the
// round (vs. the legacy one-shot upload at round-end via /shots/detect).
// The samples are merged into a per-(user,round) server buffer keyed by the
// tournament/general-play context, deduped by timestamp so retried chunks
// after a network blip do not produce duplicate proposals. The endpoint also
// runs a lightweight detection pass against the running buffer and returns
// `proposedCount` so the score screen can show a live "X auto-detected so
// far" badge to the player.
router.post("/portal/shots/ingest", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  if (!await requireConsent(req, res, "gps")) return;
  const b = req.body as {
    tournamentId?: number; generalPlayRoundId?: number; round?: number;
    courseId?: number;
    gps?: GPSSample[];
    sensitivity?: "low" | "medium" | "high";
  };
  const round = b.round ?? 1;
  if (!Array.isArray(b.gps)) { { res.status(400).json({ error: "gps samples required" }); return; } }
  // Cap per-chunk size — the client sends small windows (every 5 min or per
  // hole), so anything larger is almost certainly a misbehaving build.
  if (b.gps.length > 2000) { { res.status(413).json({ error: "Maximum 2000 samples per chunk" }); return; } }

  let courseId = b.courseId ?? null;
  if (b.tournamentId) {
    const [p] = await db.select({ id: playersTable.id }).from(playersTable)
      .where(and(eq(playersTable.userId, userId), eq(playersTable.tournamentId, b.tournamentId))).limit(1);
    if (!p) { { res.status(403).json({ error: "Not enrolled in this tournament" }); return; } }
    if (!courseId) {
      const [t] = await db.select({ courseId: tournamentsTable.courseId }).from(tournamentsTable).where(eq(tournamentsTable.id, b.tournamentId));
      courseId = t?.courseId ?? null;
    }
  } else if (b.generalPlayRoundId) {
    const [gp] = await db.select({ userId: generalPlayRoundsTable.userId, courseId: generalPlayRoundsTable.courseId })
      .from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, b.generalPlayRoundId)).limit(1);
    if (!gp || gp.userId !== userId) { { res.status(403).json({ error: "Forbidden" }); return; } }
    if (!courseId) courseId = gp.courseId ?? null;
  } else {
    res.status(400).json({ error: "tournamentId or generalPlayRoundId required" }); return;
  }

  const ctxKey = b.tournamentId ? `t:${b.tournamentId}:r:${round}` : `g:${b.generalPlayRoundId}:r:${round}`;
  const bufferedCount = await bufferGPSSamples(userId, ctxKey, b.gps);

  // Run detection over the full buffered set so we can report a live count.
  // We peek (don't drain) motion events because the round isn't over and the
  // round-end commit detect call still needs them. Detection is best-effort:
  // if greens aren't loaded yet (e.g. unmapped course) we report zero shots
  // and the badge simply stays at "—".
  let proposedCount = 0;
  let lastHole: number | null = null;
  if (courseId) {
    try {
      const allGps = await peekGPSSamples(userId, ctxKey);
      // Bound motion peek to the buffered GPS time window (±5 min slack) so
      // the live badge isn't inflated by stale watch peaks from a previous
      // round or another concurrent activity. Mirrors /shots/detect behaviour.
      const ts = allGps.map(g => g.timestamp);
      const mLo = ts.length ? Math.min(...ts) - 5 * 60 * 1000 : undefined;
      const mHi = ts.length ? Math.max(...ts) + 5 * 60 * 1000 : undefined;
      const motion = await peekMotionEvents(userId, mLo, mHi);
      const detected = await detectShotsFromSignals({
        courseId,
        gps: allGps,
        motion,
        wearableShots: [],
        sensitivity: SENSITIVITY_PRESETS[b.sensitivity ?? "medium"],
      });
      proposedCount = detected.length;
      lastHole = detected.length > 0 ? detected[detected.length - 1].holeNumber : null;
    } catch {/* detection is advisory during play; commit-time call is the source of truth */}
  }

  res.json({ ok: true, bufferedSamples: bufferedCount, proposedCount, lastHole });
});

// ─── PER-HOLE / PER-SHOT SG BREAKDOWN ───────────────────────────────────────

// GET /api/portal/sg/round?round=N&tournamentId=X (or generalPlayRoundId=Y)&baseline=scratch|10|18
router.get("/portal/sg/round", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const round = parseInt((req.query.round as string) ?? "1", 10);
  const baseline = (req.query.baseline as SGBaseline | undefined) ?? "scratch";
  const tournamentId = req.query.tournamentId ? parseInt(req.query.tournamentId as string, 10) : null;
  const generalPlayRoundId = req.query.generalPlayRoundId ? parseInt(req.query.generalPlayRoundId as string, 10) : null;
  if (!tournamentId && !generalPlayRoundId) { { res.status(400).json({ error: "tournamentId or generalPlayRoundId required" }); return; } }

  let shots: (typeof shotsTable.$inferSelect)[] = [];
  let courseId: number | null = null;
  // Per-hole putt counts from the scorecard. Powers the SG-Putting fallback
  // for holes/rounds where green-side per-shot tracking is missing but putts
  // were captured via voice or manual scorecard entry.
  const holePutts = new Map<number, number>();

  if (tournamentId) {
    const [p] = await db.select({ id: playersTable.id }).from(playersTable)
      .where(and(eq(playersTable.userId, userId), eq(playersTable.tournamentId, tournamentId))).limit(1);
    if (!p) { { res.json({ holes: [], totals: null, shotsTracked: 0 }); return; } }
    const [shotsRows, scoreRows, rRow, tRow] = await Promise.all([
      db.select().from(shotsTable)
        .where(and(eq(shotsTable.playerId, p.id), eq(shotsTable.tournamentId, tournamentId), eq(shotsTable.round, round)))
        .orderBy(asc(shotsTable.holeNumber), asc(shotsTable.shotNumber)),
      db.select({ holeNumber: scoresTable.holeNumber, putts: scoresTable.putts })
        .from(scoresTable)
        .where(and(eq(scoresTable.playerId, p.id), eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.round, round))),
      db.select({ courseId: tournamentRoundsTable.courseId }).from(tournamentRoundsTable)
        .where(and(eq(tournamentRoundsTable.tournamentId, tournamentId), eq(tournamentRoundsTable.roundNumber, round))).limit(1),
      db.select({ courseId: tournamentsTable.courseId }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId)).limit(1),
    ]);
    shots = shotsRows;
    for (const s of scoreRows) if (s.putts !== null) holePutts.set(s.holeNumber, s.putts);
    courseId = rRow[0]?.courseId ?? tRow[0]?.courseId ?? null;
  } else {
    const [gp] = await db.select({ userId: generalPlayRoundsTable.userId, courseId: generalPlayRoundsTable.courseId })
      .from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId!)).limit(1);
    if (!gp || gp.userId !== userId) { { res.json({ holes: [], totals: null, shotsTracked: 0 }); return; } }
    courseId = gp.courseId ?? null;
    const [shotsRows, gpHoleRows] = await Promise.all([
      db.select().from(shotsTable)
        .where(and(eq(shotsTable.userId, userId), eq(shotsTable.generalPlayRoundId, generalPlayRoundId!), eq(shotsTable.round, round)))
        .orderBy(asc(shotsTable.holeNumber), asc(shotsTable.shotNumber)),
      db.select({ holeNumber: generalPlayHoleScoresTable.holeNumber, putts: generalPlayHoleScoresTable.putts })
        .from(generalPlayHoleScoresTable)
        .where(eq(generalPlayHoleScoresTable.roundId, generalPlayRoundId!)),
    ]);
    shots = shotsRows;
    for (const s of gpHoleRows) if (s.putts !== null) holePutts.set(s.holeNumber, s.putts);
  }

  const holePars = new Map<number, number>();
  if (courseId) {
    const holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(eq(holeDetailsTable.courseId, courseId));
    for (const h of holes) holePars.set(h.holeNumber, h.par);
  }

  // Explicit row → ShotRow normalization (avoids unsafe blanket cast and
  // documents exactly which fields the SG engine consumes).
  const normalized: ShotRow[] = shots.map(s => ({
    id: s.id,
    tournamentId: s.tournamentId,
    playerId: s.playerId,
    generalPlayRoundId: s.generalPlayRoundId,
    userId: s.userId,
    round: s.round,
    holeNumber: s.holeNumber,
    shotNumber: s.shotNumber,
    shotType: s.shotType,
    club: s.club,
    lieType: s.lieType,
    missDirection: s.missDirection,
    distanceToPin: s.distanceToPin,
    distanceCarried: s.distanceCarried,
    recordedAt: s.recordedAt,
  }));
  const holes = computePerHoleSGFromShots(normalized, holePars, baseline, holePutts);
  const totals = holes.length === 0 ? null : {
    sgPutting:  Math.round(holes.reduce((a, h) => a + h.sgPutting, 0) * 100) / 100,
    sgApproach: Math.round(holes.reduce((a, h) => a + h.sgApproach, 0) * 100) / 100,
    sgATG:      Math.round(holes.reduce((a, h) => a + h.sgATG, 0) * 100) / 100,
    sgOTT:      Math.round(holes.reduce((a, h) => a + h.sgOTT, 0) * 100) / 100,
    sgTotal:    Math.round(holes.reduce((a, h) => a + h.sgTotal, 0) * 100) / 100,
    // True when any hole's SG-Putting came from the scorecard fallback rather
    // than per-shot tracking on the green. Lets the round summary surface a
    // "~" badge so players know the figure is partly an estimate.
    puttingEstimated: holes.some(h => h.puttingEstimated),
  };
  res.json({ baseline, round, shotsTracked: shots.length, holes, totals });
});

// ─── DISPERSION / PROXIMITY-BANDS / PUTTING ANALYTICS ───────────────────────

async function fetchAllUserShots(userId: number) {
  const userPlayers = await db.select({ id: playersTable.id }).from(playersTable).where(eq(playersTable.userId, userId));
  const playerIds = userPlayers.map(p => p.id);
  if (playerIds.length === 0) {
    return db.select().from(shotsTable).where(eq(shotsTable.userId, userId));
  }
  // Use Drizzle's safe operators rather than raw `IN ${array}` interpolation,
  // which is invalid for array bind params and breaks at runtime.
  return db.select().from(shotsTable).where(
    sql`${eq(shotsTable.userId, userId)} OR ${inArray(shotsTable.playerId, playerIds)}`,
  );
}

// GET /api/portal/dispersion — per-club dispersion summary for the current user.
router.get("/portal/dispersion", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const shots = await fetchAllUserShots(userId);
  res.json({ clubs: computeClubDispersion(shots) });
});

// GET /api/portal/proximity-bands — average proximity & GIR rate by approach distance band.
router.get("/portal/proximity-bands", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const shots = await fetchAllUserShots(userId);
  res.json({ bands: computeProximityBands(shots) });
});

// GET /api/portal/putting-stats — putting make-rates by distance.
router.get("/portal/putting-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const shots = await fetchAllUserShots(userId);
  res.json({ bands: computePuttingMakeRates(shots) });
});

// ─── AI CADDIE / YEAR-IN-GOLF SHOT FEED ─────────────────────────────────────

export interface EnrichedShot {
  id: number;
  tournamentId: number | null;
  generalPlayRoundId: number | null;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club: string | null;
  lieType: string | null;
  missDirection: string | null;
  distanceToPin: number | null;
  distanceCarried: number | null;
  latitude: number | null;
  longitude: number | null;
  recordedAt: Date;
  hole: { par: number; yardageWhite: number | null } | null;
}

// Shared loader for the AI Caddie shot feed. Used by GET /portal/caddie/shot-history,
// the AI Caddie chat prompt builder, and the Year-in-Golf recap.
async function loadCaddieShotHistory(
  userId: number,
  opts: { limit: number; since?: Date | null; until?: Date | null },
): Promise<{ shots: EnrichedShot[]; rawShots: (typeof shotsTable.$inferSelect)[] }> {
  const userPlayers = await db.select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable).where(eq(playersTable.userId, userId));
  const playerIds = userPlayers.map(p => p.id);
  const tournamentIds = [...new Set(userPlayers.map(p => p.tournamentId))];

  const ownership = playerIds.length > 0
    ? sql`(${eq(shotsTable.userId, userId)} OR ${inArray(shotsTable.playerId, playerIds)})`
    : sql`${eq(shotsTable.userId, userId)}`;
  const dateGuards = [];
  if (opts.since) dateGuards.push(sql`${shotsTable.recordedAt} >= ${opts.since}`);
  if (opts.until) dateGuards.push(sql`${shotsTable.recordedAt} <= ${opts.until}`);
  const whereSql = dateGuards.length > 0
    ? sql`${ownership} AND ${sql.join(dateGuards, sql` AND `)}`
    : ownership;

  const shotRows = await db.select().from(shotsTable)
    .where(whereSql)
    .orderBy(desc(shotsTable.recordedAt))
    .limit(opts.limit);

  const courseIdByTournament = new Map<number, number | null>();
  if (tournamentIds.length > 0) {
    const tRows = await db.select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId })
      .from(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));
    for (const t of tRows) courseIdByTournament.set(t.id, t.courseId);
  }
  const courseIdByGP = new Map<number, number | null>();
  const gpIds = [...new Set(shotRows.map(s => s.generalPlayRoundId).filter((v): v is number => v !== null))];
  if (gpIds.length > 0) {
    const gpRows = await db.select({ id: generalPlayRoundsTable.id, courseId: generalPlayRoundsTable.courseId })
      .from(generalPlayRoundsTable).where(inArray(generalPlayRoundsTable.id, gpIds));
    for (const g of gpRows) courseIdByGP.set(g.id, g.courseId);
  }

  const holeKey = (cid: number, h: number) => `${cid}:${h}`;
  const holeMap = new Map<string, { par: number; yardageWhite: number | null }>();
  const holeKeysNeeded = new Set<string>();
  const courseIdsNeeded = new Set<number>();
  for (const s of shotRows) {
    const cid = s.tournamentId ? courseIdByTournament.get(s.tournamentId) : (s.generalPlayRoundId ? courseIdByGP.get(s.generalPlayRoundId) : null);
    if (cid && s.holeNumber) {
      holeKeysNeeded.add(holeKey(cid, s.holeNumber));
      courseIdsNeeded.add(cid);
    }
  }
  if (courseIdsNeeded.size > 0) {
    const courseHoles = await db.select({
      courseId: holeDetailsTable.courseId, holeNumber: holeDetailsTable.holeNumber,
      par: holeDetailsTable.par, yardageWhite: holeDetailsTable.yardageWhite,
    }).from(holeDetailsTable).where(inArray(holeDetailsTable.courseId, [...courseIdsNeeded]));
    for (const h of courseHoles) {
      const k = holeKey(h.courseId, h.holeNumber);
      if (holeKeysNeeded.has(k)) holeMap.set(k, { par: h.par, yardageWhite: h.yardageWhite });
    }
  }

  const enriched: EnrichedShot[] = shotRows.map(s => {
    const cid = s.tournamentId ? courseIdByTournament.get(s.tournamentId) : (s.generalPlayRoundId ? courseIdByGP.get(s.generalPlayRoundId) : null);
    const ctx = cid && s.holeNumber ? holeMap.get(holeKey(cid, s.holeNumber)) : undefined;
    return {
      id: s.id,
      tournamentId: s.tournamentId, generalPlayRoundId: s.generalPlayRoundId,
      round: s.round, holeNumber: s.holeNumber, shotNumber: s.shotNumber,
      shotType: s.shotType, club: s.club, lieType: s.lieType, missDirection: s.missDirection,
      distanceToPin: s.distanceToPin !== null ? parseFloat(s.distanceToPin) : null,
      distanceCarried: s.distanceCarried !== null ? parseFloat(s.distanceCarried) : null,
      latitude: s.latitude !== null ? parseFloat(s.latitude) : null,
      longitude: s.longitude !== null ? parseFloat(s.longitude) : null,
      recordedAt: s.recordedAt,
      hole: ctx ? { par: ctx.par, yardageWhite: ctx.yardageWhite } : null,
    };
  });

  return { shots: enriched, rawShots: shotRows };
}

// GET /api/portal/caddie/shot-history?limit=N&since=ISO&until=ISO
// Joined shot+hole context for downstream AI (AI Caddie chat & Year-in-Golf recap).
// Returns the most recent N shots (default 200, max 5000) optionally filtered by date,
// with hole par/yardage data merged in — ready for prompt construction without further joins.
router.get("/portal/caddie/shot-history", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const limitRaw = parseInt((req.query.limit as string) ?? "200", 10);
  const limit = Math.min(5000, Math.max(1, isNaN(limitRaw) ? 200 : limitRaw));
  const parseDate = (v: unknown): Date | null => {
    if (typeof v !== "string" || !v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };
  const since = parseDate(req.query.since);
  const until = parseDate(req.query.until);

  const { shots } = await loadCaddieShotHistory(userId, { limit, since, until });
  res.json({ shots, count: shots.length });
});

// ── AI Caddie chat history sync (Task #843) ──────────────────────────────
// Single row per signed-in player. The mobile client mirrors this to
// AsyncStorage so the transcript follows the player across devices and
// survives reinstalls, while staying readable when offline.

const CADDIE_HISTORY_MAX_MESSAGES = 50;

type StoredCaddieMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  context?: { shots: number; rounds: number; mode?: "shots" | "rounds"; totalTrackedShots?: number };
  error?: string;
};

function sanitizeCaddieMessages(input: unknown): StoredCaddieMessage[] {
  if (!Array.isArray(input)) return [];
  const cleaned: StoredCaddieMessage[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || typeof m.content !== "string") continue;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const out: StoredCaddieMessage = { id: m.id, role: m.role, content: m.content };
    if (m.context && typeof m.context === "object") {
      const c = m.context as Record<string, unknown>;
      out.context = {
        shots: typeof c.shots === "number" ? c.shots : 0,
        rounds: typeof c.rounds === "number" ? c.rounds : 0,
        mode: c.mode === "shots" || c.mode === "rounds" ? c.mode : undefined,
        totalTrackedShots: typeof c.totalTrackedShots === "number" ? c.totalTrackedShots : undefined,
      };
    }
    if (typeof m.error === "string") out.error = m.error;
    cleaned.push(out);
  }
  return cleaned.slice(-CADDIE_HISTORY_MAX_MESSAGES);
}

// GET /api/portal/caddie/history — load the player's saved transcript.
// Returns `version` so the client can echo it back as `baseVersion` on the
// next PUT (Task #989 — optimistic concurrency for two-device edits).
router.get("/portal/caddie/history", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const [row] = await db.select().from(caddieChatHistoryTable)
    .where(eq(caddieChatHistoryTable.userId, userId));
  res.json({
    messages: row?.messages ?? [],
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    version: row?.version ?? 0,
  });
});

// PUT /api/portal/caddie/history — replace the player's saved transcript.
// Body: { messages: StoredCaddieMessage[], baseVersion?: number }.
//
// Cross-device concurrency (Task #989): the server keeps a per-row `version`
// column that is bumped on every successful PUT. If the client supplies
// `baseVersion`, the write is only applied when the row's current version
// still matches; otherwise we return HTTP 409 with the server's current
// state so the client can merge by message id and retry. Calls that omit
// `baseVersion` keep the original last-write-wins behaviour for back-compat
// with older mobile builds.
router.put("/portal/caddie/history", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const body = (req.body ?? {}) as { messages?: unknown; baseVersion?: unknown };
  const messages = sanitizeCaddieMessages(body.messages);
  const baseVersion = typeof body.baseVersion === "number" && Number.isFinite(body.baseVersion)
    ? Math.max(0, Math.floor(body.baseVersion))
    : null;
  const now = new Date();

  if (baseVersion === null) {
    // Legacy path: unconditional upsert, bump version if the row already exists.
    const [row] = await db
      .insert(caddieChatHistoryTable)
      .values({ userId, messages, updatedAt: now, version: 1 })
      .onConflictDoUpdate({
        target: caddieChatHistoryTable.userId,
        set: {
          messages,
          updatedAt: now,
          version: sql`${caddieChatHistoryTable.version} + 1`,
        },
      })
      .returning({ version: caddieChatHistoryTable.version });
    res.json({ ok: true, count: messages.length, updatedAt: now.toISOString(), version: row?.version ?? 1 });
    return;
  }

  // Optimistic-concurrency path. Try a conditional UPDATE first; if zero rows
  // match the version, fall back to an insert when the row is missing or
  // surface a 409 conflict otherwise.
  const updated = await db
    .update(caddieChatHistoryTable)
    .set({
      messages,
      updatedAt: now,
      version: sql`${caddieChatHistoryTable.version} + 1`,
    })
    .where(and(
      eq(caddieChatHistoryTable.userId, userId),
      eq(caddieChatHistoryTable.version, baseVersion),
    ))
    .returning({ version: caddieChatHistoryTable.version, updatedAt: caddieChatHistoryTable.updatedAt });

  if (updated.length > 0) {
    res.json({
      ok: true,
      count: messages.length,
      updatedAt: updated[0]!.updatedAt.toISOString(),
      version: updated[0]!.version,
    });
    return;
  }

  const [current] = await db
    .select()
    .from(caddieChatHistoryTable)
    .where(eq(caddieChatHistoryTable.userId, userId));

  if (!current && baseVersion === 0) {
    // First write race: another device may insert between our SELECT and
    // INSERT, so use onConflictDoNothing — if zero rows come back the row
    // already exists and we must fall through to the 409 conflict path so
    // the client can merge by message id and retry. Never overwrite here.
    const inserted = await db
      .insert(caddieChatHistoryTable)
      .values({ userId, messages, updatedAt: now, version: 1 })
      .onConflictDoNothing({ target: caddieChatHistoryTable.userId })
      .returning({ version: caddieChatHistoryTable.version, updatedAt: caddieChatHistoryTable.updatedAt });
    if (inserted.length > 0) {
      res.json({
        ok: true,
        count: messages.length,
        updatedAt: inserted[0]!.updatedAt.toISOString(),
        version: inserted[0]!.version,
      });
      return;
    }
    const [raced] = await db
      .select()
      .from(caddieChatHistoryTable)
      .where(eq(caddieChatHistoryTable.userId, userId));
    res.status(409).json({
      error: "conflict",
      code: "STALE_VERSION",
      current: {
        messages: raced?.messages ?? [],
        updatedAt: raced?.updatedAt ? raced.updatedAt.toISOString() : null,
        version: raced?.version ?? 0,
      },
    });
    return;
  }

  res.status(409).json({
    error: "conflict",
    code: "STALE_VERSION",
    current: {
      messages: current?.messages ?? [],
      updatedAt: current?.updatedAt ? current.updatedAt.toISOString() : null,
      version: current?.version ?? 0,
    },
  });
});

// DELETE /api/portal/caddie/history — wipe the player's saved transcript.
router.delete("/portal/caddie/history", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  await db.delete(caddieChatHistoryTable)
    .where(eq(caddieChatHistoryTable.userId, userId));
  res.json({ ok: true });
});

// POST /api/portal/caddie/ask — AI Caddie chat (SSE streaming).
// On each request we hydrate the system prompt with the player's recent shot
// history (last ~100 shots from the new shot-history feed), per-club dispersion
// summary, and recent strokes-gained per category so recommendations are
// grounded in the player's actual game rather than generic golf advice.
router.post("/portal/caddie/ask", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const { question, history, tournamentId, leagueId, generalPlayRoundId, leagueRoundId } = req.body as {
    question?: unknown;
    history?: { role: "user" | "assistant"; content: string }[];
    tournamentId?: number | null;
    leagueId?: number | null;
    generalPlayRoundId?: number | null;
    leagueRoundId?: number | null;
  };
  if (typeof question !== "string" || question.trim().length === 0) {
    res.status(400).json({ error: "Question is required." });
    return;
  }

  // Wave 1 W1-A — enforce roundContext.aiCaddieMode. Lockdown blocks the
  // chat entirely; distance_only also blocks it (a free-form Q&A is
  // strategy advice, not a yardage). 'open' is the steady-state.
  try {
    await assertModeAllows({
      tournamentId: tournamentId ?? null,
      leagueId: leagueId ?? null,
      generalPlayRoundId: generalPlayRoundId ?? null,
      leagueRoundId: leagueRoundId ?? null,
      userId,
      surface: "phone",
      action: "caddie_ask",
      metadata: { question_chars: question.length },
    });
  } catch (err) {
    if (err instanceof AiCaddieBlockedError) {
      res.status(403).json({
        error: "AI Caddie is disabled for this round.",
        mode: err.mode,
        action: err.action,
      });
      return;
    }
    throw err;
  }

  // 1) Recent shot feed (last ~100 shots) — joined with hole context.
  const { shots: recentShots, rawShots } = await loadCaddieShotHistory(userId, {
    limit: 100, since: null, until: null,
  });

  // 2) Per-club dispersion summary across the player's full shot library.
  const allShots = await fetchAllUserShots(userId);
  const dispersion = computeClubDispersion(allShots);
  const topClubs = [...dispersion]
    .filter(c => c.shots >= 3)
    .sort((a, b) => b.shots - a.shots)
    .slice(0, 8);

  // 3) Strokes-gained summary across the rounds touched by the recent feed.
  // Group recent shots by (tournamentId|gpRoundId)+round and compute SG totals.
  const roundGroups = new Map<string, { tournamentId: number | null; gpRoundId: number | null; round: number; courseId: number | null; shots: ShotRow[] }>();
  const courseIdByTournament = new Map<number, number | null>();
  const courseIdByGP = new Map<number, number | null>();
  const tournamentIds = [...new Set(rawShots.map(s => s.tournamentId).filter((v): v is number => v !== null))];
  const gpIds = [...new Set(rawShots.map(s => s.generalPlayRoundId).filter((v): v is number => v !== null))];
  if (tournamentIds.length > 0) {
    const tRows = await db.select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId })
      .from(tournamentsTable).where(inArray(tournamentsTable.id, tournamentIds));
    for (const t of tRows) courseIdByTournament.set(t.id, t.courseId);
  }
  if (gpIds.length > 0) {
    const gpRows = await db.select({ id: generalPlayRoundsTable.id, courseId: generalPlayRoundsTable.courseId })
      .from(generalPlayRoundsTable).where(inArray(generalPlayRoundsTable.id, gpIds));
    for (const g of gpRows) courseIdByGP.set(g.id, g.courseId);
  }
  for (const s of rawShots) {
    const cid = s.tournamentId ? (courseIdByTournament.get(s.tournamentId) ?? null) : (s.generalPlayRoundId ? (courseIdByGP.get(s.generalPlayRoundId) ?? null) : null);
    const k = `${s.tournamentId ?? "g"}-${s.generalPlayRoundId ?? "t"}-${s.round}`;
    if (!roundGroups.has(k)) roundGroups.set(k, { tournamentId: s.tournamentId, gpRoundId: s.generalPlayRoundId, round: s.round, courseId: cid, shots: [] });
    roundGroups.get(k)!.shots.push({
      id: s.id,
      tournamentId: s.tournamentId,
      playerId: s.playerId,
      generalPlayRoundId: s.generalPlayRoundId,
      userId: s.userId,
      round: s.round,
      holeNumber: s.holeNumber,
      shotNumber: s.shotNumber,
      shotType: s.shotType,
      club: s.club,
      lieType: s.lieType,
      missDirection: s.missDirection,
      distanceToPin: s.distanceToPin,
      distanceCarried: s.distanceCarried,
      recordedAt: s.recordedAt,
    });
  }
  const courseIdsForSG = [...new Set([...roundGroups.values()].map(g => g.courseId).filter((v): v is number => v !== null))];
  const parsByCourse = new Map<number, HoleParMap>();
  if (courseIdsForSG.length > 0) {
    const holeRows = await db.select({ courseId: holeDetailsTable.courseId, holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable).where(inArray(holeDetailsTable.courseId, courseIdsForSG));
    for (const h of holeRows) {
      if (!parsByCourse.has(h.courseId)) parsByCourse.set(h.courseId, new Map());
      parsByCourse.get(h.courseId)!.set(h.holeNumber, h.par);
    }
  }
  const sgTotals = { sgPutting: 0, sgApproach: 0, sgATG: 0, sgOTT: 0, sgTotal: 0 };
  const sgCounts = { sgPutting: 0, sgApproach: 0, sgATG: 0, sgOTT: 0, sgTotal: 0 };
  for (const g of roundGroups.values()) {
    const holePars: HoleParMap = (g.courseId && parsByCourse.get(g.courseId)) || new Map();
    const r: RoundShotData = { tournamentId: g.tournamentId ?? 0, round: g.round, shots: g.shots, holePars };
    const result = computeRoundSGFromShots(r, "scratch");
    for (const k of Object.keys(sgTotals) as (keyof typeof sgTotals)[]) {
      const v = result[k];
      if (v !== null) { sgTotals[k] += v; sgCounts[k]++; }
    }
  }
  const sgAvg = (Object.fromEntries(
    (Object.keys(sgTotals) as (keyof typeof sgTotals)[]).map(k =>
      [k, sgCounts[k] > 0 ? Math.round((sgTotals[k] / sgCounts[k]) * 100) / 100 : null]
    ),
  ) as Record<keyof typeof sgTotals, number | null>);

  // Identify strongest/weakest SG categories (excluding total).
  const categoryLabels: Record<string, string> = {
    sgPutting: "putting", sgApproach: "approach", sgATG: "around-the-green", sgOTT: "off-the-tee",
  };
  const ranked = Object.entries(sgAvg)
    .filter(([k, v]) => k !== "sgTotal" && v !== null)
    .sort((a, b) => (b[1] as number) - (a[1] as number));
  const strongest = ranked[0];
  const weakest = ranked[ranked.length - 1];

  // Per-shot lines (most recent first). May be trimmed below to respect the prompt budget.
  const shotToLine = (s: EnrichedShot) => {
    const dist = s.distanceToPin !== null ? `${Math.round(s.distanceToPin)}y to pin` : "no GPS";
    const carry = s.distanceCarried !== null ? `, carried ${Math.round(s.distanceCarried)}y` : "";
    const lie = s.lieType ? ` from ${s.lieType}` : "";
    const club = s.club ? `${s.club}` : s.shotType;
    const miss = s.missDirection ? `, missed ${s.missDirection}` : "";
    const par = s.hole?.par ? ` (par ${s.hole.par}` + (s.hole.yardageWhite ? `, ${s.hole.yardageWhite}y white` : "") + ")" : "";
    return `H${s.holeNumber} #${s.shotNumber} ${club}${lie}: ${dist}${carry}${miss}${par}`;
  };

  const dispersionLines = topClubs.map(c => {
    const carry = c.avgCarryYards != null ? `${Math.round(c.avgCarryYards)}y` : "n/a";
    const sd = c.carryStdDev != null ? `±${Math.round(c.carryStdDev)}y` : "";
    return `${c.club}: ${carry} ${sd} (${c.shots} shots)`;
  });

  const sgSummaryLine = ranked.length > 0
    ? `Recent SG (${sgCounts.sgTotal} rounds): putting ${sgAvg.sgPutting ?? "—"}, approach ${sgAvg.sgApproach ?? "—"}, around-green ${sgAvg.sgATG ?? "—"}, off-tee ${sgAvg.sgOTT ?? "—"}. Strongest: ${categoryLabels[strongest[0]]} (${strongest[1]}). Weakest: ${categoryLabels[weakest[0]]} (${weakest[1]}).`
    : "Not enough tracked rounds yet to compute strokes-gained.";

  // Build a compact per-round overview of the last 10 rounds (used for heavy users
  // and as a graceful fallback when the per-shot list would blow the token budget).
  const buildRoundOverviewLines = (shots: EnrichedShot[]): string[] => {
    const groups = new Map<string, EnrichedShot[]>();
    for (const s of shots) {
      const k = `${s.tournamentId ?? "g"}-${s.generalPlayRoundId ?? "t"}-${s.round}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(s);
    }
    const rounds = [...groups.values()]
      .sort((a, b) => b[0].recordedAt.getTime() - a[0].recordedAt.getTime())
      .slice(0, 10);
    return rounds.map(r => {
      const date = r[0].recordedAt.toISOString().slice(0, 10);
      const holes = new Set(r.map(s => s.holeNumber).filter((v): v is number => v !== null)).size;
      const clubCounts = new Map<string, number>();
      for (const s of r) if (s.club) clubCounts.set(s.club, (clubCounts.get(s.club) ?? 0) + 1);
      const topRoundClubs = [...clubCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([c, n]) => `${c}×${n}`).join(", ") || "no club tags";
      const misses = r.filter(s => s.missDirection).length;
      const tag = r[0].tournamentId ? "tournament" : "general play";
      return `${date} ${tag} R${r[0].round}: ${r.length} shots over ${holes} holes; clubs ${topRoundClubs}; ${misses} tagged misses`;
    });
  };

  const buildPrompt = (shotLines: string[], compact: boolean, totalShots: number) => {
    const shotHeader = compact
      ? `PLAYER'S LAST ${shotLines.length} ROUNDS (compact summary — ${totalShots} total shots tracked, too many for a full per-shot dump):`
      : `PLAYER'S RECENT SHOT-LEVEL DATA (most recent first, up to ${shotLines.length} shots):`;
    return `You are the player's personal AI Caddie. Ground every recommendation in the player's recent shot history and tendencies below — do NOT give generic golf advice when the data supports a personalised answer.

${shotHeader}
${shotLines.length > 0 ? shotLines.join("\n") : "(no tracked shots yet)"}

PLAYER'S CLUB DISPERSION (avg carry ± stddev):
${dispersionLines.length > 0 ? dispersionLines.join("\n") : "(no club distances tracked yet)"}

STROKES-GAINED SUMMARY:
${sgSummaryLine}

Guidelines:
- Reference specific clubs the player actually carries when suggesting club selection.
- When asked for practice priorities, lean on the strongest/weakest SG categories above.
- If data is missing, say so honestly and suggest tracking more rounds.
- Keep responses concise, practical, and player-friendly.`;
  };

  // Token-budget guard. We aim to stay under ~6k input tokens so heavy users don't
  // blow up cost / latency. ~4 chars ≈ 1 token is a conservative rough estimator.
  const MAX_PROMPT_TOKENS = 6000;
  const MIN_SHOT_LINES = 20;
  const HEAVY_USER_SHOT_THRESHOLD = 1000;
  const ROUND_OVERVIEW_FETCH_LIMIT = 2000;
  const estimateTokens = (s: string) => Math.ceil(s.length / 4);

  // Lazily fetch a larger shot window so the per-round overview can actually
  // cover the player's last 10 rounds (the recent feed is capped at 100 shots,
  // which for active players is only 1–2 rounds).
  let roundOverviewSource: EnrichedShot[] | null = null;
  const loadRoundOverviewLines = async (): Promise<string[]> => {
    if (!roundOverviewSource) {
      const { shots } = await loadCaddieShotHistory(userId, {
        limit: ROUND_OVERVIEW_FETCH_LIMIT, since: null, until: null,
      });
      roundOverviewSource = shots;
    }
    return buildRoundOverviewLines(roundOverviewSource);
  };

  const totalTrackedShots = allShots.length;
  let promptMode: "shots" | "rounds" = "shots";
  let shotLines: string[];

  if (totalTrackedShots > HEAVY_USER_SHOT_THRESHOLD) {
    // Heavy user: skip the per-shot dump entirely and use a per-round overview
    // that pulls from a wider window so we can summarise the last 10 rounds.
    promptMode = "rounds";
    shotLines = await loadRoundOverviewLines();
  } else {
    shotLines = recentShots.slice(0, 100).map(shotToLine);
  }

  let systemPrompt = buildPrompt(shotLines, promptMode === "rounds", totalTrackedShots);

  if (promptMode === "shots" && estimateTokens(systemPrompt) > MAX_PROMPT_TOKENS) {
    // Trim the per-shot list (oldest first) until we fit under the budget,
    // keeping at least MIN_SHOT_LINES of recent context.
    while (shotLines.length > MIN_SHOT_LINES && estimateTokens(systemPrompt) > MAX_PROMPT_TOKENS) {
      shotLines = shotLines.slice(0, Math.max(MIN_SHOT_LINES, Math.floor(shotLines.length * 0.75)));
      systemPrompt = buildPrompt(shotLines, false, totalTrackedShots);
    }
    // Still too big (extreme dispersion table, etc.) — fall back to round overview.
    if (estimateTokens(systemPrompt) > MAX_PROMPT_TOKENS) {
      promptMode = "rounds";
      shotLines = await loadRoundOverviewLines();
      systemPrompt = buildPrompt(shotLines, true, totalTrackedShots);
    }
  }

  const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(question)
    + (Array.isArray(history) ? history.slice(-8).reduce((acc, m) => acc + estimateTokens(m.content ?? ""), 0) : 0);
  recordCaddiePromptMetric({
    userId,
    contextMode: promptMode,
    estimatedInputTokens,
    totalTrackedShots,
    roundCount: sgCounts.sgTotal,
    shotLineCount: shotLines.length,
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: systemPrompt },
      ...(Array.isArray(history) ? history.slice(-8) : []),
      { role: "user", content: question.trim() },
    ];
    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      max_completion_tokens: 8192,
      messages,
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ done: true, contextShots: promptMode === "shots" ? shotLines.length : 0, contextRounds: sgCounts.sgTotal, contextMode: promptMode, totalTrackedShots })}\n\n`);
    res.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

// ─── CLUB DISTANCE PROFILE (portal) ─────────────────────────────────────────

// GET /api/portal/club-profile — aggregated club distances for the current user
// Includes shots from both tournament rounds and general play rounds.
router.get("/portal/club-profile", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  // Find all player IDs for this user across all tournaments
  const userPlayers = await db.select({ id: playersTable.id }).from(playersTable).where(eq(playersTable.userId, userId));
  const playerIds = userPlayers.map(p => p.id);

  // Task #709 — optional ?sources=watch,phone restricts the carry averages to
  // only the listed capture sources. The intended use is "watch/phone only",
  // i.e. measured shots with GPS, excluding both hand-entered carries (which
  // are the player's *belief* about distance) and scorer-station entries
  // (which are typed by a third party at the green and lack carry GPS).
  const allowedSources = new Set(["watch", "phone", "manual", "scorer"]);
  const sourcesParam = typeof req.query.sources === "string" ? req.query.sources : "";
  const requestedSources = sourcesParam
    .split(",").map(s => s.trim().toLowerCase()).filter(s => allowedSources.has(s));
  const sourceList = requestedSources.length > 0
    ? sql.join(requestedSources.map(s => sql`${s}`), sql`, `)
    : null;

  // Query shots from both tournament enrollments and general play (by userId)
  const sourceFilter = sourceList ? sql`AND ${shotsTable.source} IN (${sourceList})` : sql``;
  const whereClause = playerIds.length > 0
    ? sql`(${shotsTable.club} IS NOT NULL AND ${shotsTable.distanceCarried} IS NOT NULL AND (${inArray(shotsTable.playerId, playerIds)} OR ${eq(shotsTable.userId, userId)}) ${sourceFilter})`
    : sql`(${shotsTable.club} IS NOT NULL AND ${shotsTable.distanceCarried} IS NOT NULL AND ${eq(shotsTable.userId, userId)} ${sourceFilter})`;

  const profile = await db.select({
    club: shotsTable.club,
    avgDistance: avg(shotsTable.distanceCarried),
    minDistance: min(shotsTable.distanceCarried),
    maxDistance: max(shotsTable.distanceCarried),
    shotCount: count(shotsTable.id),
  }).from(shotsTable)
    .where(whereClause)
    .groupBy(shotsTable.club)
    .orderBy(desc(avg(shotsTable.distanceCarried)));

  res.json(profile.map(p => ({
    club: p.club,
    avgDistance: p.avgDistance ? parseFloat(p.avgDistance) : null,
    minDistance: p.minDistance ? parseFloat(p.minDistance) : null,
    maxDistance: p.maxDistance ? parseFloat(p.maxDistance) : null,
    shotCount: Number(p.shotCount),
  })));
});

// ─── PRACTICE SESSIONS (portal) ──────────────────────────────────────────────

// POST /api/portal/practice — log a practice session.
// Task #1641 — accepts optional `source` ("manual" | "coaching_tip"),
// `clubKey`, and `practiceDistanceYards` so the "Work on This Club" callout
// can deep-link into the practice logger pre-filled with the right club +
// distance band, and we can later A/B whether tip-driven practice closes the
// proximity gap faster than ad-hoc range time.
router.post("/portal/practice", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const {
    sessionType,
    durationMinutes,
    notes,
    clubFocus,
    sessionDate,
    organizationId,
    source,
    clubKey,
    practiceDistanceYards,
  } = req.body;

  // Whitelist the source tag so we don't accumulate mystery values that
  // poison future cohort splits. Anything else collapses to null (= manual).
  const normalisedSource: string | null =
    source === "coaching_tip" || source === "manual" ? source : null;

  const parsedDistance =
    typeof practiceDistanceYards === "number" && Number.isFinite(practiceDistanceYards)
      ? Math.max(1, Math.round(practiceDistanceYards))
      : null;

  const [session] = await db.insert(practiceSessionsTable).values({
    userId,
    organizationId: organizationId ?? null,
    sessionType: sessionType ?? "range",
    durationMinutes: durationMinutes ?? null,
    notes: notes ?? null,
    clubFocus: clubFocus ?? null,
    source: normalisedSource,
    clubKey: typeof clubKey === "string" && clubKey.length > 0 ? clubKey : null,
    practiceDistanceYards: parsedDistance,
    sessionDate: sessionDate ? new Date(sessionDate) : new Date(),
  }).returning();

  res.status(201).json(session);
});

// POST /api/portal/coaching-tip-impression — Task #2045.
//
// Records one row in `coaching_tip_impressions` per render of a "Work on
// This Club" tip card. Task #1641 already tags acted-on tips by setting
// `practice_sessions.source='coaching_tip'`, which gives us tip-driven
// session volume but not the conversion rate, because we don't know how
// many times a tip was shown and ignored. With this endpoint a future
// dashboard can compute
//
//     conversion = practice_sessions(source='coaching_tip')
//                / coaching_tip_impressions
//
// per club + date range.
//
// The client (`stats.tsx` on web + mobile) is responsible for deduping
// per session so a single user re-rendering or scrolling the panel
// doesn't inflate the denominator. We still validate `clubKey` here so
// a bad call from a future client doesn't silently poison the table
// with empty-key rows.
router.post("/portal/coaching-tip-impression", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const { clubKey, practiceDistanceYards, shownAt } = (req.body ?? {}) as {
    clubKey?: unknown;
    practiceDistanceYards?: unknown;
    shownAt?: unknown;
  };

  if (typeof clubKey !== "string" || clubKey.trim().length === 0) {
    res.status(400).json({ error: "clubKey required" });
    return;
  }
  // Bound the key length so a buggy/hostile client can't pad rows out;
  // canonical club keys produced by `resolveProximityBaseline` are short
  // tokens like `"7i"`, `"pw"`, etc.
  const normalisedClubKey = clubKey.trim().slice(0, 32);

  const parsedDistance =
    typeof practiceDistanceYards === "number" && Number.isFinite(practiceDistanceYards)
      ? Math.max(1, Math.min(1000, Math.round(practiceDistanceYards)))
      : null;

  // Accept an optional client-supplied `shownAt` so an offline-buffered
  // batch can still be backdated correctly. Anything unparseable falls
  // back to `now()` via the column default.
  let parsedShownAt: Date | null = null;
  if (typeof shownAt === "string" || typeof shownAt === "number") {
    const d = new Date(shownAt);
    if (!Number.isNaN(d.getTime())) parsedShownAt = d;
  }

  const [row] = await db.insert(coachingTipImpressionsTable).values({
    userId,
    clubKey: normalisedClubKey,
    practiceDistanceYards: parsedDistance,
    ...(parsedShownAt ? { shownAt: parsedShownAt } : {}),
  }).returning();

  res.status(201).json(row);
});

// GET /api/portal/practice — list user's practice sessions
router.get("/portal/practice", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  const sessions = await db.select().from(practiceSessionsTable)
    .where(eq(practiceSessionsTable.userId, userId))
    .orderBy(desc(practiceSessionsTable.sessionDate))
    .limit(limit);

  res.json(sessions);
});

// DELETE /api/portal/practice/:sessionId
router.delete("/portal/practice/:sessionId", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const sessionId = parseInt(String((req.params as Record<string, string>).sessionId));

  const [deleted] = await db.delete(practiceSessionsTable)
    .where(and(eq(practiceSessionsTable.id, sessionId), eq(practiceSessionsTable.userId, userId)))
    .returning({ id: practiceSessionsTable.id });

  if (!deleted) { { res.status(404).json({ error: "Session not found" }); return; } }
  res.json({ ok: true });
});

// GET /api/portal/practice/stats — streak, weekly count, heatmap
router.get("/portal/practice/stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const sessions = await db.select({
    id: practiceSessionsTable.id,
    sessionDate: practiceSessionsTable.sessionDate,
  }).from(practiceSessionsTable)
    .where(and(eq(practiceSessionsTable.userId, userId), gte(practiceSessionsTable.sessionDate, yearAgo)))
    .orderBy(desc(practiceSessionsTable.sessionDate));

  const thisWeek = sessions.filter(s => new Date(s.sessionDate) >= weekAgo).length;
  const thisMonth = sessions.filter(s => new Date(s.sessionDate) >= monthAgo).length;

  const seenDays = new Set<string>(sessions.map(s => new Date(s.sessionDate).toISOString().slice(0, 10)));

  let streak = 0;
  let checkDate = new Date();
  checkDate.setHours(0, 0, 0, 0);
  while (seenDays.has(checkDate.toISOString().slice(0, 10))) {
    streak++;
    checkDate.setDate(checkDate.getDate() - 1);
  }

  const heatmap: Record<string, number> = {};
  for (const s of sessions) {
    const day = new Date(s.sessionDate).toISOString().slice(0, 10);
    heatmap[day] = (heatmap[day] ?? 0) + 1;
  }

  res.json({ thisWeek, thisMonth, streak, total: sessions.length, heatmap });
});

// ─── Task #2044 — TIP-DRIVEN VS MANUAL PRACTICE COHORT ANALYTICS ─────────────
//
// Practice sessions now record `source` ('coaching_tip' | null/'manual'),
// `clubKey`, and `practiceDistanceYards`. The two endpoints below surface
// the A/B comparison promised by Task #1641: did practice that started
// from a "Work on This Club" coaching tip actually close the per-club
// proximity gap faster than ad-hoc range time?
//
//   • /portal/practice/cohort-stats        — per-player split (own data)
//   • /portal/admin/practice/cohort-stats  — org-wide admin/coach view
//
// Both endpoints accept `from`, `to`, and `clubKey` query filters so the
// player/admin can scope the comparison to a particular club or window.

/** Parse an ISO-ish date string from a query param; null when absent/invalid. */
function parseQueryDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t);
}

/** Safely return a clubKey query filter (lowercased, ≤16 chars), or null. */
function parseQueryClubKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v.length === 0 || v.length > 16) return null;
  return v;
}

/**
 * Mean proximity (ft) for a single canonical clubKey across the supplied
 * shots. Mirrors `computeProximityByClub` but collapses every raw club
 * label that normalises to the same canonical key (e.g. "7i" + "7-iron")
 * into one mean so the cohort comparison is robust to label drift.
 *
 * Returns `{ meanFt: null, shots: 0 }` when no eligible approach shots
 * exist in the input — the route layer turns that into the JSON null
 * sentinel so the UI shows "—" rather than a misleading 0.
 */
function meanProximityFtForClubKey(
  shots: Awaited<ReturnType<typeof fetchAllUserShots>>,
  clubKey: string,
): { meanFt: number | null; shots: number } {
  const stats = computeProximityByClub(
    shots.map(s => ({
      tournamentId: s.tournamentId,
      generalPlayRoundId: s.generalPlayRoundId,
      round: s.round,
      holeNumber: s.holeNumber,
      shotNumber: s.shotNumber,
      shotType: s.shotType,
      club: s.club,
      lieType: s.lieType,
      missDirection: s.missDirection,
      distanceToPin: s.distanceToPin,
      distanceCarried: s.distanceCarried,
    })),
  );
  const matching = stats.filter(s => s.benchmark?.clubKey === clubKey && s.meanProximityFt !== null);
  if (matching.length === 0) return { meanFt: null, shots: 0 };
  // Weighted mean so different raw labels (e.g. "7i", "7-iron") collapse correctly.
  let totalShots = 0;
  let weightedSum = 0;
  for (const m of matching) {
    totalShots += m.shots;
    weightedSum += (m.meanProximityFt ?? 0) * m.shots;
  }
  return {
    meanFt: totalShots > 0 ? Math.round((weightedSum / totalShots) * 10) / 10 : null,
    shots: totalShots,
  };
}

// 'tip'/'manual' = which source dominated for this (player, club);
// 'mixed' = tied non-zero (excluded from cohort means); 'none' = no practice.
type PracticeCohortLabel = 'tip' | 'manual' | 'mixed' | 'none';

interface PracticeCohortClubRow {
  clubKey: string;
  tipDrivenSessions: number;
  manualSessions: number;
  currentMeanProximityFt: number | null;
  priorMeanProximityFt: number | null;
  /** prior − current (ft); positive = closer to pin; null = insufficient data. */
  proximityImprovementFt: number | null;
  shotsCurrent: number;
  shotsPrior: number;
  cohort: PracticeCohortLabel;
}

function classifyCohort(tip: number, manual: number): PracticeCohortLabel {
  if (tip === 0 && manual === 0) return 'none';
  if (tip > manual) return 'tip';
  if (manual > tip) return 'manual';
  return 'mixed';
}

// GET /portal/practice/cohort-stats — per-player tip-driven vs manual split
router.get("/portal/practice/cohort-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = parseQueryDate(req.query.from) ?? defaultFrom;
  const to = parseQueryDate(req.query.to) ?? now;
  if (from.getTime() >= to.getTime()) {
    res.status(400).json({ error: "`from` must be before `to`" });
    return;
  }
  const clubKeyFilter = parseQueryClubKey(req.query.clubKey);

  // Pull the user's practice sessions in the window; when `clubKey` is
  // provided every metric (summary + per-club rows) is scoped to that
  // club so the API contract matches the filter.
  const sessions = await db.select({
    id: practiceSessionsTable.id,
    sessionDate: practiceSessionsTable.sessionDate,
    durationMinutes: practiceSessionsTable.durationMinutes,
    source: practiceSessionsTable.source,
    clubKey: practiceSessionsTable.clubKey,
    practiceDistanceYards: practiceSessionsTable.practiceDistanceYards,
  }).from(practiceSessionsTable)
    .where(and(
      eq(practiceSessionsTable.userId, userId),
      gte(practiceSessionsTable.sessionDate, from),
      sql`${practiceSessionsTable.sessionDate} <= ${to}`,
    ));

  let tipDrivenSessions = 0;
  let manualSessions = 0;
  let tipDrivenMinutes = 0;
  let manualMinutes = 0;
  const tipClubKeySet = new Set<string>();
  const sessionsByClubKey = new Map<string, { tip: number; manual: number }>();

  for (const s of sessions) {
    if (clubKeyFilter && s.clubKey !== clubKeyFilter) continue;
    const isTip = s.source === "coaching_tip";
    if (isTip) {
      tipDrivenSessions += 1;
      tipDrivenMinutes += s.durationMinutes ?? 0;
      if (s.clubKey) tipClubKeySet.add(s.clubKey);
    } else {
      manualSessions += 1;
      manualMinutes += s.durationMinutes ?? 0;
    }
    if (s.clubKey) {
      const bucket = sessionsByClubKey.get(s.clubKey) ?? { tip: 0, manual: 0 };
      if (isTip) bucket.tip += 1; else bucket.manual += 1;
      sessionsByClubKey.set(s.clubKey, bucket);
    }
  }

  // Active "Work on This Club" tips for the current window — drives the
  // tip-shown vs tip-logged conversion rate. We mirror the windowing used
  // by /portal/player/proximity-by-club so the conversion number lines up
  // with what the player actually saw on the Stats page.
  const allShots = await fetchAllUserShots(userId);
  const currentShots = allShots.filter(s => {
    const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
    return t >= from.getTime() && t <= to.getTime();
  });
  const windowDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
  const priorFrom = new Date(from.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const priorShots = allShots.filter(s => {
    const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
    return t >= priorFrom.getTime() && t < from.getTime();
  });
  const activeTips = computeProximityCoachingTips(
    computeProximityByClub(currentShots),
    {
      maxTips: 5,
      previousStats: computeProximityByClub(priorShots),
      previousWindowLabel: `prev ${windowDays}d`,
    },
  );
  const activeTipClubKeys = activeTips
    .map(t => t.clubKey)
    .filter(k => !clubKeyFilter || k === clubKeyFilter);
  const tipsConverted = activeTipClubKeys.filter(k => tipClubKeySet.has(k)).length;

  // Seed per-club rows from every club the player logged practice for
  // in this window (so manual-only clubs are represented), plus active
  // tips (so an ignored tip still surfaces with prior/current context),
  // plus the explicit clubKey filter if it would otherwise drop out.
  const clubKeysToReport = new Set<string>();
  for (const k of sessionsByClubKey.keys()) clubKeysToReport.add(k);
  for (const k of activeTipClubKeys) clubKeysToReport.add(k);
  if (clubKeyFilter) clubKeysToReport.add(clubKeyFilter);

  const byClub: PracticeCohortClubRow[] = [];
  for (const ck of clubKeysToReport) {
    if (clubKeyFilter && ck !== clubKeyFilter) continue;
    const sessionsForClub = sessionsByClubKey.get(ck) ?? { tip: 0, manual: 0 };
    const cur = meanProximityFtForClubKey(currentShots, ck);
    const prev = meanProximityFtForClubKey(priorShots, ck);
    let proximityImprovementFt: number | null = null;
    if (cur.meanFt !== null && prev.meanFt !== null) {
      proximityImprovementFt = Math.round((prev.meanFt - cur.meanFt) * 10) / 10;
    }
    byClub.push({
      clubKey: ck,
      tipDrivenSessions: sessionsForClub.tip,
      manualSessions: sessionsForClub.manual,
      currentMeanProximityFt: cur.meanFt,
      priorMeanProximityFt: prev.meanFt,
      proximityImprovementFt,
      shotsCurrent: cur.shots,
      shotsPrior: prev.shots,
      cohort: classifyCohort(sessionsForClub.tip, sessionsForClub.manual),
    });
  }
  // Best improvement first; rows with no comparison sink to the bottom.
  byClub.sort((a, b) => {
    const ai = a.proximityImprovementFt ?? -Infinity;
    const bi = b.proximityImprovementFt ?? -Infinity;
    return bi - ai;
  });

  // A/B summary: mean proximity improvement (ft) for tip-cohort vs manual-cohort clubs.
  const tipCohortRows = byClub.filter(r => r.cohort === 'tip' && r.proximityImprovementFt !== null);
  const manualCohortRows = byClub.filter(r => r.cohort === 'manual' && r.proximityImprovementFt !== null);
  const meanImprovement = (rows: PracticeCohortClubRow[]): number | null => {
    if (rows.length === 0) return null;
    const sum = rows.reduce((acc, r) => acc + (r.proximityImprovementFt ?? 0), 0);
    return Math.round((sum / rows.length) * 10) / 10;
  };

  res.json({
    windowStart: from.toISOString(),
    windowEnd: to.toISOString(),
    windowDays,
    clubKeyFilter,
    summary: {
      tipDrivenSessions,
      manualSessions,
      totalSessions: tipDrivenSessions + manualSessions,
      tipDrivenMinutes,
      manualMinutes,
      activeTipClubKeys,
      tipsConverted,
      conversionRate: activeTipClubKeys.length > 0
        ? Math.round((tipsConverted / activeTipClubKeys.length) * 1000) / 10
        : null,
      tipCohortClubs: tipCohortRows.length,
      manualCohortClubs: manualCohortRows.length,
      tipCohortAvgImprovementFt: meanImprovement(tipCohortRows),
      manualCohortAvgImprovementFt: meanImprovement(manualCohortRows),
    },
    byClub,
  });
});

// GET /portal/admin/practice/cohort-stats — org-wide tip-driven vs manual.
// Restricted to org admins / tournament directors / super admins so private
// player practice data isn't exposed to peers. Aggregates *only* the
// requesting admin's organisation (super admins may pass `?orgId=` to
// scope to another org).
router.get("/portal/admin/practice/cohort-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const user = req.user as { id: number; role?: string; organizationId?: number | null };

  // Super admins may pass ?orgId=; others use their session org.
  const queryOrgRaw = typeof req.query.orgId === "string" ? parseInt(req.query.orgId, 10) : NaN;
  const targetOrgId = user.role === "super_admin" && Number.isFinite(queryOrgRaw)
    ? queryOrgRaw
    : (user.organizationId ?? null);
  if (targetOrgId === null) {
    res.status(400).json({ error: "No organization context" });
    return;
  }
  const ok = await requireOrgAdmin(req, res, targetOrgId);
  if (!ok) return;

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = parseQueryDate(req.query.from) ?? defaultFrom;
  const to = parseQueryDate(req.query.to) ?? now;
  if (from.getTime() >= to.getTime()) {
    res.status(400).json({ error: "`from` must be before `to`" });
    return;
  }
  const clubKeyFilter = parseQueryClubKey(req.query.clubKey);

  // One query, JS-side bucketing for volumes / per-club / timeline / per-player.
  const sessionRows = await db.select({
    id: practiceSessionsTable.id,
    userId: practiceSessionsTable.userId,
    sessionDate: practiceSessionsTable.sessionDate,
    durationMinutes: practiceSessionsTable.durationMinutes,
    source: practiceSessionsTable.source,
    clubKey: practiceSessionsTable.clubKey,
  }).from(practiceSessionsTable)
    .where(and(
      eq(practiceSessionsTable.organizationId, targetOrgId),
      gte(practiceSessionsTable.sessionDate, from),
      sql`${practiceSessionsTable.sessionDate} <= ${to}`,
    ));

  let tipDrivenSessions = 0;
  let manualSessions = 0;
  const distinctTipPlayers = new Set<number>();
  const distinctManualPlayers = new Set<number>();
  // clubKey → { tip, manual }
  const clubBuckets = new Map<string, { tip: number; manual: number }>();
  // ISO week key (YYYY-Www) → { tip, manual }
  const weekBuckets = new Map<string, { tip: number; manual: number }>();
  // userId → { tip, manual, distinctTipClubs }
  const playerBuckets = new Map<number, { tip: number; manual: number; tipClubs: Set<string> }>();

  for (const s of sessionRows) {
    if (clubKeyFilter && s.clubKey !== clubKeyFilter) continue;
    const isTip = s.source === "coaching_tip";
    if (isTip) tipDrivenSessions += 1; else manualSessions += 1;
    if (s.userId !== null) {
      if (isTip) distinctTipPlayers.add(s.userId); else distinctManualPlayers.add(s.userId);
      const pb = playerBuckets.get(s.userId) ?? { tip: 0, manual: 0, tipClubs: new Set<string>() };
      if (isTip) {
        pb.tip += 1;
        if (s.clubKey) pb.tipClubs.add(s.clubKey);
      } else {
        pb.manual += 1;
      }
      playerBuckets.set(s.userId, pb);
    }
    if (s.clubKey) {
      const cb = clubBuckets.get(s.clubKey) ?? { tip: 0, manual: 0 };
      if (isTip) cb.tip += 1; else cb.manual += 1;
      clubBuckets.set(s.clubKey, cb);
    }
    // Week bucket — UTC ISO date Monday 00:00 of the session week.
    const d = new Date(s.sessionDate);
    const dayOfWeek = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayOfWeek));
    const weekKey = monday.toISOString().slice(0, 10);
    const wb = weekBuckets.get(weekKey) ?? { tip: 0, manual: 0 };
    if (isTip) wb.tip += 1; else wb.manual += 1;
    weekBuckets.set(weekKey, wb);
  }

  const timeline = Array.from(weekBuckets.entries())
    .map(([weekStart, v]) => ({ weekStart, tipDrivenSessions: v.tip, manualSessions: v.manual }))
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  // Resolve player display names for the per-player rows.
  const playerIds = Array.from(playerBuckets.keys());
  const playerNameRows = playerIds.length > 0
    ? await db.select({
        id: appUsersTable.id,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
        email: appUsersTable.email,
      }).from(appUsersTable).where(inArray(appUsersTable.id, playerIds))
    : [];
  const nameById = new Map<number, string>();
  for (const r of playerNameRows) {
    nameById.set(r.id, r.displayName ?? r.username ?? r.email ?? `User #${r.id}`);
  }

  // Proximity-gain A/B per (player, club) — current vs equal-length prior window.
  const windowMs = to.getTime() - from.getTime();
  const priorFrom = new Date(from.getTime() - windowMs);

  const playerClubSessions = new Map<string, { tip: number; manual: number }>();
  for (const s of sessionRows) {
    if (!s.userId || !s.clubKey) continue;
    const key = `${s.userId}::${s.clubKey}`;
    const bucket = playerClubSessions.get(key) ?? { tip: 0, manual: 0 };
    if (s.source === 'coaching_tip') bucket.tip += 1; else bucket.manual += 1;
    playerClubSessions.set(key, bucket);
  }

  // clubKey → cohort → { sumImprovement, count }
  type CohortAccum = { sum: number; count: number };
  const clubProximityByCohort = new Map<string, { tip: CohortAccum; manual: CohortAccum }>();
  let orgTipAccum: CohortAccum = { sum: 0, count: 0 };
  let orgManualAccum: CohortAccum = { sum: 0, count: 0 };

  // Sequential per-player to keep DB pool pressure low; org sizes stay small.
  for (const userId of playerIds) {
    const shots = await fetchAllUserShots(userId);
    const currentShots = shots.filter(s => {
      const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
      return t >= from.getTime() && t <= to.getTime();
    });
    const priorShots = shots.filter(s => {
      const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
      return t >= priorFrom.getTime() && t < from.getTime();
    });

    // Determine the set of (player, clubKey) rows we care about: any
    // club this player logged practice for (so the cohort assignment
    // exists). Honours the global clubKeyFilter if set.
    const playerClubKeys = new Set<string>();
    for (const k of playerClubSessions.keys()) {
      if (!k.startsWith(`${userId}::`)) continue;
      const ck = k.slice(`${userId}::`.length);
      if (clubKeyFilter && ck !== clubKeyFilter) continue;
      playerClubKeys.add(ck);
    }
    if (playerClubKeys.size === 0) continue;

    for (const ck of playerClubKeys) {
      const bucket = playerClubSessions.get(`${userId}::${ck}`)!;
      const cohort = classifyCohort(bucket.tip, bucket.manual);
      if (cohort !== 'tip' && cohort !== 'manual') continue; // skip mixed/none
      const cur = meanProximityFtForClubKey(currentShots, ck);
      const prev = meanProximityFtForClubKey(priorShots, ck);
      if (cur.meanFt === null || prev.meanFt === null) continue;
      const improvement = Math.round((prev.meanFt - cur.meanFt) * 10) / 10;
      const slot = clubProximityByCohort.get(ck) ?? {
        tip: { sum: 0, count: 0 },
        manual: { sum: 0, count: 0 },
      };
      slot[cohort].sum += improvement;
      slot[cohort].count += 1;
      clubProximityByCohort.set(ck, slot);
      if (cohort === 'tip') {
        orgTipAccum = { sum: orgTipAccum.sum + improvement, count: orgTipAccum.count + 1 };
      } else {
        orgManualAccum = { sum: orgManualAccum.sum + improvement, count: orgManualAccum.count + 1 };
      }
    }
  }

  const byClub = Array.from(clubBuckets.entries())
    .map(([clubKey, v]) => {
      const px = clubProximityByCohort.get(clubKey);
      const tipMean = px && px.tip.count > 0
        ? Math.round((px.tip.sum / px.tip.count) * 10) / 10
        : null;
      const manualMean = px && px.manual.count > 0
        ? Math.round((px.manual.sum / px.manual.count) * 10) / 10
        : null;
      return {
        clubKey,
        tipDrivenSessions: v.tip,
        manualSessions: v.manual,
        // Players whose practice for this club was dominated by tip / manual.
        tipCohortPlayers: px?.tip.count ?? 0,
        manualCohortPlayers: px?.manual.count ?? 0,
        // Mean proximity improvement (ft); positive = closer to pin.
        tipCohortMeanImprovementFt: tipMean,
        manualCohortMeanImprovementFt: manualMean,
      };
    })
    .sort((a, b) => b.tipDrivenSessions - a.tipDrivenSessions);

  const orgTipMean = orgTipAccum.count > 0
    ? Math.round((orgTipAccum.sum / orgTipAccum.count) * 10) / 10
    : null;
  const orgManualMean = orgManualAccum.count > 0
    ? Math.round((orgManualAccum.sum / orgManualAccum.count) * 10) / 10
    : null;

  const byPlayer = Array.from(playerBuckets.entries())
    .map(([userId, v]) => {
      const total = v.tip + v.manual;
      return {
        userId,
        displayName: nameById.get(userId) ?? `User #${userId}`,
        tipDrivenSessions: v.tip,
        manualSessions: v.manual,
        distinctTipClubKeys: Array.from(v.tipClubs).sort(),
        // Of every session this player logged, what fraction came from a
        // coaching tip? Lets admins spot players who engage with tips
        // versus those who only ever log ad-hoc range time.
        tipShareOfPracticePct: total > 0 ? Math.round((v.tip / total) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => b.tipDrivenSessions - a.tipDrivenSessions || b.manualSessions - a.manualSessions);

  res.json({
    organizationId: targetOrgId,
    windowStart: from.toISOString(),
    windowEnd: to.toISOString(),
    clubKeyFilter,
    summary: {
      tipDrivenSessions,
      manualSessions,
      totalSessions: tipDrivenSessions + manualSessions,
      distinctTipPlayers: distinctTipPlayers.size,
      distinctManualPlayers: distinctManualPlayers.size,
      tipShareOfPracticePct: (tipDrivenSessions + manualSessions) > 0
        ? Math.round((tipDrivenSessions / (tipDrivenSessions + manualSessions)) * 1000) / 10
        : null,
      // Org A/B headline: mean proximity improvement (ft) per (player, club).
      tipCohortPlayerClubs: orgTipAccum.count,
      manualCohortPlayerClubs: orgManualAccum.count,
      tipCohortAvgImprovementFt: orgTipMean,
      manualCohortAvgImprovementFt: orgManualMean,
    },
    byClub,
    timeline,
    byPlayer,
  });
});

// GET /portal/my-prizes — all prize awards for the authenticated player across tournaments
router.get("/portal/my-prizes", async (req: Request, res: Response) => {
  if (!req.user) { { res.status(401).json({ error: "Unauthorized" }); return; } }
  const userId = req.user.id;
  const [appUser] = await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, userId));
  const userEmail = appUser?.email && appUser.email.trim() !== "" ? appUser.email : null;

  // Find all player records for this user — only match email when it is non-empty to avoid over-matching
  const playerRecords = await db
    .select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(
      userEmail
        ? sql`${playersTable.userId} = ${userId} OR ${playersTable.email} = ${userEmail}`
        : eq(playersTable.userId, userId)
    );

  if (playerRecords.length === 0) { { res.json([]); return; } }
  const playerIds = playerRecords.map(p => p.id);

  // Match awards strictly by playerId to avoid cross-user data leakage.
  // Manual awards not linked to a player record (playerId IS NULL) are admin-only visible and
  // do not surface here — this is intentional for security (name-only matching is unsafe).
  const awardsWhere = inArray(prizeAwardsTable.playerId, playerIds);

  const awards = await db
    .select({
      awardId: prizeAwardsTable.id,
      categoryName: prizeCategoriesTable.name,
      description: prizeCategoriesTable.description,
      awardAmount: prizeAwardsTable.awardAmount,
      awardCurrency: prizeAwardsTable.awardCurrency,
      categoryValue: prizeCategoriesTable.prizeValue,
      categoryCurrency: prizeCategoriesTable.currency,
      notes: prizeAwardsTable.notes,
      awardedAt: prizeAwardsTable.awardedAt,
      tournamentId: prizeAwardsTable.tournamentId,
      tournamentName: tournamentsTable.name,
    })
    .from(prizeAwardsTable)
    .innerJoin(prizeCategoriesTable, eq(prizeAwardsTable.prizeCategoryId, prizeCategoriesTable.id))
    .innerJoin(tournamentsTable, eq(prizeAwardsTable.tournamentId, tournamentsTable.id))
    .where(awardsWhere)
    .orderBy(desc(prizeAwardsTable.awardedAt));

  res.json(awards.map(a => ({
    awardId: a.awardId,
    categoryName: a.categoryName,
    description: a.description ?? null,
    prizeValue: a.awardAmount ? Number(a.awardAmount) : (a.categoryValue ? Number(a.categoryValue) : null),
    currency: a.awardCurrency ?? a.categoryCurrency,
    notes: a.notes ?? null,
    awardedAt: a.awardedAt,
    tournamentId: a.tournamentId,
    tournamentName: a.tournamentName,
  })));
});

// GET /api/portal/feed — social activity feed for org members
router.get("/portal/feed", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;

  const orgId = req.user!.organizationId;
  if (!orgId) { { res.json([]); return; } }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  type FeedItem = {
    id: string;
    type: "scoring_event" | "achievement" | "media" | "round_complete";
    playerName: string;
    profileImage: string | null;
    title: string;
    subtitle: string | null;
    tournamentId: number | null;
    tournamentName: string | null;
    occurredAt: string;
    meta?: Record<string, unknown>;
  };

  const [scoringRows, achievementRows, mediaRows, roundRows] = await Promise.all([
    db
      .select({
        scoreId: scoresTable.id,
        strokes: scoresTable.strokes,
        holeNumber: scoresTable.holeNumber,
        round: scoresTable.round,
        submittedAt: scoresTable.submittedAt,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
        profileImage: appUsersTable.profileImage,
        tournamentId: tournamentsTable.id,
        tournamentName: tournamentsTable.name,
        par: holeDetailsTable.par,
      })
      .from(scoresTable)
      .innerJoin(playersTable, eq(scoresTable.playerId, playersTable.id))
      .innerJoin(
        tournamentsTable,
        and(eq(scoresTable.tournamentId, tournamentsTable.id), eq(tournamentsTable.organizationId, orgId)),
      )
      .leftJoin(appUsersTable, eq(playersTable.userId, appUsersTable.id))
      .leftJoin(
        holeDetailsTable,
        sql`${holeDetailsTable.courseId} = ${tournamentsTable.courseId} AND ${holeDetailsTable.holeNumber} = ${scoresTable.holeNumber}`,
      )
      .where(gte(scoresTable.submittedAt, since))
      .orderBy(desc(scoresTable.submittedAt))
      .limit(300),

    db
      .select({
        achievementId: achievementsTable.id,
        badgeLabel: achievementsTable.badgeLabel,
        badgeIcon: achievementsTable.badgeIcon,
        tournamentId: achievementsTable.tournamentId,
        earnedAt: achievementsTable.earnedAt,
        displayName: appUsersTable.displayName,
        profileImage: appUsersTable.profileImage,
        tournamentName: tournamentsTable.name,
      })
      .from(achievementsTable)
      .innerJoin(appUsersTable, eq(achievementsTable.userId, appUsersTable.id))
      .leftJoin(tournamentsTable, eq(achievementsTable.tournamentId, tournamentsTable.id))
      .where(and(eq(achievementsTable.organizationId, orgId), gte(achievementsTable.earnedAt, since)))
      .orderBy(desc(achievementsTable.earnedAt))
      .limit(50),

    db
      .select({
        mediaId: mediaTable.id,
        caption: mediaTable.caption,
        uploaderName: mediaTable.uploaderName,
        tournamentId: mediaTable.tournamentId,
        createdAt: mediaTable.createdAt,
        profileImage: appUsersTable.profileImage,
        tournamentName: tournamentsTable.name,
      })
      .from(mediaTable)
      .leftJoin(appUsersTable, eq(mediaTable.uploadedByUserId, appUsersTable.id))
      .leftJoin(tournamentsTable, eq(mediaTable.tournamentId, tournamentsTable.id))
      .where(and(eq(mediaTable.organizationId, orgId), eq(mediaTable.approved, true), gte(mediaTable.createdAt, since)))
      .orderBy(desc(mediaTable.createdAt))
      .limit(50),

    db
      .select({
        submissionId: roundSubmissionsTable.id,
        round: roundSubmissionsTable.round,
        status: roundSubmissionsTable.status,
        totalStrokes: roundSubmissionsTable.totalStrokes,
        submittedAt: roundSubmissionsTable.submittedAt,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
        handicap: playersTable.handicapIndex,
        profileImage: appUsersTable.profileImage,
        tournamentId: tournamentsTable.id,
        tournamentName: tournamentsTable.name,
      })
      .from(roundSubmissionsTable)
      .innerJoin(playersTable, eq(roundSubmissionsTable.playerId, playersTable.id))
      .innerJoin(
        tournamentsTable,
        and(eq(roundSubmissionsTable.tournamentId, tournamentsTable.id), eq(tournamentsTable.organizationId, orgId)),
      )
      .leftJoin(appUsersTable, eq(playersTable.userId, appUsersTable.id))
      .where(and(
        sql`${roundSubmissionsTable.status} IN ('submitted', 'verified')`,
        gte(roundSubmissionsTable.submittedAt, since),
      ))
      .orderBy(desc(roundSubmissionsTable.submittedAt))
      .limit(50),
  ]);

  const scoringItems: FeedItem[] = scoringRows
    .filter((row) => {
      const par = row.par ?? 4;
      return row.strokes <= par - 1;
    })
    .map((row) => {
      const par = row.par ?? 4;
      const toPar = row.strokes - par;
      const label =
        row.strokes === 1 ? "Hole-in-One! 🕳️" :
        toPar <= -3 ? "Albatross 🦅🦅🦅" :
        toPar <= -2 ? "Eagle 🦅" : "Birdie 🐦";
      return {
        id: `score-${row.scoreId}`,
        type: "scoring_event" as const,
        playerName: `${row.firstName} ${row.lastName}`,
        profileImage: row.profileImage ?? null,
        title: `${row.firstName} ${row.lastName} scored a ${label}`,
        subtitle: `Hole ${row.holeNumber} · Round ${row.round}`,
        tournamentId: row.tournamentId,
        tournamentName: row.tournamentName,
        occurredAt: row.submittedAt.toISOString(),
        meta: { holeNumber: row.holeNumber, strokes: row.strokes, par, toPar },
      };
    });

  const achievementItems: FeedItem[] = achievementRows.map((row) => ({
    id: `achievement-${row.achievementId}`,
    type: "achievement" as const,
    playerName: row.displayName ?? "A member",
    profileImage: row.profileImage ?? null,
    title: `${row.displayName ?? "A member"} earned "${row.badgeLabel}" ${row.badgeIcon}`,
    subtitle: row.tournamentName ?? null,
    tournamentId: row.tournamentId ?? null,
    tournamentName: row.tournamentName ?? null,
    occurredAt: row.earnedAt.toISOString(),
  }));

  const mediaItems: FeedItem[] = mediaRows.map((row) => ({
    id: `media-${row.mediaId}`,
    type: "media" as const,
    playerName: row.uploaderName ?? "A member",
    profileImage: row.profileImage ?? null,
    title: row.caption ?? `${row.uploaderName ?? "A member"} posted a photo`,
    subtitle: row.tournamentName ?? null,
    tournamentId: row.tournamentId ?? null,
    tournamentName: row.tournamentName ?? null,
    occurredAt: row.createdAt.toISOString(),
  }));

  const roundItems: FeedItem[] = roundRows.map((row) => {
    const verified = row.status === "verified";
    const label = verified ? "completed & verified" : "completed";
    const gross = row.totalStrokes ?? null;
    const net = gross != null && row.handicap != null ? gross - Number(row.handicap) : null;
    const scoreText = gross != null
      ? net != null
        ? `${gross} gross · ${net} net`
        : `${gross} strokes gross`
      : null;
    return {
      id: `round-${row.submissionId}`,
      type: "round_complete" as const,
      playerName: `${row.firstName} ${row.lastName}`,
      profileImage: row.profileImage ?? null,
      title: `${row.firstName} ${row.lastName} ${label} Round ${row.round}`,
      subtitle: scoreText,
      tournamentId: row.tournamentId,
      tournamentName: row.tournamentName,
      occurredAt: row.submittedAt.toISOString(),
      meta: { round: row.round, totalStrokes: gross, netStrokes: net, status: row.status },
    };
  });

  const allItems = [...scoringItems, ...achievementItems, ...mediaItems, ...roundItems]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 50);

  res.json(allItems);
});

// ─── WHS State & Score Records (for player profile) ─────────────────────────

router.get("/portal/whs/state", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const orgId = req.query.organizationId ? parseInt(String(req.query.organizationId)) : null;
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }

  const { getWhsPlayerState, getRecentScoreRecords } = await import("../lib/whs-recalc");
  const [state, records] = await Promise.all([
    getWhsPlayerState(userId, orgId),
    getRecentScoreRecords(userId, orgId, 20),
  ]);
  if (!state) { { res.json(null); return; } }

  const hiNum = state.currentHandicapIndex != null ? parseFloat(String(state.currentHandicapIndex)) : null;
  const lowNum = state.lowHandicapIndex != null ? parseFloat(String(state.lowHandicapIndex)) : null;
  const drift = hiNum != null && lowNum != null ? hiNum - lowNum : 0;

  res.json({
    handicapIndex: state.currentHandicapIndex,
    lowHandicapIndex: state.lowHandicapIndex,
    scoringRecordCount: records.length,
    phase: state.establishmentPhase ?? 0,
    softCapApplied: drift > 3,
    hardCapApplied: drift > 5,
    lastCalculatedAt: state.lastRecalcAt,
    establishedAt: state.lowHandicapIndexDate,
    eligible: !state.isProvisional || records.length >= 1,
  });
});

router.get("/portal/whs/records", async (req: Request, res: Response) => {
  const userId = getPortalUserId(req);
  if (!userId) { { res.status(401).json({ error: "Unauthorized" }); return; } }

  const orgId = req.query.organizationId ? parseInt(String(req.query.organizationId)) : null;
  if (!orgId) { { res.status(400).json({ error: "organizationId is required" }); return; } }

  const limit = req.query.limit ? parseInt(String(req.query.limit)) : 60;
  const { getRecentScoreRecords } = await import("../lib/whs-recalc");
  const records = await getRecentScoreRecords(userId, orgId, limit);

  // Normalize field names to match frontend expectations
  res.json(records.map(r => ({
    id: r.id,
    differential: r.finalDifferential,
    grossScore: r.grossScore,
    adjustedGrossScore: r.adjustedGrossScore,
    courseRating: r.courseRating,
    slopeRating: r.slopeRating,
    holesPlayed: r.holesPlayed,
    is9Hole: r.is9Hole,
    playedAt: r.playedAt,
    source: r.sourceType ?? "general_play",
    isExceptional: r.esrAdjustment != null && Number(r.esrAdjustment) > 0,
    usedForHandicap: true,
    courseName: (r as Record<string, unknown>).courseName ?? null,
    tournamentName: (r as Record<string, unknown>).tournamentName ?? null,
    markerName: r.markerName,
    handicapIndexAfter: r.handicapIndexAfter,
    pccAdjustment: r.pccAdjustment,
    esrAdjustment: r.esrAdjustment,
  })));
});

// ─── GET /api/organizations/:orgId/tournaments/:tournamentId/signing-status ────
// Admin: scorecard signing status matrix for all players in a tournament round
router.get("/organizations/:orgId/tournaments/:tournamentId/signing-status", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (!await requireOrgAdmin(req, res, orgId)) return;

  const rows = await db
    .select({
      playerId: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
      submissionId: roundSubmissionsTable.id,
      round: roundSubmissionsTable.round,
      status: roundSubmissionsTable.status,
      totalStrokes: roundSubmissionsTable.totalStrokes,
      submittedAt: roundSubmissionsTable.submittedAt,
      reviewedAt: roundSubmissionsTable.reviewedAt,
      rejectionReason: roundSubmissionsTable.rejectionReason,
      markerCode: roundSubmissionsTable.markerCode,
    })
    .from(playersTable)
    .leftJoin(
      roundSubmissionsTable,
      eq(roundSubmissionsTable.playerId, playersTable.id)
    )
    .where(eq(playersTable.tournamentId, tournamentId))
    .orderBy(playersTable.firstName, playersTable.lastName);

  res.json(rows);
});

// ─── PIN POSITIONS (TOURNAMENT SCORING) ────────────────────────────────────────
// ── Pin position ownership helper: verify the authenticated user owns this playerId ──
// Optional tournamentId: also validates that the player is registered for that tournament.
async function verifyPinOwnership(req: Request, res: Response, playerId: number, tournamentId?: number): Promise<boolean> {
  const [player] = await db.select({ userId: playersTable.userId, email: playersTable.email, playerTournamentId: playersTable.tournamentId })
    .from(playersTable).where(eq(playersTable.id, playerId));
  if (!player) { res.status(404).json({ error: "Player not found" }); return false; }
  const userEmail = req.user!.email;
  const userId = req.user!.id;
  const owned = (player.userId != null && player.userId === userId) || (player.email != null && player.email === userEmail);
  if (!owned) { res.status(403).json({ error: "Forbidden" }); return false; }
  if (tournamentId !== undefined && player.playerTournamentId !== tournamentId) {
    res.status(403).json({ error: "Player is not registered for this tournament" }); return false;
  }
  return true;
}

// GET /api/portal/tournaments/:tournamentId/players/:playerId/rounds/:round/pin-positions
router.get("/portal/tournaments/:tournamentId/players/:playerId/rounds/:round/pin-positions", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const roundNumber = parseInt(String((req.params as Record<string, string>).round));
  if (isNaN(tournamentId) || isNaN(playerId) || isNaN(roundNumber)) {
    res.status(400).json({ error: "Invalid parameters" }); return;
  }
  if (!await verifyPinOwnership(req, res, playerId, tournamentId)) return;
  const positions = await db.select()
    .from(holePinPositionsTable)
    .where(and(
      eq(holePinPositionsTable.tournamentId, tournamentId),
      eq(holePinPositionsTable.playerId, playerId),
      eq(holePinPositionsTable.roundNumber, roundNumber),
    ));
  res.json(positions.map(p => ({ holeNumber: p.holeNumber, latOffset: p.latOffset, lngOffset: p.lngOffset })));
});

// PATCH /api/portal/tournaments/:tournamentId/players/:playerId/rounds/:round/hole/:holeNumber/pin
router.patch("/portal/tournaments/:tournamentId/players/:playerId/rounds/:round/hole/:holeNumber/pin", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const roundNumber = parseInt(String((req.params as Record<string, string>).round));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));
  if (isNaN(tournamentId) || isNaN(playerId) || isNaN(roundNumber) || isNaN(holeNumber)) {
    res.status(400).json({ error: "Invalid parameters" }); return;
  }
  if (!await verifyPinOwnership(req, res, playerId, tournamentId)) return;
  const { latOffset, lngOffset } = req.body;
  if (latOffset === undefined || lngOffset === undefined) {
    res.status(400).json({ error: "latOffset and lngOffset are required" }); return;
  }
  // Atomic upsert to avoid race conditions / duplicate rows under concurrent saves
  await db.insert(holePinPositionsTable)
    .values({ tournamentId, playerId, roundNumber, holeNumber, latOffset: String(latOffset), lngOffset: String(lngOffset) })
    .onConflictDoUpdate({
      target: [holePinPositionsTable.tournamentId, holePinPositionsTable.playerId, holePinPositionsTable.roundNumber, holePinPositionsTable.holeNumber],
      set: { latOffset: String(latOffset), lngOffset: String(lngOffset), updatedAt: new Date() },
    });
  res.json({ holeNumber, latOffset, lngOffset });
});

// ─── LOCKER PORTAL ────────────────────────────────────────────────────────────

// GET /api/portal/locker — returns the current member's locker assignment (if any)
router.get("/portal/locker", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const [member] = await db
    .select({ id: clubMembersTable.id, organizationId: clubMembersTable.organizationId })
    .from(clubMembersTable)
    .where(eq(clubMembersTable.userId, userId));

  if (!member) { { res.json(null); return; } }

  const [assignment] = await db
    .select({
      id: lockerAssignmentsTable.id,
      lockerNumber: lockersTable.lockerNumber,
      bay: lockersTable.bay,
      expiryDate: lockerAssignmentsTable.expiryDate,
      startDate: lockerAssignmentsTable.startDate,
      status: lockerAssignmentsTable.status,
      annualFee: lockerAssignmentsTable.annualFee,
      currency: lockerAssignmentsTable.currency,
      paymentStatus: lockerAssignmentsTable.paymentStatus,
      paymentLinkUrl: lockerAssignmentsTable.paymentLinkUrl,
    })
    .from(lockerAssignmentsTable)
    .innerJoin(lockersTable, eq(lockersTable.id, lockerAssignmentsTable.lockerId))
    .where(and(
      eq(lockerAssignmentsTable.memberId, member.id),
      eq(lockerAssignmentsTable.status, "active"),
    ))
    .orderBy(desc(lockerAssignmentsTable.createdAt))
    .limit(1);

  const [waitlistEntry] = await db
    .select({ id: lockerWaitlistTable.id, requestedAt: lockerWaitlistTable.requestedAt, status: lockerWaitlistTable.status })
    .from(lockerWaitlistTable)
    .where(and(
      eq(lockerWaitlistTable.organizationId, member.organizationId),
      eq(lockerWaitlistTable.memberId, member.id),
    ));

  res.json({
    assignment: assignment ?? null,
    waitlistEntry: waitlistEntry ?? null,
  });
});

// POST /api/portal/locker/join-waitlist — let a member add themselves to the waitlist
router.post("/portal/locker/join-waitlist", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const [member] = await db
    .select({ id: clubMembersTable.id, organizationId: clubMembersTable.organizationId })
    .from(clubMembersTable)
    .where(eq(clubMembersTable.userId, userId));

  if (!member) { { res.status(404).json({ error: "No club membership found" }); return; } }

  const [existing] = await db
    .select({ id: lockerWaitlistTable.id })
    .from(lockerWaitlistTable)
    .where(and(
      eq(lockerWaitlistTable.organizationId, member.organizationId),
      eq(lockerWaitlistTable.memberId, member.id),
    ));

  if (existing) { { res.status(409).json({ error: "You are already on the waitlist" }); return; } }

  const [entry] = await db.insert(lockerWaitlistTable).values({
    organizationId: member.organizationId,
    memberId: member.id,
  }).returning();

  res.status(201).json(entry);
});

// ─── AI CADDIE ────────────────────────────────────────────────────────────────

// GET /api/portal/caddie/recommend
// Returns a ranked club shortlist + aim-point + rationale based on the player's
// shot-tracked dispersion, manual overrides, weather and miss-bias.
// Query params:
//   distanceYards          (required) yards from current position to pin
//   windSpeed              mph
//   windDirection          deg (meteorological — wind is FROM this bearing)
//   windBearing            deg (direction player is hitting TOWARD)
//   pinLat                 optional, used to compute aim lat/lng offset
//   bearingToPin           optional, deg from player → pin
//   tournamentId, generalPlayRoundId, round, holeNumber  optional context for persistence
//   persist=false          skip recording the recommendation event
router.get("/portal/caddie/recommend", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  // Task #469 — AI caddie recommendations are gated on the member's "ai" consent.
  if (!await requireConsent(req, res, "ai")) return;

  const distanceYards = parseFloat(req.query.distanceYards as string || "0");
  const windSpeed = parseFloat(req.query.windSpeed as string || "0");
  const windDirection = parseFloat(req.query.windDirection as string || "0");
  const windBearing = parseFloat(req.query.windBearing as string || "0");
  const pinLat = req.query.pinLat ? parseFloat(req.query.pinLat as string) : null;
  const bearingToPin = req.query.bearingToPin ? parseFloat(req.query.bearingToPin as string) : null;
  const elevationRaw = req.query.elevationDeltaYards ? parseFloat(req.query.elevationDeltaYards as string) : 0;
  // Clamp to ±100y so a malformed query string can't dominate the engine.
  const elevationDeltaYards = Number.isFinite(elevationRaw) ? Math.max(-100, Math.min(100, elevationRaw)) : 0;
  const lieType = typeof req.query.lieType === "string" && req.query.lieType.length > 0 ? (req.query.lieType as string) : null;
  const tournamentId = req.query.tournamentId ? parseInt(req.query.tournamentId as string, 10) : null;
  const generalPlayRoundId = req.query.generalPlayRoundId ? parseInt(req.query.generalPlayRoundId as string, 10) : null;
  const round = req.query.round ? parseInt(req.query.round as string, 10) : 1;
  const holeNumber = req.query.holeNumber ? parseInt(req.query.holeNumber as string, 10) : null;
  const persist = req.query.persist !== "false";

  if (distanceYards <= 0) {
    res.status(400).json({ error: "distanceYards must be > 0" });
    return;
  }

  // Fetch manual carry overrides (highest precedence).
  const manualRows = await db.select().from(clubCarryDistancesTable).where(eq(clubCarryDistancesTable.userId, userId));
  const manualMap = new Map(manualRows.map(r => [r.club, r.carryYards]));

  // Resolve the user's player ids and aggregate their tracked shot history.
  const userPlayers = await db.select({ id: playersTable.id, handicapIndex: playersTable.handicapIndex }).from(playersTable).where(eq(playersTable.userId, userId));
  const playerIds = userPlayers.map(p => p.id);
  const handicap = userPlayers.find(p => p.handicapIndex != null)?.handicapIndex
    ? parseFloat(userPlayers.find(p => p.handicapIndex != null)!.handicapIndex as unknown as string)
    : null;

  let aggregateRows: Array<{ club: string; avgCarry: number | null; stddevCarry: number | null; count: number }> = [];
  let missBiasLateralYards = 0;
  if (playerIds.length > 0) {
    const rows = await db.select({
      club: shotsTable.club,
      avgCarry: avg(shotsTable.distanceCarried),
      stddevCarry: sql<string | null>`STDDEV_SAMP(${shotsTable.distanceCarried})`,
      cnt: count(shotsTable.id),
    })
      .from(shotsTable)
      .where(and(
        inArray(shotsTable.playerId, playerIds),
        sql`${shotsTable.club} IS NOT NULL`,
        sql`${shotsTable.distanceCarried} IS NOT NULL`,
      ))
      .groupBy(shotsTable.club);
    aggregateRows = rows
      .filter(r => r.club != null)
      .map(r => ({
        club: r.club as string,
        avgCarry: r.avgCarry != null ? parseFloat(r.avgCarry as string) : null,
        stddevCarry: r.stddevCarry != null ? parseFloat(r.stddevCarry as string) : null,
        count: Number(r.cnt),
      }));

    // Lateral miss bias from tracked approach shots.
    const missRows = await db.select({
      missDirection: shotsTable.missDirection,
      cnt: count(shotsTable.id),
    })
      .from(shotsTable)
      .where(and(
        inArray(shotsTable.playerId, playerIds),
        sql`${shotsTable.shotType} = 'approach'`,
        sql`${shotsTable.missDirection} IS NOT NULL`,
      ))
      .groupBy(shotsTable.missDirection);
    let leftCount = 0, rightCount = 0;
    for (const r of missRows) {
      const dir = (r.missDirection ?? "").toLowerCase();
      if (dir.includes("left")) leftCount += Number(r.cnt);
      if (dir.includes("right")) rightCount += Number(r.cnt);
    }
    const total = leftCount + rightCount;
    if (total >= 5) {
      // Map the imbalance to ~0..6 yards of lateral bias.
      const skew = (rightCount - leftCount) / total; // -1..+1
      missBiasLateralYards = skew * 6;
    }
  }

  // Build the per-club stats list (shot-tracked merged with manual overrides).
  let clubStats: ClubStat[] = buildClubStatsFromAggregates(aggregateRows, manualMap, handicap);
  if (clubStats.length === 0) clubStats = fallbackClubStats(handicap);

  // Per-(club, lie) acceptance rate from this player's prior recommendations
  // (recommended_club + lie_type + accepted flag). Drives the personalisation
  // bias: per-club for the broad signal, per-lie so consistent overrides from
  // a specific lie (e.g. always one more club from the bunker) sway the model.
  const acceptanceByClub: Record<string, number> = {};
  const acceptanceByLie: Record<string, Record<string, number>> = {};
  try {
    const accRows = await db.select({
      club: caddieRecommendationsTable.recommendedClub,
      lie: caddieRecommendationsTable.lieType,
      total: count(caddieRecommendationsTable.id),
      accepted: sql<string>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = true THEN 1 ELSE 0 END)`,
    })
      .from(caddieRecommendationsTable)
      .where(and(
        eq(caddieRecommendationsTable.userId, userId),
        sql`${caddieRecommendationsTable.recommendedClub} IS NOT NULL`,
        sql`${caddieRecommendationsTable.accepted} IS NOT NULL`,
      ))
      .groupBy(caddieRecommendationsTable.recommendedClub, caddieRecommendationsTable.lieType);
    // Aggregate per-club (across all lies) and per-(normalised lie, club).
    // We accumulate counts first so that rows whose raw lie collapses to the
    // same canonical bucket (e.g. "sand" and "bunker" both → "bunker") combine
    // instead of overwriting each other.
    const perClub = new Map<string, { total: number; accepted: number }>();
    const perLieClub = new Map<string, Map<string, { total: number; accepted: number }>>();
    for (const r of accRows) {
      if (!r.club) continue;
      const total = Number(r.total);
      const accepted = Number(r.accepted ?? 0);
      const clubBucket = perClub.get(r.club) ?? { total: 0, accepted: 0 };
      clubBucket.total += total;
      clubBucket.accepted += accepted;
      perClub.set(r.club, clubBucket);
      if (r.lie) {
        const lieKey = lieAdjustmentLabel(r.lie);
        const lieClubMap = perLieClub.get(lieKey) ?? new Map<string, { total: number; accepted: number }>();
        const bucket = lieClubMap.get(r.club) ?? { total: 0, accepted: 0 };
        bucket.total += total;
        bucket.accepted += accepted;
        lieClubMap.set(r.club, bucket);
        perLieClub.set(lieKey, lieClubMap);
      }
    }
    for (const [club, agg] of perClub) {
      if (agg.total >= 3) acceptanceByClub[club] = agg.accepted / agg.total;
    }
    for (const [lieKey, lieClubMap] of perLieClub) {
      for (const [club, agg] of lieClubMap) {
        // Per-lie sample threshold is lower than per-club because lie-specific
        // history is sparser, but still requires more than a single data point.
        if (agg.total >= 2) {
          const lieMap = acceptanceByLie[lieKey] ?? (acceptanceByLie[lieKey] = {});
          lieMap[club] = agg.accepted / agg.total;
        }
      }
    }
  } catch (e) {
    baseLogger.warn({ err: e }, "Failed to load caddie acceptance history");
  }

  // Task #1348 — load the player's proximity-vs-tour gaps so the engine can
  // append a coaching hint to its rationale when the recommended club has a
  // known weakness ("you're 8 ft worse with the 7-iron — aim 5 ft long of
  // pin"). Mirrors what the post-round Shot Analytics panel surfaces, so the
  // on-course advice stays consistent with the post-round callout.
  // Task #1640 — split the proximity history into a recent 30-day window and
  // a same-length 30-day "prior" window (days 30..60 ago) so each tip
  // carries a trend vs the prior window. We keep the windowing identical to
  // /portal/player/proximity-by-club so the on-course "coach" hint and the
  // post-round Shot Analytics callout describe the same comparison and
  // never disagree about whether a player is improving. When the gap is
  // meaningfully closing, the helper flips `caddieHint` to encouragement
  // ("you're closing the gap with the 7-iron — keep it up") so the
  // on-course rationale notices momentum.
  const proximityGapsByClub: Record<string, { gapVsTourFt: number; aimLongFt: number; caddieHint: string }> = {};
  try {
    const currentWindowDays = 30;
    const totalWindowDays = currentWindowDays * 2;
    const now = Date.now();
    const currentSince = new Date(now - currentWindowDays * 24 * 60 * 60 * 1000);
    const priorSince = new Date(now - totalWindowDays * 24 * 60 * 60 * 1000);
    const recentShots = await fetchAllUserShots(userId);
    const currentShots = recentShots.filter(s => {
      const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
      return t >= currentSince.getTime();
    });
    const priorShots = recentShots.filter(s => {
      const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
      return t >= priorSince.getTime() && t < currentSince.getTime();
    });
    const tips = computeProximityCoachingTips(
      computeProximityByClub(currentShots),
      {
        maxTips: 5,
        previousStats: computeProximityByClub(priorShots),
        previousWindowLabel: `prev ${currentWindowDays}d`,
      },
    );
    for (const tip of tips) {
      proximityGapsByClub[tip.club] = {
        gapVsTourFt: tip.gapVsTourFt,
        aimLongFt: tip.aimLongFt,
        caddieHint: tip.caddieHint,
      };
    }
  } catch (e) {
    baseLogger.warn({ err: e }, "Failed to compute proximity coaching tips for caddie");
  }

  const result = caddieRecommend({
    distanceYards,
    windSpeedMph: windSpeed,
    windDirectionDeg: windDirection,
    windBearingDeg: windBearing,
    pinLat,
    bearingToPinDeg: bearingToPin,
    clubStats,
    handicap,
    missBiasLateralYards,
    acceptanceByClub,
    acceptanceByLie,
    elevationDeltaYards,
    lieType,
    proximityGapsByClub,
  });

  // Persist the recommendation event so the override/outcome can feed back.
  let recommendationId: number | null = null;
  if (persist && holeNumber != null) {
    const playerIdForCtx = tournamentId && playerIds.length > 0 ? playerIds[0] : null;
    // Task #1167 — capture the current observed temperature at the course so
    // /portal/player/weather-correlation has a per-round temperature source
    // even when the Open-Meteo archive lags. Resolve course coords from the
    // tournament or general-play round context, then use getWeather() (15-min
    // in-memory cached so repeated recommend calls within a round are free).
    // Task #1347 — capture humidity (% relative) and precipitation (mm last
    // hour) from the same getWeather() call so the correlation endpoint can
    // bucket rounds by muggy / rainy conditions too.
    let temperatureC: number | null = null;
    let humidityPct: number | null = null;
    let precipitationMm: number | null = null;
    try {
      let courseId: number | null = null;
      if (tournamentId) {
        const [t] = await db.select({ courseId: tournamentsTable.courseId })
          .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
        courseId = t?.courseId ?? null;
      } else if (generalPlayRoundId) {
        const [g] = await db.select({ courseId: generalPlayRoundsTable.courseId })
          .from(generalPlayRoundsTable).where(eq(generalPlayRoundsTable.id, generalPlayRoundId));
        courseId = g?.courseId ?? null;
      }
      if (courseId !== null) {
        const [c] = await db.select({ latitude: coursesTable.latitude, longitude: coursesTable.longitude })
          .from(coursesTable).where(eq(coursesTable.id, courseId));
        const lat = c?.latitude !== null && c?.latitude !== undefined ? parseFloat(String(c.latitude)) : NaN;
        const lng = c?.longitude !== null && c?.longitude !== undefined ? parseFloat(String(c.longitude)) : NaN;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const obs = await getWeather(lat, lng);
          if (Number.isFinite(obs.temperature)) {
            temperatureC = Math.round(obs.temperature * 100) / 100;
          }
          if (Number.isFinite(obs.humidity)) {
            humidityPct = Math.round(obs.humidity * 100) / 100;
          }
          if (Number.isFinite(obs.precipitation)) {
            precipitationMm = Math.round(obs.precipitation * 100) / 100;
          }
        }
      }
    } catch (e) {
      baseLogger.warn({ err: e }, "Failed to capture weather for caddie recommendation");
    }
    try {
      const [row] = await db.insert(caddieRecommendationsTable).values({
        userId,
        playerId: playerIdForCtx,
        tournamentId: tournamentId ?? null,
        generalPlayRoundId: generalPlayRoundId ?? null,
        round,
        holeNumber,
        distanceYards: String(distanceYards),
        effectiveYards: String(result.effectiveYards),
        windSpeed: String(windSpeed),
        windDirection: String(windDirection),
        windBearing: String(windBearing),
        // Task #1167 — observed °C at the course at recommendation time.
        temperature: temperatureC !== null ? String(temperatureC) : null,
        // Task #1347 — observed humidity (% relative) and precipitation (mm
        // last hour) at the course at recommendation time so the weather
        // correlation endpoint can bucket rounds by muggy / rainy conditions.
        humidity: humidityPct !== null ? String(humidityPct) : null,
        precipitation: precipitationMm !== null ? String(precipitationMm) : null,
        recommendedClub: result.recommended?.club ?? null,
        alternateClub: result.alternate?.club ?? null,
        rankedClubs: result.rankedClubs,
        rationale: result.rationale,
        aimLatOffset: result.aimLatLngOffset ? String(result.aimLatLngOffset.lat) : null,
        aimLngOffset: result.aimLatLngOffset ? String(result.aimLatLngOffset.lng) : null,
        lateralStddevYards: String(result.lateralStddevYards),
        usingFallback: result.usingFallback,
        // Task #488 — record the elevation/lie inputs the engine adjusted for.
        elevationDeltaYards: String(elevationDeltaYards),
        lieType,
      }).returning({ id: caddieRecommendationsTable.id });
      recommendationId = row?.id ?? null;
    } catch (e) {
      baseLogger.warn({ err: e }, "Failed to persist caddie recommendation");
    }
  }

  res.json({
    recommendationId,
    distanceYards,
    effectiveDistance: result.effectiveYards,
    windAdjustmentYards: result.windAdjustmentYards,
    headwindComponent: result.headwindComponent,
    crosswindComponent: result.crosswindComponent,
    lateralStddevYards: result.lateralStddevYards,
    aimOffsetYards: result.aimOffsetYards,
    aimLatLngOffset: result.aimLatLngOffset,
    rankedClubs: result.rankedClubs,
    recommended: result.recommended ? { club: result.recommended.club, carryYards: result.recommended.carry, stddev: result.recommended.stddev, onGreenProb: result.recommended.onGreenProb, shotCount: result.recommended.shotCount } : null,
    alternate: result.alternate ? { club: result.alternate.club, carryYards: result.alternate.carry, stddev: result.alternate.stddev, onGreenProb: result.alternate.onGreenProb, shotCount: result.alternate.shotCount } : null,
    rationale: result.rationale,
    reasoning: result.rationale.join("; "),
    usingFallback: result.usingFallback,
    missBiasLateralYards: Math.round(missBiasLateralYards * 10) / 10,
    snapshot: result.snapshot,
  });
});

// GET /api/portal/caddie/snapshot
// Returns the player's full caddie model (club stats, manual carries,
// miss-bias, handicap, acceptance history) for offline use during a round.
// The mobile client caches this snapshot and uses it to compute on-device
// recommendations when the network is unreachable.
router.get("/portal/caddie/snapshot", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const manualRows = await db.select().from(clubCarryDistancesTable).where(eq(clubCarryDistancesTable.userId, userId));
  const manualMap = new Map(manualRows.map(r => [r.club, r.carryYards]));

  const userPlayers = await db.select({ id: playersTable.id, handicapIndex: playersTable.handicapIndex }).from(playersTable).where(eq(playersTable.userId, userId));
  const playerIds = userPlayers.map(p => p.id);
  const handicap = userPlayers.find(p => p.handicapIndex != null)?.handicapIndex
    ? parseFloat(userPlayers.find(p => p.handicapIndex != null)!.handicapIndex as unknown as string)
    : null;

  let aggregateRows: Array<{ club: string; avgCarry: number | null; stddevCarry: number | null; count: number }> = [];
  let missBiasLateralYards = 0;
  if (playerIds.length > 0) {
    const rows = await db.select({
      club: shotsTable.club,
      avgCarry: avg(shotsTable.distanceCarried),
      stddevCarry: sql<string | null>`STDDEV_SAMP(${shotsTable.distanceCarried})`,
      cnt: count(shotsTable.id),
    })
      .from(shotsTable)
      .where(and(
        inArray(shotsTable.playerId, playerIds),
        sql`${shotsTable.club} IS NOT NULL`,
        sql`${shotsTable.distanceCarried} IS NOT NULL`,
      ))
      .groupBy(shotsTable.club);
    aggregateRows = rows
      .filter(r => r.club != null)
      .map(r => ({
        club: r.club as string,
        avgCarry: r.avgCarry != null ? parseFloat(r.avgCarry as string) : null,
        stddevCarry: r.stddevCarry != null ? parseFloat(r.stddevCarry as string) : null,
        count: Number(r.cnt),
      }));

    const missRows = await db.select({
      missDirection: shotsTable.missDirection,
      cnt: count(shotsTable.id),
    })
      .from(shotsTable)
      .where(and(
        inArray(shotsTable.playerId, playerIds),
        sql`${shotsTable.shotType} = 'approach'`,
        sql`${shotsTable.missDirection} IS NOT NULL`,
      ))
      .groupBy(shotsTable.missDirection);
    let leftCount = 0, rightCount = 0;
    for (const r of missRows) {
      const dir = (r.missDirection ?? "").toLowerCase();
      if (dir.includes("left")) leftCount += Number(r.cnt);
      if (dir.includes("right")) rightCount += Number(r.cnt);
    }
    const total = leftCount + rightCount;
    if (total >= 5) missBiasLateralYards = ((rightCount - leftCount) / total) * 6;
  }

  let clubStats: ClubStat[] = buildClubStatsFromAggregates(aggregateRows, manualMap, handicap);
  if (clubStats.length === 0) clubStats = fallbackClubStats(handicap);

  // Per-club + per-(lie, club) acceptance rates so the offline recommender on
  // the mobile app can apply the same lie-aware personalisation as the live
  // /caddie/recommend endpoint.
  const acceptanceByClub: Record<string, number> = {};
  const acceptanceByLie: Record<string, Record<string, number>> = {};
  try {
    const accRows = await db.select({
      club: caddieRecommendationsTable.recommendedClub,
      lie: caddieRecommendationsTable.lieType,
      total: count(caddieRecommendationsTable.id),
      accepted: sql<string>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = true THEN 1 ELSE 0 END)`,
    })
      .from(caddieRecommendationsTable)
      .where(and(
        eq(caddieRecommendationsTable.userId, userId),
        sql`${caddieRecommendationsTable.recommendedClub} IS NOT NULL`,
        sql`${caddieRecommendationsTable.accepted} IS NOT NULL`,
      ))
      .groupBy(caddieRecommendationsTable.recommendedClub, caddieRecommendationsTable.lieType);
    const perClub = new Map<string, { total: number; accepted: number }>();
    const perLieClub = new Map<string, Map<string, { total: number; accepted: number }>>();
    for (const r of accRows) {
      if (!r.club) continue;
      const total = Number(r.total);
      const accepted = Number(r.accepted ?? 0);
      const clubBucket = perClub.get(r.club) ?? { total: 0, accepted: 0 };
      clubBucket.total += total;
      clubBucket.accepted += accepted;
      perClub.set(r.club, clubBucket);
      if (r.lie) {
        const lieKey = lieAdjustmentLabel(r.lie);
        const lieClubMap = perLieClub.get(lieKey) ?? new Map<string, { total: number; accepted: number }>();
        const bucket = lieClubMap.get(r.club) ?? { total: 0, accepted: 0 };
        bucket.total += total;
        bucket.accepted += accepted;
        lieClubMap.set(r.club, bucket);
        perLieClub.set(lieKey, lieClubMap);
      }
    }
    for (const [club, agg] of perClub) {
      if (agg.total >= 3) acceptanceByClub[club] = agg.accepted / agg.total;
    }
    for (const [lieKey, lieClubMap] of perLieClub) {
      for (const [club, agg] of lieClubMap) {
        if (agg.total >= 2) {
          const lieMap = acceptanceByLie[lieKey] ?? (acceptanceByLie[lieKey] = {});
          lieMap[club] = agg.accepted / agg.total;
        }
      }
    }
  } catch (e) {
    baseLogger.warn({ err: e }, "Failed to load caddie acceptance history for snapshot");
  }

  res.json({
    generatedAt: new Date().toISOString(),
    handicap,
    missBiasLateralYards: Math.round(missBiasLateralYards * 10) / 10,
    clubStats,
    acceptanceByClub,
    acceptanceByLie,
  });
});

// POST /api/portal/caddie/feedback
// Records the player's accept/override decision for a recommendation, and
// (optionally) the outcome strokes/distance to feed personalisation.
// Body: { recommendationId, chosenClub, accepted?, outcomeStrokes?, outcomeDistanceToPin? }
router.post("/portal/caddie/feedback", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const { recommendationId, chosenClub, accepted, outcomeStrokes, outcomeDistanceToPin } = req.body as {
    recommendationId?: number;
    chosenClub?: string | null;
    accepted?: boolean;
    outcomeStrokes?: number;
    outcomeDistanceToPin?: number;
  };
  if (!recommendationId || typeof recommendationId !== "number") {
    res.status(400).json({ error: "recommendationId is required" });
    return;
  }
  const [existing] = await db.select().from(caddieRecommendationsTable)
    .where(and(eq(caddieRecommendationsTable.id, recommendationId), eq(caddieRecommendationsTable.userId, userId)));
  if (!existing) { { res.status(404).json({ error: "Recommendation not found" }); return; } }

  const isAccepted = accepted ?? (chosenClub != null && existing.recommendedClub != null && chosenClub === existing.recommendedClub);
  await db.update(caddieRecommendationsTable).set({
    chosenClub: chosenClub ?? existing.chosenClub,
    accepted: isAccepted,
    outcomeStrokes: outcomeStrokes ?? existing.outcomeStrokes,
    outcomeDistanceToPin: outcomeDistanceToPin != null ? String(outcomeDistanceToPin) : existing.outcomeDistanceToPin,
    decidedAt: new Date(),
  }).where(eq(caddieRecommendationsTable.id, recommendationId));
  res.json({ ok: true, accepted: isAccepted });
});

// GET /api/portal/caddie/feedback/pending
// Lists the player's most recent recommendations that don't yet have an
// accept/override decision recorded (i.e. `accepted IS NULL`). Powers the
// "Pending" deep-link from the Caddie Insights panel — players use it to
// review each unresolved suggestion and quickly mark which club they hit.
router.get("/portal/caddie/feedback/pending", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  // Same consent gate as /summary — pending feedback is part of the AI
  // personalisation surface.
  if (!await requireConsent(req, res, "ai")) return;

  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));

  const rows = await db.select({
    id: caddieRecommendationsTable.id,
    holeNumber: caddieRecommendationsTable.holeNumber,
    round: caddieRecommendationsTable.round,
    distanceYards: caddieRecommendationsTable.distanceYards,
    effectiveYards: caddieRecommendationsTable.effectiveYards,
    recommendedClub: caddieRecommendationsTable.recommendedClub,
    alternateClub: caddieRecommendationsTable.alternateClub,
    lieType: caddieRecommendationsTable.lieType,
    recordedAt: caddieRecommendationsTable.recordedAt,
  })
    .from(caddieRecommendationsTable)
    .where(and(
      eq(caddieRecommendationsTable.userId, userId),
      sql`${caddieRecommendationsTable.accepted} IS NULL`,
    ))
    .orderBy(desc(caddieRecommendationsTable.recordedAt))
    .limit(limit);

  res.json({
    items: rows.map(r => ({
      id: r.id,
      holeNumber: r.holeNumber,
      round: r.round,
      distanceYards: r.distanceYards != null ? parseFloat(r.distanceYards as unknown as string) : null,
      effectiveYards: r.effectiveYards != null ? parseFloat(r.effectiveYards as unknown as string) : null,
      recommendedClub: r.recommendedClub,
      alternateClub: r.alternateClub,
      lieType: r.lieType,
      recordedAt: r.recordedAt instanceof Date ? r.recordedAt.toISOString() : r.recordedAt,
    })),
  });
});

// GET /api/portal/caddie/feedback/summary
// Returns aggregate accept/override stats for the current user, plus per-club
// breakdowns (acceptance rate, avg proximity to pin when accepted vs overridden,
// and top "most overridden" clubs). Powers the Caddie Insights panel in the
// mobile profile screen.
router.get("/portal/caddie/feedback/summary", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  // Task #469 — Caddie Insights aggregates AI recommendation history; gate on "ai" consent.
  if (!await requireConsent(req, res, "ai")) return;

  const rows = await db.select({
    total: count(caddieRecommendationsTable.id),
    accepted: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = true THEN 1 ELSE 0 END)`,
    overridden: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = false THEN 1 ELSE 0 END)`,
    pending: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} IS NULL THEN 1 ELSE 0 END)`,
    avgProxAccepted: sql<string | null>`AVG(CASE WHEN ${caddieRecommendationsTable.accepted} = true AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN ${caddieRecommendationsTable.outcomeDistanceToPin} END)`,
    avgProxOverridden: sql<string | null>`AVG(CASE WHEN ${caddieRecommendationsTable.accepted} = false AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN ${caddieRecommendationsTable.outcomeDistanceToPin} END)`,
    proxAcceptedSamples: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = true AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN 1 ELSE 0 END)`,
    proxOverriddenSamples: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = false AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN 1 ELSE 0 END)`,
  })
    .from(caddieRecommendationsTable)
    .where(eq(caddieRecommendationsTable.userId, userId));
  const summary = rows[0] ?? { total: 0, accepted: 0, overridden: 0, pending: 0, avgProxAccepted: null, avgProxOverridden: null, proxAcceptedSamples: 0, proxOverriddenSamples: 0 };

  const total = Number(summary.total ?? 0);
  const accepted = Number(summary.accepted ?? 0);
  const overridden = Number(summary.overridden ?? 0);
  const pending = Number(summary.pending ?? 0);
  const decided = accepted + overridden;
  const acceptanceRate = decided > 0 ? accepted / decided : null;
  const avgProximityAccepted = summary.avgProxAccepted != null ? Math.round(parseFloat(summary.avgProxAccepted as unknown as string) * 10) / 10 : null;
  const avgProximityOverridden = summary.avgProxOverridden != null ? Math.round(parseFloat(summary.avgProxOverridden as unknown as string) * 10) / 10 : null;

  // Per-club breakdown — keyed on what the AI recommended.
  const clubRows = await db.select({
    club: caddieRecommendationsTable.recommendedClub,
    total: count(caddieRecommendationsTable.id),
    accepted: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = true THEN 1 ELSE 0 END)`,
    overridden: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = false THEN 1 ELSE 0 END)`,
    avgProxAccepted: sql<string | null>`AVG(CASE WHEN ${caddieRecommendationsTable.accepted} = true AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN ${caddieRecommendationsTable.outcomeDistanceToPin} END)`,
    avgProxOverridden: sql<string | null>`AVG(CASE WHEN ${caddieRecommendationsTable.accepted} = false AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN ${caddieRecommendationsTable.outcomeDistanceToPin} END)`,
  })
    .from(caddieRecommendationsTable)
    .where(and(
      eq(caddieRecommendationsTable.userId, userId),
      sql`${caddieRecommendationsTable.recommendedClub} IS NOT NULL`,
      sql`${caddieRecommendationsTable.accepted} IS NOT NULL`,
    ))
    .groupBy(caddieRecommendationsTable.recommendedClub);

  const perClub = clubRows
    .filter(r => r.club != null)
    .map(r => {
      const cTotal = Number(r.total);
      const cAcc = Number(r.accepted ?? 0);
      const cOv = Number(r.overridden ?? 0);
      return {
        club: r.club as string,
        total: cTotal,
        accepted: cAcc,
        overridden: cOv,
        acceptanceRate: cTotal > 0 ? cAcc / cTotal : 0,
        avgProximityAccepted: r.avgProxAccepted != null ? Math.round(parseFloat(r.avgProxAccepted as unknown as string) * 10) / 10 : null,
        avgProximityOverridden: r.avgProxOverridden != null ? Math.round(parseFloat(r.avgProxOverridden as unknown as string) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.total - a.total);

  // Most-overridden clubs: clubs the player rejects most often (min sample size 3).
  const mostOverriddenClubs = perClub
    .filter(c => c.total >= 3 && c.overridden > 0)
    .slice()
    .sort((a, b) => {
      // sort by override rate desc, then by total override count desc as tiebreaker
      const rateA = a.overridden / a.total;
      const rateB = b.overridden / b.total;
      if (rateB !== rateA) return rateB - rateA;
      return b.overridden - a.overridden;
    })
    .slice(0, 3)
    .map(c => ({
      club: c.club,
      overridden: c.overridden,
      total: c.total,
      overrideRate: c.total > 0 ? c.overridden / c.total : 0,
    }));

  // Task #488 — Per-lie breakdown: accept rate and avg proximity grouped by
  // the lie type the player asked the caddie from. "Unknown" lumps together
  // suggestions that did not include a lie input.
  const lieRows = await db.select({
    lie: caddieRecommendationsTable.lieType,
    total: count(caddieRecommendationsTable.id),
    accepted: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = true THEN 1 ELSE 0 END)`,
    overridden: sql<number>`SUM(CASE WHEN ${caddieRecommendationsTable.accepted} = false THEN 1 ELSE 0 END)`,
    avgProxAccepted: sql<string | null>`AVG(CASE WHEN ${caddieRecommendationsTable.accepted} = true AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN ${caddieRecommendationsTable.outcomeDistanceToPin} END)`,
    avgProxOverridden: sql<string | null>`AVG(CASE WHEN ${caddieRecommendationsTable.accepted} = false AND ${caddieRecommendationsTable.outcomeDistanceToPin} IS NOT NULL THEN ${caddieRecommendationsTable.outcomeDistanceToPin} END)`,
  })
    .from(caddieRecommendationsTable)
    .where(and(
      eq(caddieRecommendationsTable.userId, userId),
      sql`${caddieRecommendationsTable.accepted} IS NOT NULL`,
    ))
    .groupBy(caddieRecommendationsTable.lieType);

  const perLie = lieRows
    .map(r => {
      const lTotal = Number(r.total);
      const lAcc = Number(r.accepted ?? 0);
      const lOv = Number(r.overridden ?? 0);
      const decided = lAcc + lOv;
      return {
        lie: r.lie ?? "unknown",
        total: lTotal,
        accepted: lAcc,
        overridden: lOv,
        acceptanceRate: decided > 0 ? lAcc / decided : 0,
        avgProximityAccepted: r.avgProxAccepted != null ? Math.round(parseFloat(r.avgProxAccepted as unknown as string) * 10) / 10 : null,
        avgProximityOverridden: r.avgProxOverridden != null ? Math.round(parseFloat(r.avgProxOverridden as unknown as string) * 10) / 10 : null,
      };
    })
    .sort((a, b) => b.total - a.total);

  res.json({
    total,
    accepted,
    overridden,
    pending,
    acceptanceRate,
    avgProximityAccepted,
    avgProximityOverridden,
    proximityAcceptedSamples: Number(summary.proxAcceptedSamples ?? 0),
    proximityOverriddenSamples: Number(summary.proxOverriddenSamples ?? 0),
    mostOverriddenClubs,
    perClub,
    perLie,
  });
});

// ─── CLUB DISTANCES — MANUAL EDIT ─────────────────────────────────────────────

// PUT /api/portal/club-distances/:club — set/update a manual carry distance for a club
router.put("/portal/club-distances/:club", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const club = decodeURIComponent((req.params as Record<string, string>).club);
  const { carryYards } = req.body as { carryYards?: number };

  if (!carryYards || typeof carryYards !== "number" || carryYards < 10 || carryYards > 400) {
    res.status(400).json({ error: "carryYards must be a number between 10 and 400" });
    return;
  }

  await db.insert(clubCarryDistancesTable)
    .values({ userId, club, carryYards, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [clubCarryDistancesTable.userId, clubCarryDistancesTable.club],
      set: { carryYards, updatedAt: new Date() },
    });

  res.json({ club, carryYards });
});

// DELETE /api/portal/club-distances/:club — remove a manual carry distance override
router.delete("/portal/club-distances/:club", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const club = decodeURIComponent((req.params as Record<string, string>).club);
  await db.delete(clubCarryDistancesTable).where(and(eq(clubCarryDistancesTable.userId, userId), eq(clubCarryDistancesTable.club, club)));
  res.json({ ok: true });
});

// GET /api/portal/club-distances — get all manual carry distances for current user
router.get("/portal/club-distances", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const rows = await db.select().from(clubCarryDistancesTable).where(eq(clubCarryDistancesTable.userId, userId)).orderBy(desc(clubCarryDistancesTable.carryYards));
  res.json(rows);
});

// ─── CLUB GAPPING ANALYSIS ────────────────────────────────────────────────────

// GET /api/portal/club-gapping — returns club profile + gap analysis
router.get("/portal/club-gapping", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  // Fetch manual distances
  const manualRows = await db.select().from(clubCarryDistancesTable).where(eq(clubCarryDistancesTable.userId, userId));
  const manualMap = new Map(manualRows.map(r => [r.club, r.carryYards]));

  // Fetch tracked shot averages
  const userPlayers = await db.select({ id: playersTable.id }).from(playersTable).where(eq(playersTable.userId, userId));
  const playerIds = userPlayers.map(p => p.id);
  const trackedMap = new Map<string, { avg: number; count: number; min: number; max: number }>();
  if (playerIds.length > 0) {
    const rows = await db.select({
      club: shotsTable.club,
      avgD: avg(shotsTable.distanceCarried),
      minD: min(shotsTable.distanceCarried),
      maxD: max(shotsTable.distanceCarried),
      cnt: count(shotsTable.id),
    }).from(shotsTable)
      .where(and(inArray(shotsTable.playerId, playerIds), sql`${shotsTable.club} IS NOT NULL`, sql`${shotsTable.distanceCarried} IS NOT NULL`))
      .groupBy(shotsTable.club);
    for (const r of rows) {
      if (r.club && r.avgD) trackedMap.set(r.club, {
        avg: Math.round(parseFloat(r.avgD)),
        count: Number(r.cnt),
        min: r.minD ? Math.round(parseFloat(r.minD)) : 0,
        max: r.maxD ? Math.round(parseFloat(r.maxD)) : 0,
      });
    }
  }

  // Build merged club list
  const allClubs = new Set([...manualMap.keys(), ...trackedMap.keys()]);
  const entries: { club: string; avgCarry: number; manualOverride: boolean; shotCount: number; minCarry: number | null; maxCarry: number | null }[] = [];
  for (const club of allClubs) {
    const manual = manualMap.get(club);
    const tracked = trackedMap.get(club);
    const avgCarry = manual ?? tracked?.avg ?? 0;
    entries.push({
      club,
      avgCarry,
      manualOverride: !!manual,
      shotCount: tracked?.count ?? 0,
      minCarry: tracked?.min ?? null,
      maxCarry: tracked?.max ?? null,
    });
  }

  // Sort by carry distance descending
  entries.sort((a, b) => b.avgCarry - a.avgCarry);

  // Gap analysis: flag consecutive pairs with > 15 yard gap
  const gapThreshold = 15;
  interface GapEntry { upperClub: string; lowerClub: string; upperCarry: number; lowerCarry: number; gapYards: number; suggestion: string; }
  const gaps: GapEntry[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const upper = entries[i];
    const lower = entries[i + 1];
    const gapYards = upper.avgCarry - lower.avgCarry;
    if (gapYards > gapThreshold) {
      const midCarry = Math.round((upper.avgCarry + lower.avgCarry) / 2);
      gaps.push({
        upperClub: upper.club,
        lowerClub: lower.club,
        upperCarry: upper.avgCarry,
        lowerCarry: lower.avgCarry,
        gapYards,
        suggestion: `Gap of ${gapYards}y between ${upper.club} (${upper.avgCarry}y) and ${lower.club} (${lower.avgCarry}y). Consider a club carrying ~${midCarry}y to fill this gap.`,
      });
    }
  }

  res.json({ clubs: entries, gaps });
});

// ─── PROXIMITY TO HOLE STATS ──────────────────────────────────────────────────

// GET /api/portal/proximity-stats — avg distance from hole by shot category
router.get("/portal/proximity-stats", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const userPlayers = await db.select({ id: playersTable.id }).from(playersTable).where(eq(playersTable.userId, userId));
  const playerIds = userPlayers.map(p => p.id);

  if (playerIds.length === 0) {
    res.json({ approach: null, chip: null, sand: null, totalShots: 0 });
    return;
  }

  const shotRows = await db.select({
    shotType: shotsTable.shotType,
    avgDistanceFeet: avg(sql`${shotsTable.distanceToPin} * 3`), // yards to feet
    shotCount: count(shotsTable.id),
    minFeet: min(sql`${shotsTable.distanceToPin} * 3`),
    maxFeet: max(sql`${shotsTable.distanceToPin} * 3`),
  }).from(shotsTable)
    .where(and(
      inArray(shotsTable.playerId, playerIds),
      sql`${shotsTable.distanceToPin} IS NOT NULL`,
      sql`${shotsTable.shotType} IN ('approach', 'chip', 'sand')`,
    ))
    .groupBy(shotsTable.shotType);

  const result: Record<string, { avgFeet: number; shotCount: number; minFeet: number; maxFeet: number } | null> = {
    approach: null, chip: null, sand: null,
  };
  let totalShots = 0;
  for (const row of shotRows) {
    if (row.shotType && result[row.shotType] !== undefined) {
      result[row.shotType] = {
        avgFeet: Math.round(parseFloat(row.avgDistanceFeet as string || "0")),
        shotCount: Number(row.shotCount),
        minFeet: Math.round(parseFloat(row.minFeet as string || "0")),
        maxFeet: Math.round(parseFloat(row.maxFeet as string || "0")),
      };
      totalShots += Number(row.shotCount);
    }
  }

  res.json({ ...result, totalShots });
});

// ─── COURSE PERFORMANCE HISTORY ───────────────────────────────────────────────

// GET /api/portal/course-history/:courseId — all rounds at a specific course
router.get("/portal/course-history/:courseId", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const courseId = parseInt(String((req.params as Record<string, string>).courseId), 10);
  if (isNaN(courseId)) { { res.status(400).json({ error: "Invalid courseId" }); return; } }

  // Get tournaments at this course
  const tournaments = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name, startDate: tournamentsTable.startDate, courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.courseId, courseId));

  if (tournaments.length === 0) { { res.json({ courseId, rounds: [], summary: null }); return; } }

  const tournamentIds = tournaments.map(t => t.id);
  const tMap = new Map(tournaments.map(t => [t.id, t]));

  // Get player records at these tournaments
  const userEmail = req.user!.email ?? "";
  const playerRecords = await db.select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(and(
      inArray(playersTable.tournamentId, tournamentIds),
      sql`(${playersTable.userId} = ${userId} OR ${playersTable.email} = ${userEmail})`,
    ));

  if (playerRecords.length === 0) { { res.json({ courseId, rounds: [], summary: null }); return; } }

  const playerIds = playerRecords.map(p => p.id);
  const playerTidMap = new Map(playerRecords.map(p => [p.id, p.tournamentId]));

  // Get all scores for these players
  const scores = await db.select({ playerId: scoresTable.playerId, tournamentId: scoresTable.tournamentId, round: scoresTable.round, strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(inArray(scoresTable.playerId, playerIds));

  // Group by player+tournament+round
  const roundMap = new Map<string, { playerId: number; tournamentId: number; round: number; gross: number }>();
  for (const s of scores) {
    const key = `${s.playerId}-${s.tournamentId}-${s.round}`;
    if (!roundMap.has(key)) roundMap.set(key, { playerId: s.playerId, tournamentId: s.tournamentId, round: s.round, gross: 0 });
    roundMap.get(key)!.gross += s.strokes;
  }

  // Fetch course info for par
  const [course] = await db.select({ par: coursesTable.par, rating: coursesTable.rating, slope: coursesTable.slope }).from(coursesTable).where(eq(coursesTable.id, courseId));
  const coursePar = course?.par ?? 72;
  const courseRating = course?.rating ? parseFloat(course.rating) : 72;
  const courseSlope = course?.slope ?? 113;

  const roundsList = [...roundMap.values()].map(r => {
    const t = tMap.get(r.tournamentId);
    const differential = Math.round(((113 / courseSlope) * (r.gross - courseRating)) * 10) / 10;
    return {
      tournamentId: r.tournamentId,
      tournamentName: t?.name ?? "Unknown",
      round: r.round,
      gross: r.gross,
      toPar: r.gross - coursePar,
      playedAt: t?.startDate ? t.startDate.toISOString() : null,
      scoreDifferential: differential,
    };
  }).sort((a, b) => (a.playedAt ?? "").localeCompare(b.playedAt ?? ""));

  const grosses = roundsList.map(r => r.gross).filter(g => g > 0);
  const summary = grosses.length > 0 ? {
    rounds: grosses.length,
    avgScore: Math.round((grosses.reduce((a, b) => a + b, 0) / grosses.length) * 10) / 10,
    bestScore: Math.min(...grosses),
    worstScore: Math.max(...grosses),
    coursePar,
  } : null;

  res.json({ courseId, rounds: roundsList, summary });
});

// ─── HEAD-TO-HEAD COMPARISON ──────────────────────────────────────────────────

// GET /api/portal/compare/:targetUserId — side-by-side player comparison
router.get("/portal/compare/:targetUserId", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const targetUserId = parseInt(String((req.params as Record<string, string>).targetUserId), 10);
  if (isNaN(targetUserId)) { { res.status(400).json({ error: "Invalid userId" }); return; } }
  if (targetUserId === userId) { { res.status(400).json({ error: "Cannot compare with yourself" }); return; } }

  // Helper to build stats for a userId
  async function buildUserStats(uid: number) {
    const [user] = await db.select({ displayName: appUsersTable.displayName, username: appUsersTable.username }).from(appUsersTable).where(eq(appUsersTable.id, uid));
    const email = (await db.select({ email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, uid)))[0]?.email ?? "";

    const players = await db.select({ id: playersTable.id, handicapIndex: playersTable.handicapIndex, tournamentId: playersTable.tournamentId })
      .from(playersTable)
      .where(sql`${playersTable.userId} = ${uid} OR ${playersTable.email} = ${email}`);

    const playerIds = players.map(p => p.id);
    const latestHI = players.filter(p => p.handicapIndex).sort((a, b) => b.tournamentId - a.tournamentId)[0]?.handicapIndex;

    // Handicap trend
    const hcpHistory = await db.select({ handicapIndex: handicapHistoryTable.handicapIndex, recordedAt: handicapHistoryTable.recordedAt })
      .from(handicapHistoryTable).where(eq(handicapHistoryTable.userId, uid)).orderBy(asc(handicapHistoryTable.recordedAt)).limit(20);

    if (playerIds.length === 0) return { displayName: user?.displayName ?? user?.username ?? `User ${uid}`, handicapIndex: latestHI ? parseFloat(latestHI) : null, handicapTrend: hcpHistory.map(h => ({ handicapIndex: Number(h.handicapIndex), recordedAt: h.recordedAt?.toISOString() ?? null })), girPct: null, fairwayPct: null, avgPutts: null, scoringAvg: null, roundsPlayed: 0, sgPutting: null, sgApproach: null, sgATG: null, sgOTT: null };

    const scores = await db.select().from(scoresTable).where(inArray(scoresTable.playerId, playerIds));

    // Round groups
    const roundMap2 = new Map<string, typeof scores>();
    for (const s of scores) {
      const k = `${s.playerId}-${s.tournamentId}-${s.round}`;
      if (!roundMap2.has(k)) roundMap2.set(k, []);
      roundMap2.get(k)!.push(s);
    }
    const completed = [...roundMap2.values()].filter(g => g.length >= 9);

    let totalGross = 0, totalFwHit = 0, totalFwOps = 0, totalGIRHit = 0, totalGIROps = 0, totalPutts = 0, totalPuttOps = 0;
    for (const group of completed) {
      totalGross += group.reduce((a, s) => a + s.strokes, 0);
      totalFwHit += group.filter(s => s.fairwayHit).length;
      totalFwOps += group.filter(s => s.fairwayHit !== null).length;
      totalGIRHit += group.filter(s => s.girHit).length;
      totalGIROps += group.filter(s => s.girHit !== null).length;
      totalPutts += group.reduce((a, s) => a + (s.putts ?? 0), 0);
      totalPuttOps += group.filter(s => s.putts !== null).length;
    }

    const sg = await computePlayerSGFromDB(playerIds);
    return {
      displayName: user?.displayName ?? user?.username ?? `User ${uid}`,
      handicapIndex: latestHI ? parseFloat(latestHI) : null,
      handicapTrend: hcpHistory.map(h => ({ handicapIndex: Number(h.handicapIndex), recordedAt: h.recordedAt?.toISOString() ?? null })),
      girPct: totalGIROps > 0 ? Math.round((totalGIRHit / totalGIROps) * 100) : null,
      fairwayPct: totalFwOps > 0 ? Math.round((totalFwHit / totalFwOps) * 100) : null,
      avgPutts: totalPuttOps > 0 ? Math.round((totalPutts / totalPuttOps) * 100) / 100 : null,
      scoringAvg: completed.length > 0 ? Math.round((totalGross / completed.length) * 10) / 10 : null,
      roundsPlayed: completed.length,
      sgPutting: sg.sgPutting,
      sgApproach: sg.sgApproach,
      sgATG: sg.sgATG,
      sgOTT: sg.sgOTT,
    };
  }

  const [myStats, theirStats] = await Promise.all([buildUserStats(userId), buildUserStats(targetUserId)]);
  res.json({ me: myStats, them: theirStats });
});

// GET /api/portal/org-members — list members of same org for comparison picker
router.get("/portal/org-members-compare", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const myMembership = await db.select({ organizationId: orgMembershipsTable.organizationId })
    .from(orgMembershipsTable).where(eq(orgMembershipsTable.userId, userId)).limit(1);

  if (!myMembership.length) { { res.json([]); return; } }
  const orgId = myMembership[0].organizationId;

  const members = await db.select({
    userId: orgMembershipsTable.userId,
    displayName: appUsersTable.displayName,
    username: appUsersTable.username,
  }).from(orgMembershipsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
    .where(and(eq(orgMembershipsTable.organizationId, orgId), sql`${orgMembershipsTable.userId} != ${userId}`))
    .limit(100);

  res.json(members.map(m => ({ userId: m.userId, displayName: m.displayName ?? m.username ?? `Member ${m.userId}` })));
});

// ─── MEMBER 360° (member-facing self-service) ────────────────────────────────
// Mirrors the admin /members-360/:memberId/* endpoints in member-360.ts but
// scoped to the authenticated user's own clubMember row, with optional
// family-context switching via ?actingMemberId for primary payers acting on
// behalf of linked dependents (canBookOnBehalf=true).

const COMM_PREF_CATEGORIES_PORTAL = new Set([
  "billing", "events", "tournaments", "newsletters", "marketing",
  "operations", "service", "social",
  // Regulatory category for mandatory data-protection notices (Task 190).
  // Controls whether push/SMS are used for privacy-request notices.
  "privacy",
]);
const DATA_REQUEST_TYPES = new Set(["export", "erasure", "rectification", "restrict", "object", "portability", "access"]);
// Task #381: Privacy & consent center (GDPR / India DPDP). The consent
// taxonomy spans every data category surfaced to players: profile/directory,
// scores, GPS location, photos, video, health & wellness, social interactions,
// AI-driven personalisation, marketing, third-party sharing, and the legal
// acknowledgements (privacy policy + terms). Each consent decision is
// append-only in member_consents and is mirrored to the member audit log so
// controllers (clubs) have a tamper-evident trail.
const CONSENT_TYPES = new Set([
  "privacy", "terms",
  "marketing", "directory", "third_party_share",
  "photo", "video",
  "scores", "gps",
  "health_wellness",
  "social",
  "ai",
]);

// Helper exposed to other route files that need to gate a feature on the
// member's current consent state (Task #381 — backend feature gating). Returns
// the latest decision for a given consent type, defaulting to `false` when no
// decision has been recorded yet. Optional consents (everything except
// "privacy" and "terms") default to denied so that absence-of-consent is
// treated as withdrawal under DPDP §6.
export async function memberHasConsent(memberId: number, consentType: string): Promise<boolean> {
  const [latest] = await db.select({ granted: memberConsentsTable.granted })
    .from(memberConsentsTable)
    .where(and(
      eq(memberConsentsTable.clubMemberId, memberId),
      eq(memberConsentsTable.consentType, consentType),
    ))
    .orderBy(desc(memberConsentsTable.grantedAt))
    .limit(1);
  return latest?.granted ?? false;
}

async function loadOwnMember(userId: number): Promise<{ id: number; organizationId: number } | null> {
  // Scope to the user's active organization when present, to disambiguate multi-org accounts.
  const [user] = await db.select({ organizationId: appUsersTable.organizationId })
    .from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1);
  const conditions = [eq(clubMembersTable.userId, userId)];
  if (user?.organizationId) conditions.push(eq(clubMembersTable.organizationId, user.organizationId));
  const [m] = await db.select({ id: clubMembersTable.id, organizationId: clubMembersTable.organizationId })
    .from(clubMembersTable).where(and(...conditions)).limit(1);
  return m ?? null;
}

async function resolveMemberContext(
  req: Request, res: Response,
): Promise<{ memberId: number; orgId: number; actingAsLinked: boolean } | null> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const own = await loadOwnMember(req.user!.id);
  if (!own) { res.status(404).json({ error: "No club membership found for this account." }); return null; }
  const actingRaw = req.query.actingMemberId ?? (req.body && (req.body as Record<string, unknown>).actingMemberId);
  if (actingRaw == null || actingRaw === "" || Number(actingRaw) === own.id) {
    return { memberId: own.id, orgId: own.organizationId, actingAsLinked: false };
  }
  const actingId = Number(actingRaw);
  if (!Number.isFinite(actingId)) { res.status(400).json({ error: "Invalid actingMemberId" }); return null; }
  const [link] = await db.select().from(memberFamilyLinksTable).where(and(
    eq(memberFamilyLinksTable.primaryMemberId, own.id),
    eq(memberFamilyLinksTable.linkedMemberId, actingId),
    eq(memberFamilyLinksTable.canBookOnBehalf, true),
    eq(memberFamilyLinksTable.organizationId, own.organizationId),
  )).limit(1);
  if (!link) { res.status(403).json({ error: "You are not authorised to act on behalf of this member." }); return null; }
  const [linked] = await db.select({ id: clubMembersTable.id, organizationId: clubMembersTable.organizationId })
    .from(clubMembersTable).where(and(
      eq(clubMembersTable.id, actingId),
      eq(clubMembersTable.organizationId, own.organizationId),
    )).limit(1);
  if (!linked) { res.status(404).json({ error: "Linked member not found" }); return null; }
  return { memberId: linked.id, orgId: linked.organizationId, actingAsLinked: true };
}

// GET /api/portal/my-360 — full self-service summary
router.get("/portal/my-360", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { memberId, orgId } = ctx;

  const [member] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  if (!member) { { res.status(404).json({ error: "Member not found" }); return; } }
  const [ext] = await db.select().from(memberProfileExtTable)
    .where(eq(memberProfileExtTable.clubMemberId, memberId)).limit(1);
  const [tier] = member.tierId
    ? await db.select().from(membershipTiersTable).where(eq(membershipTiersTable.id, member.tierId))
    : [null];
  const [sub] = await db.select().from(memberSubscriptionsTable)
    .where(eq(memberSubscriptionsTable.clubMemberId, memberId))
    .orderBy(desc(memberSubscriptionsTable.createdAt)).limit(1);

  const [docCount] = await db.select({ c: count() }).from(memberDocumentsTable)
    .where(eq(memberDocumentsTable.clubMemberId, memberId));
  const [familyCount] = await db.select({ c: count() }).from(memberFamilyLinksTable)
    .where(eq(memberFamilyLinksTable.primaryMemberId, memberId));
  const [milestoneCount] = await db.select({ c: count() }).from(memberMilestonesTable)
    .where(eq(memberMilestonesTable.clubMemberId, memberId));

  const charges = await db.select().from(memberAccountChargesTable)
    .where(eq(memberAccountChargesTable.clubMemberId, memberId));
  const outstanding = charges.reduce((s, c) =>
    c.isSettled ? s : s + parseFloat(String(c.amount ?? "0")), 0);
  const [credit] = await db.select().from(storeCreditAccountsTable)
    .where(and(eq(storeCreditAccountsTable.memberId, memberId), eq(storeCreditAccountsTable.organizationId, orgId)));

  res.json({
    member: {
      id: member.id, firstName: member.firstName, lastName: member.lastName,
      memberNumber: member.memberNumber, subscriptionStatus: member.subscriptionStatus,
      renewalDate: member.renewalDate, organizationId: member.organizationId, tierId: member.tierId,
    },
    ext: ext ? {
      lifecycleStatus: ext.lifecycleStatus, kycStatus: ext.kycStatus,
      preferredName: ext.preferredName, preferredTee: ext.preferredTee,
      addressLine1: ext.addressLine1, city: ext.city, country: ext.country,
    } : null,
    tier, subscription: sub,
    counts: {
      documents: Number(docCount?.c ?? 0),
      familyLinks: Number(familyCount?.c ?? 0),
      milestones: Number(milestoneCount?.c ?? 0),
    },
    financial: {
      outstandingBalance: outstanding.toFixed(2),
      storeCreditBalance: credit ? (credit.balancePaise / 100).toFixed(2) : "0.00",
    },
    actingAsLinked: ctx.actingAsLinked,
  });
});

// GET /api/portal/my-documents — own document list (read-only)
router.get("/portal/my-documents", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const docs = await db.select().from(memberDocumentsTable)
    .where(eq(memberDocumentsTable.clubMemberId, ctx.memberId))
    .orderBy(desc(memberDocumentsTable.createdAt));
  res.json(docs);
});

// Member-uploadable document types (KYC self-service)
const MEMBER_UPLOAD_DOC_TYPES = new Set([
  "id_proof", "address_proof", "photo", "medical", "other",
]);
const MEMBER_UPLOAD_MIME_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
const MEMBER_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// POST /api/portal/my-documents/upload-url — short-lived signed URL for direct upload
router.post("/portal/my-documents/upload-url", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { contentType, documentType } = req.body ?? {};
  const ext = MEMBER_UPLOAD_MIME_TYPES[String(contentType)];
  if (!ext) {
    res.status(400).json({ error: "Invalid content type. Allowed: PNG, JPEG, WebP, PDF." });
    return;
  }
  if (!documentType || !MEMBER_UPLOAD_DOC_TYPES.has(String(documentType))) {
    res.status(400).json({ error: `Invalid documentType. Allowed: ${[...MEMBER_UPLOAD_DOC_TYPES].join(", ")}` });
    return;
  }
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
  if (!bucket) { { res.status(500).json({ error: "Storage not configured" }); return; } }
  try {
    const key = randomBytes(8).toString("hex");
    const objectPath = `member-documents/org-${ctx.orgId}/member-${ctx.memberId}/${Date.now()}-${key}.${ext}`;
    const file = objectStorageClient.bucket(bucket).file(objectPath);
    const [uploadUrl] = await file.getSignedUrl({
      action: "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType: String(contentType),
    });
    const publicUrl = `https://storage.googleapis.com/${bucket}/${objectPath}`;
    res.json({ uploadUrl, publicUrl });
  } catch {
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

// POST /api/portal/my-documents — record a member-uploaded document (isVerified=false)
router.post("/portal/my-documents", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { documentType, title, fileUrl, mimeType, fileSize, expiresAt } = req.body ?? {};
  if (!documentType || !MEMBER_UPLOAD_DOC_TYPES.has(String(documentType))) {
    res.status(400).json({ error: `Invalid documentType. Allowed: ${[...MEMBER_UPLOAD_DOC_TYPES].join(", ")}` });
    return;
  }
  if (!title || typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
    res.status(400).json({ error: "title is required (1-200 characters)" });
    return;
  }
  if (!fileUrl || typeof fileUrl !== "string") {
    res.status(400).json({ error: "fileUrl is required" });
    return;
  }
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
  const expectedPrefix = `https://storage.googleapis.com/${bucket}/member-documents/org-${ctx.orgId}/member-${ctx.memberId}/`;
  if (!bucket || !fileUrl.startsWith(expectedPrefix)) {
    res.status(400).json({ error: "fileUrl must come from this member's signed upload" });
    return;
  }
  if (mimeType != null && !MEMBER_UPLOAD_MIME_TYPES[String(mimeType)]) {
    res.status(400).json({ error: "Invalid mimeType" });
    return;
  }
  let size: number | null = null;
  if (fileSize != null) {
    const n = Number(fileSize);
    if (!Number.isFinite(n) || n < 0 || n > MEMBER_UPLOAD_MAX_BYTES) {
      res.status(400).json({ error: `fileSize must be 0-${MEMBER_UPLOAD_MAX_BYTES} bytes` });
      return;
    }
    size = Math.floor(n);
  }
  let expires: Date | null = null;
  if (expiresAt) {
    const d = new Date(String(expiresAt));
    if (isNaN(d.getTime())) { { res.status(400).json({ error: "Invalid expiresAt" }); return; } }
    expires = d;
  }
  const [row] = await db.insert(memberDocumentsTable).values({
    clubMemberId: ctx.memberId,
    organizationId: ctx.orgId,
    documentType: String(documentType),
    title: title.trim(),
    fileUrl,
    mimeType: mimeType ? String(mimeType) : null,
    fileSize: size,
    expiresAt: expires,
    isVerified: false,
    uploadedByUserId: req.user!.id,
  }).returning();
  await recordMemberAudit({
    req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    entity: "document", entityId: row.id, action: "create",
    reason: `uploaded ${row.documentType}`,
  });

  // Notify staff (org_admin, membership_secretary) that a new document is awaiting review.
  // Fire-and-forget — never block the upload response on notification delivery.
  // Task #1909 — extracted into `notifyDocumentPendingStaff` so the push title /
  // body and email subject / body are composed from the localised
  // `documentPending` translation pack (EN fallback) instead of being
  // hardcoded English at this call site.
  void (async () => {
    try {
      await notifyDocumentPendingStaff({
        organizationId: ctx.orgId,
        clubMemberId: ctx.memberId,
        documentId: row.id,
        documentType,
        title,
      });
    } catch (err) {
      baseLogger.warn({ err, memberId: ctx.memberId, docId: row.id }, "[member-documents] failed to notify staff");
    }
  })();

  res.status(201).json(row);
});

// DELETE /api/portal/my-documents/:id — member self-delete an unverified own document
router.delete("/portal/my-documents/:id", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const docId = Number((req.params as Record<string, string>).id);
  if (!Number.isInteger(docId) || docId <= 0) { { res.status(400).json({ error: "Invalid document id" }); return; } }
  const [doc] = await db.select().from(memberDocumentsTable).where(and(
    eq(memberDocumentsTable.id, docId),
    eq(memberDocumentsTable.clubMemberId, ctx.memberId),
  )).limit(1);
  if (!doc) { { res.status(404).json({ error: "Document not found" }); return; } }
  if (doc.isVerified) {
    res.status(403).json({ error: "Verified documents can only be removed by club staff." });
    return;
  }
  await db.delete(memberDocumentsTable).where(eq(memberDocumentsTable.id, docId));
  // Best-effort object-storage cleanup
  try {
    const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
    const prefix = `https://storage.googleapis.com/${bucket}/`;
    if (bucket && doc.fileUrl.startsWith(prefix)) {
      const objectPath = doc.fileUrl.slice(prefix.length);
      await objectStorageClient.bucket(bucket).file(objectPath).delete({ ignoreNotFound: true });
    }
  } catch (err) {
    baseLogger.warn({ err, docId }, "Failed to delete member document object from storage");
  }
  await recordMemberAudit({
    req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    entity: "document", entityId: docId, action: "delete", reason: "self_delete_unverified",
  });
  res.status(204).end();
});

// PUT /api/portal/my-documents/:id — replace an unverified document in one step
// Atomically swaps the file_url (and optionally title/expiresAt) on the existing
// row, then best-effort deletes the previous object-storage file. Verified
// documents cannot be replaced by the member.
router.put("/portal/my-documents/:id", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const docId = Number((req.params as Record<string, string>).id);
  if (!Number.isFinite(docId)) { { res.status(400).json({ error: "Invalid document id" }); return; } }

  const { title, fileUrl, mimeType, fileSize, expiresAt } = req.body ?? {};
  if (!title || typeof title !== "string" || title.trim().length === 0 || title.length > 200) {
    res.status(400).json({ error: "title is required (1-200 characters)" });
    return;
  }
  if (!fileUrl || typeof fileUrl !== "string") {
    res.status(400).json({ error: "fileUrl is required" });
    return;
  }
  const bucket = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID ?? "";
  const expectedPrefix = `https://storage.googleapis.com/${bucket}/member-documents/org-${ctx.orgId}/member-${ctx.memberId}/`;
  if (!bucket || !fileUrl.startsWith(expectedPrefix)) {
    res.status(400).json({ error: "fileUrl must come from this member's signed upload" });
    return;
  }
  if (mimeType != null && !MEMBER_UPLOAD_MIME_TYPES[String(mimeType)]) {
    res.status(400).json({ error: "Invalid mimeType" });
    return;
  }
  let size: number | null = null;
  if (fileSize != null) {
    const n = Number(fileSize);
    if (!Number.isFinite(n) || n < 0 || n > MEMBER_UPLOAD_MAX_BYTES) {
      res.status(400).json({ error: `fileSize must be 0-${MEMBER_UPLOAD_MAX_BYTES} bytes` });
      return;
    }
    size = Math.floor(n);
  }
  let expires: Date | null | undefined = undefined;
  if (expiresAt === null) {
    expires = null;
  } else if (expiresAt) {
    const d = new Date(String(expiresAt));
    if (isNaN(d.getTime())) { { res.status(400).json({ error: "Invalid expiresAt" }); return; } }
    expires = d;
  }

  // Look up the existing row, scoped to this member, and verify it is not yet verified.
  const [existing] = await db.select().from(memberDocumentsTable).where(and(
    eq(memberDocumentsTable.id, docId),
    eq(memberDocumentsTable.clubMemberId, ctx.memberId),
  )).limit(1);
  if (!existing) { { res.status(404).json({ error: "Document not found" }); return; } }
  if (existing.isVerified) {
    res.status(409).json({ error: "Verified documents cannot be replaced. Please contact your club." });
    return;
  }

  const oldFileUrl = existing.fileUrl;

  // Atomic swap: update the row and re-check it is still unverified in the
  // same statement (prevents a race with staff verifying mid-replace).
  const updateValues: {
    title: string; fileUrl: string;
    mimeType: string | null; fileSize: number | null;
    uploadedByUserId: number;
    expiresAt?: Date | null;
  } = {
    title: title.trim(),
    fileUrl,
    mimeType: mimeType ? String(mimeType) : null,
    fileSize: size,
    uploadedByUserId: req.user!.id,
  };
  if (expires !== undefined) updateValues.expiresAt = expires;

  // Atomic swap: update the document row (re-checking it is still unverified
  // to prevent a race with staff verifying mid-replace) AND insert the
  // member_document_versions snapshot in the same DB transaction. If either
  // statement fails the whole replace rolls back so we never leave the new
  // file recorded without its corresponding history row, and the previous
  // object-storage file is left untouched.
  let updated: typeof existing | undefined;
  let versionRowId: number | undefined;
  try {
    const result = await db.transaction(async (tx) => {
      const [row] = await tx.update(memberDocumentsTable)
        .set(updateValues)
        .where(and(
          eq(memberDocumentsTable.id, docId),
          eq(memberDocumentsTable.clubMemberId, ctx.memberId),
          eq(memberDocumentsTable.isVerified, false),
        ))
        .returning();
      if (!row) return undefined;
      // Snapshot points at the original URL initially. We attempt to move the
      // file to an archive prefix after the transaction commits and update the
      // version row's URL on success — this guarantees the snapshot URL always
      // resolves to the prior file regardless of whether the archive move
      // ultimately succeeds.
      const [version] = await tx.insert(memberDocumentVersionsTable).values({
        memberDocumentId: row.id,
        clubMemberId: existing.clubMemberId,
        organizationId: existing.organizationId,
        title: existing.title,
        fileUrl: oldFileUrl,
        mimeType: existing.mimeType,
        fileSize: existing.fileSize,
        replacedByUserId: req.user!.id,
      }).returning({ id: memberDocumentVersionsTable.id });
      return { row, versionId: version.id };
    });
    if (result) { updated = result.row; versionRowId = result.versionId; }
  } catch (e) {
    baseLogger.error({ err: e, docId }, "Replace transaction failed; document and version history unchanged");
    res.status(500).json({ error: "Failed to replace document. Please try again." });
    return;
  }

  if (!updated) {
    res.status(409).json({ error: "Document was verified or removed before replace could complete." });
    return;
  }

  await recordMemberAudit({
    req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    entity: "document", entityId: updated.id, action: "update",
    reason: "replaced file",
    before: { fileUrl: oldFileUrl, title: existing.title },
    after: { fileUrl: updated.fileUrl, title: updated.title },
  });

  // Best-effort archive of the now-superseded object so it lives under a
  // distinct prefix from the active member documents. Only runs after the DB
  // transaction has committed so a failed replace never moves the live file.
  // If the move succeeds, point the version row at the new archive URL.
  if (oldFileUrl && oldFileUrl !== updated.fileUrl && versionRowId !== undefined) {
    const prefix = `https://storage.googleapis.com/${bucket}/`;
    if (oldFileUrl.startsWith(prefix)) {
      const oldPath = oldFileUrl.slice(prefix.length);
      if (!oldPath.startsWith("member-documents-archive/")) {
        const archivePath = `member-documents-archive/${oldPath}`;
        try {
          await objectStorageClient.bucket(bucket).file(oldPath).move(archivePath);
          await db.update(memberDocumentVersionsTable)
            .set({ fileUrl: `${prefix}${archivePath}` })
            .where(eq(memberDocumentVersionsTable.id, versionRowId));
        } catch (e) {
          baseLogger.warn({ err: e, oldPath, docId: updated.id }, "Failed to archive replaced member document file; version row keeps original URL");
        }
      }
    }
  }

  res.json(updated);
});

// GET /api/portal/my-consents
router.get("/portal/my-consents", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const rows = await db.select().from(memberConsentsTable)
    .where(eq(memberConsentsTable.clubMemberId, ctx.memberId))
    .orderBy(desc(memberConsentsTable.grantedAt));
  res.json(rows);
});

// PUT /api/portal/my-consents — record a new consent decision (append-only history)
router.put("/portal/my-consents", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { consentType, granted, version } = req.body ?? {};
  if (!consentType || typeof granted !== "boolean") {
    res.status(400).json({ error: "consentType and granted are required" }); return;
  }
  if (!CONSENT_TYPES.has(String(consentType))) {
    res.status(400).json({ error: `Invalid consentType. Allowed: ${[...CONSENT_TYPES].join(", ")}` }); return;
  }
  const [row] = await db.insert(memberConsentsTable).values({
    organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    consentType: String(consentType), granted: Boolean(granted),
    version: version ? String(version) : null,
    source: "mobile_app",
    ipAddress: req.ip ?? null,
    recordedByUserId: req.user!.id,
  }).returning();
  // Task #381: mirror every consent change into the member audit log so the
  // controller dashboard can present a tamper-evident, append-only history.
  await recordMemberAudit({
    req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    entity: "consent", entityId: row.id,
    action: granted ? "grant" : "withdraw",
    reason: `${row.consentType}${row.version ? ` v${row.version}` : ""}`,
  }).catch((err) => {
    baseLogger.warn({ err, consentId: row.id }, "[portal] consent audit log failed (non-blocking)");
  });
  res.status(201).json(row);
});

// ─── Account deletion with grace period (Task #381) ─────────────────────────
// Self-serve account deletion is implemented on top of the existing
// member_data_requests table. Filing a deletion creates an `erasure` request
// whose `dueBy` doubles as the grace-period end. Inside the grace window the
// member can cancel their own request via DELETE — this transitions the row
// to `rejected` with a "cancelled by member" note. After the grace window
// elapses, admins process the row using the existing Member 360 GDPR queue.
const ACCOUNT_DELETION_GRACE_DAYS = 30;

// GET /api/portal/my-account-deletion — pending deletion (if any) + grace info
router.get("/portal/my-account-deletion", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const [pending] = await db.select().from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.clubMemberId, ctx.memberId),
      eq(memberDataRequestsTable.requestType, "erasure"),
      sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
    ))
    .orderBy(desc(memberDataRequestsTable.requestedAt))
    .limit(1);
  res.json({
    pending: pending ?? null,
    gracePeriodDays: ACCOUNT_DELETION_GRACE_DAYS,
    gracePeriodEndsAt: pending?.dueBy ?? null,
    canCancel: pending != null && pending.status === "pending",
  });
});

// POST /api/portal/my-account-deletion — file an erasure with a grace window
router.post("/portal/my-account-deletion", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  if (ctx.actingAsLinked) {
    res.status(403).json({ error: "Account deletion can only be requested for your own account, not linked dependents." });
    return;
  }
  const [existing] = await db.select().from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.clubMemberId, ctx.memberId),
      eq(memberDataRequestsTable.requestType, "erasure"),
      sql`${memberDataRequestsTable.status} NOT IN ('completed', 'rejected')`,
    ))
    .limit(1);
  if (existing) {
    res.status(409).json({
      error: "An account deletion is already in progress.",
      pending: existing,
      gracePeriodEndsAt: existing.dueBy,
    });
    return;
  }
  const { reason } = req.body ?? {};
  const dueBy = new Date();
  dueBy.setDate(dueBy.getDate() + ACCOUNT_DELETION_GRACE_DAYS);
  const note = `Account deletion (self-serve, ${ACCOUNT_DELETION_GRACE_DAYS}-day grace period)`
    + (reason && typeof reason === "string" ? ` — reason: ${String(reason).slice(0, 500)}` : "");
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    requestType: "erasure", notes: note, dueBy,
  }).returning();

  await recordMemberAudit({
    req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    entity: "data_request", entityId: row.id, action: "create",
    reason: `account deletion filed — grace ends ${dueBy.toISOString()}`,
  }).catch(() => {});

  // Reuse the standard data-request notification fan-out so the member gets
  // an in-app message + email acknowledging the filing.
  void (async () => {
    try {
      await notifyDataRequest({
        organizationId: ctx.orgId,
        request: row,
        kind: "filed",
        senderUserId: null,
        logContext: { route: "portal.my-account-deletion.post", memberId: ctx.memberId },
      });
    } catch (err) {
      baseLogger.error({ err, requestId: row.id }, "[portal] account-deletion ack notify failed");
    }
  })();

  res.status(201).json({
    request: row,
    gracePeriodDays: ACCOUNT_DELETION_GRACE_DAYS,
    gracePeriodEndsAt: row.dueBy,
  });
});

// DELETE /api/portal/my-account-deletion — cancel a pending deletion within grace
router.delete("/portal/my-account-deletion", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const [pending] = await db.select().from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.clubMemberId, ctx.memberId),
      eq(memberDataRequestsTable.requestType, "erasure"),
      eq(memberDataRequestsTable.status, "pending"),
    ))
    .orderBy(desc(memberDataRequestsTable.requestedAt))
    .limit(1);
  if (!pending) { { res.status(404).json({ error: "No cancellable account deletion found." }); return; } }
  if (pending.dueBy && new Date(pending.dueBy).getTime() < Date.now()) {
    res.status(409).json({ error: "The grace period has elapsed; please contact your club administrator." });
    return;
  }
  const [updated] = await db.update(memberDataRequestsTable).set({
    status: "rejected",
    resolvedAt: new Date(),
    notes: (pending.notes ? `${pending.notes}\n` : "") + "Cancelled by member within grace period.",
  }).where(eq(memberDataRequestsTable.id, pending.id)).returning();
  await recordMemberAudit({
    req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    entity: "data_request", entityId: pending.id, action: "cancel",
    reason: "account deletion cancelled by member within grace period",
  }).catch(() => {});
  res.json({ request: updated });
});

// GET /api/portal/my-comm-prefs
router.get("/portal/my-comm-prefs", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const rows = await db.select().from(memberCommPrefsTable)
    .where(eq(memberCommPrefsTable.clubMemberId, ctx.memberId));
  res.json(rows);
});

// PUT /api/portal/my-comm-prefs — upsert one category
router.put("/portal/my-comm-prefs", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { category, emailEnabled, smsEnabled, pushEnabled, whatsappEnabled, inAppEnabled, quietHoursStart, quietHoursEnd } = req.body ?? {};
  if (!category || !COMM_PREF_CATEGORIES_PORTAL.has(String(category))) {
    res.status(400).json({ error: `Invalid category. Allowed: ${[...COMM_PREF_CATEGORIES_PORTAL].join(", ")}` }); return;
  }
  const [existing] = await db.select().from(memberCommPrefsTable).where(and(
    eq(memberCommPrefsTable.clubMemberId, ctx.memberId),
    eq(memberCommPrefsTable.category, String(category)),
  ));
  let row;
  if (existing) {
    [row] = await db.update(memberCommPrefsTable).set({
      emailEnabled, smsEnabled, pushEnabled, whatsappEnabled, inAppEnabled,
      quietHoursStart, quietHoursEnd, updatedAt: new Date(),
    }).where(eq(memberCommPrefsTable.id, existing.id)).returning();
  } else {
    [row] = await db.insert(memberCommPrefsTable).values({
      organizationId: ctx.orgId, clubMemberId: ctx.memberId, category: String(category),
      emailEnabled, smsEnabled, pushEnabled, whatsappEnabled, inAppEnabled,
      quietHoursStart, quietHoursEnd,
    }).returning();
  }
  res.json(row);
});

// GET /api/portal/my-family — list of links + linked member info
router.get("/portal/my-family", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const own = await loadOwnMember(req.user!.id);
  if (!own) { { res.status(404).json({ error: "No club membership found." }); return; } }
  // Outgoing: people I'm primary for (I can act on their behalf if canBookOnBehalf)
  const outgoing = await db.select({
    link: memberFamilyLinksTable, member: clubMembersTable,
  }).from(memberFamilyLinksTable)
    .innerJoin(clubMembersTable, and(
      eq(memberFamilyLinksTable.linkedMemberId, clubMembersTable.id),
      eq(clubMembersTable.organizationId, own.organizationId),
    ))
    .where(and(
      eq(memberFamilyLinksTable.primaryMemberId, own.id),
      eq(memberFamilyLinksTable.organizationId, own.organizationId),
    ));
  // Incoming: who is primary for me
  const incoming = await db.select({
    link: memberFamilyLinksTable, member: clubMembersTable,
  }).from(memberFamilyLinksTable)
    .innerJoin(clubMembersTable, and(
      eq(memberFamilyLinksTable.primaryMemberId, clubMembersTable.id),
      eq(clubMembersTable.organizationId, own.organizationId),
    ))
    .where(and(
      eq(memberFamilyLinksTable.linkedMemberId, own.id),
      eq(memberFamilyLinksTable.organizationId, own.organizationId),
    ));
  res.json({
    self: own,
    outgoing: outgoing.map(r => ({
      linkId: r.link.id, relationship: r.link.relationship,
      isPrimaryPayer: r.link.isPrimaryPayer, canBookOnBehalf: r.link.canBookOnBehalf,
      memberId: r.member.id, firstName: r.member.firstName, lastName: r.member.lastName,
      memberNumber: r.member.memberNumber,
    })),
    incoming: incoming.map(r => ({
      linkId: r.link.id, relationship: r.link.relationship,
      isPrimaryPayer: r.link.isPrimaryPayer, canBookOnBehalf: r.link.canBookOnBehalf,
      memberId: r.member.id, firstName: r.member.firstName, lastName: r.member.lastName,
      memberNumber: r.member.memberNumber,
    })),
  });
});

// GET /api/portal/my-statement — financial ledger (charges + levies + store credit)
// Levy rows include the new payment-tracking fields (status, paidAmount,
// refundedAmount, waivedReason, dueDate) plus a derived `remaining` balance so
// the member can see exactly what they still owe per charge after partial
// payments / refunds / waivers.
router.get("/portal/my-statement", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { memberId, orgId } = ctx;
  const [charges, levyRows, credit] = await Promise.all([
    db.select().from(memberAccountChargesTable)
      .where(eq(memberAccountChargesTable.clubMemberId, memberId))
      .orderBy(desc(memberAccountChargesTable.createdAt)),
    db.select({ charge: memberLevyChargesTable, levy: memberLeviesTable })
      .from(memberLevyChargesTable)
      .innerJoin(memberLeviesTable, eq(memberLevyChargesTable.levyId, memberLeviesTable.id))
      .where(eq(memberLevyChargesTable.clubMemberId, memberId))
      .orderBy(desc(memberLevyChargesTable.createdAt)),
    (async () => {
      const [acct] = await db.select().from(storeCreditAccountsTable)
        .where(and(eq(storeCreditAccountsTable.memberId, memberId), eq(storeCreditAccountsTable.organizationId, orgId)));
      if (!acct) return { account: null, history: [] as unknown[] };
      const history = await db.select().from(storeCreditTransactionsTable)
        .where(eq(storeCreditTransactionsTable.accountId, acct.id))
        .orderBy(desc(storeCreditTransactionsTable.createdAt))
        .limit(50);
      return { account: acct, history };
    })(),
  ]);

  // Enrich each levy charge with a remaining-balance figure that mirrors
  // the admin-side computation in /ledger.
  const levyCharges = levyRows.map((r) => {
    const amt = parseFloat(String(r.charge.amount ?? "0"));
    const paid = parseFloat(String(r.charge.paidAmount ?? "0"));
    const refunded = parseFloat(String(r.charge.refundedAmount ?? "0"));
    const status = r.charge.status ?? (r.charge.paid ? "paid" : "unpaid");
    const isClosed = status === "waived" || status === "refunded" || status === "paid";
    const remainingRaw = amt - paid - refunded;
    const remaining = isClosed || remainingRaw < 0 ? 0 : remainingRaw;
    return {
      charge: {
        ...r.charge,
        remaining: remaining.toFixed(2),
      },
      levy: r.levy,
    };
  });

  const outstanding = charges.reduce((s, c) =>
    c.isSettled ? s : s + parseFloat(String(c.amount ?? "0")), 0);
  const levyOutstanding = levyCharges.reduce((s, r) =>
    s + parseFloat(r.charge.remaining), 0);

  res.json({
    accountCharges: charges,
    levyCharges,
    storeCredit: credit,
    outstandingBalance: (outstanding + levyOutstanding).toFixed(2),
    levyOutstandingBalance: levyOutstanding.toFixed(2),
  });
});

// GET /api/portal/my-payment-history — every recorded payment / refund / waive
// event for the member's levy charges, sourced from the member audit log so
// every captured note or reason flows through unchanged.
router.get("/portal/my-payment-history", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { memberId, orgId } = ctx;

  // Resolve this member's levy charges so we can correlate audit-log entries
  // (entityId = levyId, NOT chargeId) back to a friendly levy name.
  const charges = await db.select({
    chargeId: memberLevyChargesTable.id,
    levyId: memberLevyChargesTable.levyId,
    levyName: memberLeviesTable.name,
    levyCurrency: memberLeviesTable.currency,
    amount: memberLevyChargesTable.amount,
    paidAmount: memberLevyChargesTable.paidAmount,
    refundedAmount: memberLevyChargesTable.refundedAmount,
    status: memberLevyChargesTable.status,
  })
    .from(memberLevyChargesTable)
    .innerJoin(memberLeviesTable, eq(memberLevyChargesTable.levyId, memberLeviesTable.id))
    .where(eq(memberLevyChargesTable.clubMemberId, memberId));

  if (charges.length === 0) { { res.json({ events: [] }); return; } }

  // Audit rows for entity=levy_charge include both create (apply) and update
  // (payment / refund / waive). entityId is the chargeId for updates and
  // levyId for the apply event — both numeric ids we can index on.
  const auditRows = await db.select({
    id: memberAuditLogTable.id,
    entity: memberAuditLogTable.entity,
    entityId: memberAuditLogTable.entityId,
    action: memberAuditLogTable.action,
    reason: memberAuditLogTable.reason,
    actorName: memberAuditLogTable.actorName,
    createdAt: memberAuditLogTable.createdAt,
  })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.clubMemberId, memberId),
      eq(memberAuditLogTable.entity, "levy_charge"),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt));

  const chargesByLevy = new Map(charges.map(c => [c.levyId, c]));
  // For "applied" events the audit entityId is the levyId; for every other
  // event kind (payment / refund / waive) the entityId is the chargeId.
  // Index both so we can resolve levy metadata regardless.
  const levyByLevyId = new Map(charges.map(c => [c.levyId, { name: c.levyName, currency: c.levyCurrency }]));
  const levyByChargeId = new Map(charges.map(c => [c.chargeId, { name: c.levyName, currency: c.levyCurrency }]));

  // Classify each audit row from its reason text. The admin write-paths set
  // these reasons consistently (see member-360 levy handlers), so we can
  // safely categorise without inventing a new event table.
  type EventKind = "applied" | "payment" | "refund" | "waived" | "marked_paid" | "other";
  const classify = (reason: string | null): EventKind => {
    const r = (reason ?? "").toLowerCase();
    if (r.includes("levy applied")) return "applied";
    if (r.includes("paid in full") || r.includes("partial payment")) return "payment";
    if (r.includes("marked paid")) return "marked_paid";
    if (r.includes("refund")) return "refund";
    if (r.includes("waived")) return "waived";
    return "other";
  };

  const events = auditRows.map((row) => {
    const kind = classify(row.reason);
    // entityId is levyId for "applied" events and chargeId otherwise.
    const levy = row.entityId == null
      ? null
      : kind === "applied"
        ? (levyByLevyId.get(row.entityId) ?? null)
        : (levyByChargeId.get(row.entityId) ?? null);
    return {
      id: row.id,
      kind,
      action: row.action,
      reason: row.reason,
      actorName: row.actorName,
      createdAt: row.createdAt,
      levyId: kind === "applied" ? row.entityId : null,
      chargeId: kind === "applied" ? null : row.entityId,
      levyName: levy?.name ?? null,
      levyCurrency: levy?.currency ?? null,
    };
  });

  res.json({
    events,
    chargeCount: chargesByLevy.size,
  });
});

// GET /api/portal/my-milestones — own milestones (hole-in-one register, etc.)
router.get("/portal/my-milestones", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const rows = await db.select().from(memberMilestonesTable)
    .where(eq(memberMilestonesTable.clubMemberId, ctx.memberId))
    .orderBy(desc(memberMilestonesTable.occurredAt));
  res.json(rows);
});

// GET /api/portal/my-data-requests — list privacy/data requests
router.get("/portal/my-data-requests", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const rows = await db.select().from(memberDataRequestsTable)
    .where(eq(memberDataRequestsTable.clubMemberId, ctx.memberId))
    .orderBy(desc(memberDataRequestsTable.requestedAt));
  res.json(rows);
});

// POST /api/portal/my-data-requests — file an access/erasure/portability request
router.post("/portal/my-data-requests", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { requestType, notes } = req.body ?? {};
  if (!requestType || !DATA_REQUEST_TYPES.has(String(requestType))) {
    res.status(400).json({ error: `Invalid requestType. Allowed: ${[...DATA_REQUEST_TYPES].join(", ")}` }); return;
  }
  const dueBy = new Date(); dueBy.setDate(dueBy.getDate() + 30);
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: ctx.orgId, clubMemberId: ctx.memberId,
    requestType: String(requestType),
    notes: notes ? String(notes) : null,
    dueBy,
  }).returning();

  // Privacy-request acknowledgement is mandatory: always create an in-app message
  // and best-effort send the email. Fire-and-forget so we don't block the response.
  void (async () => {
    try {
      const result = await notifyDataRequest({
        organizationId: ctx.orgId,
        request: row,
        kind: "filed",
        senderUserId: null,
        logContext: { route: "portal.my-data-requests.post", memberId: ctx.memberId },
      });
      await recordMemberAudit({
        req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
        entity: "data_request_notification", entityId: row.id, action: "create",
        reason: `acknowledgement (${row.requestType}) — email:${result.emailStatus}, in_app:${result.inAppMessageId ? "sent" : "skipped"}, push:${result.pushStatus}, sms:${result.smsStatus}`,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      baseLogger.error({ requestId: row.id, errMsg }, "[portal] Failed to deliver data-request acknowledgement");
    }
  })();

  res.status(201).json(row);
});

// Member-initiated minimum interval between resends of the same notice. Mirrors
// the admin-side resend (Task #186) but rate-limited to prevent abuse: members
// must either wait this long since the last attempt OR have at least one
// channel in the `failed` state before the button is allowed.
const PORTAL_DATA_REQUEST_RESEND_COOLDOWN_MS = 5 * 60 * 1000;

// POST /api/portal/my-data-requests/:id/resend — member resends the last privacy
// notice if it failed or is older than the cooldown window. Mirrors the admin
// resend at /api/admin/.../data-requests/:id/resend, rate-limited per request.
router.post("/portal/my-data-requests/:id/resend", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }

  const [request] = await db.select().from(memberDataRequestsTable)
    .where(and(eq(memberDataRequestsTable.id, id), eq(memberDataRequestsTable.clubMemberId, ctx.memberId)));
  if (!request) { { res.status(404).json({ error: "Not found" }); return; } }

  const NOTIFIABLE: ReadonlySet<DataRequestEmailKind> = new Set(["filed", "in_progress", "completed", "rejected", "completed_export"]);
  const stored = (request.lastNotificationKind as DataRequestEmailKind | null) ?? "filed";
  if (!NOTIFIABLE.has(stored)) {
    res.status(400).json({ error: `Stored notification kind "${stored}" is not resendable.` }); return;
  }
  const kind: DataRequestEmailKind = stored;

  // Eligibility: allow if any channel is `failed` (an actionable, retryable
  // delivery failure) OR the cooldown has elapsed since the last notice.
  // We deliberately do NOT bypass the cooldown for `opted_out` or
  // `no_address` — those are terminal states the member must fix
  // themselves (update phone/email, opt back in) before another resend
  // would change the outcome, and SMS defaults to opted_out so treating
  // it as "needs retry" would let any member resend without limit.
  const now = Date.now();
  const lastAt = request.lastNotifiedAt ? new Date(request.lastNotifiedAt).getTime() : 0;
  const cooldownElapsed = !lastAt || (now - lastAt) >= PORTAL_DATA_REQUEST_RESEND_COOLDOWN_MS;
  const channelNeedsRetry = (
    request.lastEmailStatus === "failed" ||
    request.lastPushStatus === "failed" ||
    request.lastSmsStatus === "failed"
  );
  if (!cooldownElapsed && !channelNeedsRetry) {
    const retryAfterMs = PORTAL_DATA_REQUEST_RESEND_COOLDOWN_MS - (now - lastAt);
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    res.status(429).json({
      error: "Please wait before resending this notice.",
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    });
    return;
  }

  try {
    const result = await notifyDataRequest({
      organizationId: ctx.orgId,
      request,
      kind,
      senderUserId: req.user!.id,
      logContext: { route: "portal.my-data-requests.resend", memberId: ctx.memberId },
    });
    await recordMemberAudit({
      req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
      entity: "data_request_notification", entityId: id, action: "resend",
      reason: `member resent ${kind} notice — email:${result.emailStatus}, in_app:${result.inAppMessageId ? "sent" : "skipped"}, push:${result.pushStatus}, sms:${result.smsStatus}`,
    });
    const [updated] = await db.select().from(memberDataRequestsTable)
      .where(eq(memberDataRequestsTable.id, id));
    res.json({ request: updated, result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    baseLogger.error({ requestId: id, errMsg }, "[portal] Failed to resend data-request notice");
    res.status(500).json({ error: "Failed to resend notification", detail: errMsg });
  }
});

// GET /api/portal/my-export — full member-data export (DPDP §11 / GDPR Article 20)
// ─── LEVY ONLINE PAYMENTS (member-initiated) ─────────────────────────────────
// Members can settle their own outstanding levy charges (full or partial)
// through Razorpay Checkout. Two endpoints:
//   - POST /portal/levies/charges/:chargeId/order  → creates a Razorpay order
//   - POST /portal/levies/charges/:chargeId/verify → verifies signature + applies
// The webhook /api/webhooks/razorpay-levy-payment is the canonical confirmation.

router.post("/portal/levies/charges/:chargeId/order", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { memberId, orgId } = ctx;
  const chargeId = parseInt(String((req.params as Record<string, string>).chargeId));
  if (!Number.isFinite(chargeId)) { { res.status(400).json({ error: "Invalid chargeId" }); return; } }
  const [row] = await db.select({ charge: memberLevyChargesTable, levy: memberLeviesTable })
    .from(memberLevyChargesTable)
    .innerJoin(memberLeviesTable, eq(memberLevyChargesTable.levyId, memberLeviesTable.id))
    .where(and(
      eq(memberLevyChargesTable.id, chargeId),
      eq(memberLevyChargesTable.clubMemberId, memberId),
      eq(memberLeviesTable.organizationId, orgId),
    ));
  if (!row) { { res.status(404).json({ error: "Charge not found" }); return; } }
  if (row.charge.status === "waived" || row.charge.status === "paid" || row.charge.status === "refunded") {
    res.status(400).json({ error: `Charge is ${row.charge.status}` }); return;
  }
  const total = parseFloat(String(row.charge.amount));
  const paid = parseFloat(String(row.charge.paidAmount ?? "0"));
  const refunded = parseFloat(String(row.charge.refundedAmount ?? "0"));
  const remaining = Math.round((total - paid - refunded) * 100) / 100;
  if (remaining <= 0) { { res.status(400).json({ error: "Charge already settled" }); return; } }
  const requested = req.body?.amount != null ? Number(req.body.amount) : remaining;
  if (!Number.isFinite(requested) || requested <= 0) {
    res.status(400).json({ error: "amount must be a positive number" }); return;
  }
  const amount = Math.min(Math.round(requested * 100) / 100, remaining);
  let order;
  try {
    const razorpay = getRazorpayClient();
    order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: row.levy.currency || "INR",
      notes: {
        kind: "levy_charge_payment",
        levyChargeId: String(chargeId),
        levyId: String(row.levy.id),
        clubMemberId: String(memberId),
        organizationId: String(orgId),
      },
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to create payment order" }); return;
  }
  res.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: getRazorpayKeyId(),
    chargeId,
    levyName: row.levy.name,
    requestedAmount: amount,
    remainingBalance: remaining,
  });
});

router.post("/portal/levies/charges/:chargeId/verify", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const { memberId, orgId } = ctx;
  const chargeId = parseInt(String((req.params as Record<string, string>).chargeId));
  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body ?? {};
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    res.status(400).json({ error: "razorpayOrderId, razorpayPaymentId, razorpaySignature are required" }); return;
  }
  if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
    res.status(400).json({ error: "Invalid signature" }); return;
  }
  // Re-fetch order from Razorpay to read trusted amount + notes (don't trust client).
  let order;
  try {
    order = await getRazorpayClient().orders.fetch(razorpayOrderId);
  } catch (err) {
    res.status(502).json({ error: "Failed to verify order with Razorpay" }); return;
  }
  const notes = (order.notes ?? {}) as Record<string, string>;
  if (notes.kind !== "levy_charge_payment" ||
      Number(notes.levyChargeId) !== chargeId ||
      Number(notes.clubMemberId) !== memberId ||
      Number(notes.organizationId) !== orgId) {
    res.status(400).json({ error: "Order does not match this charge" }); return;
  }
  const amountRaw = Number(order.amount);
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    res.status(400).json({ error: "Invalid order amount" }); return;
  }
  const amount = amountRaw / 100;
  const result = await applyLevyChargePayment({
    req,
    organizationId: orgId,
    levyId: Number(notes.levyId),
    clubMemberId: memberId,
    amount,
    source: "member_online",
    providerPaymentId: razorpayPaymentId,
    providerOrderId: razorpayOrderId,
  });
  if (!result.ok) {
    if (result.code === "already_applied") {
      // Webhook already credited this payment — return success so the UI can refresh.
      res.json({ ok: true, alreadyApplied: true });
      return;
    }
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({
    ok: true,
    charge: result.charge,
    remainingBalance: result.remainingBalance,
    appliedAmount: result.appliedAmount,
    fullySettled: result.fullySettled,
  });
});

// Build a portable JSON snapshot of everything we hold for a member. Shared
// between the instant /portal/my-export download and the asynchronous Task
// #468 export queue (/portal/my-data-export) so both flows always agree on
// what counts as "your data".
async function buildMemberDataExportPayload(memberId: number): Promise<Record<string, unknown> | null> {
  const [member] = await db.select().from(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  if (!member) return null;
  // No safeSelect wrapper: portability is a compliance promise. If any section
  // fails to load the caller (POST /portal/my-data-export) catches the error
  // and marks the request `rejected` so a human can investigate, instead of
  // silently shipping a partial archive that the member would not realise is
  // incomplete.
  const [ext, docs, consents, prefs, family, lifecycle, milestones, cards, msgs] = await Promise.all([
    db.select().from(memberProfileExtTable).where(eq(memberProfileExtTable.clubMemberId, memberId)),
    db.select().from(memberDocumentsTable).where(eq(memberDocumentsTable.clubMemberId, memberId)),
    db.select().from(memberConsentsTable).where(eq(memberConsentsTable.clubMemberId, memberId)),
    db.select().from(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, memberId)),
    db.select().from(memberFamilyLinksTable).where(eq(memberFamilyLinksTable.primaryMemberId, memberId)),
    db.select().from(memberLifecycleEventsTable).where(eq(memberLifecycleEventsTable.clubMemberId, memberId)),
    db.select().from(memberMilestonesTable).where(eq(memberMilestonesTable.clubMemberId, memberId)),
    db.select().from(memberAccessCardsTable).where(eq(memberAccessCardsTable.clubMemberId, memberId)),
    db.select().from(memberMessagesTable).where(eq(memberMessagesTable.clubMemberId, memberId)),
  ]);
  // Scores live on `players` (per-tournament participation), not directly on
  // app users. Find every player row owned by this member's user, then scoop
  // the corresponding scores so they ride along in the export.
  let players: Array<typeof playersTable.$inferSelect> = [];
  let scores: Array<typeof scoresTable.$inferSelect> = [];
  if (member.userId) {
    players = await db.select().from(playersTable).where(eq(playersTable.userId, member.userId));
    if (players.length > 0) {
      const ids = players.map((p) => p.id);
      scores = await db.select().from(scoresTable).where(inArray(scoresTable.playerId, ids));
    }
  }
  return {
    exportedAt: new Date().toISOString(),
    member, ext: ext[0] ?? null,
    documents: docs, consents, communicationPreferences: prefs,
    familyLinks: family, lifecycleEvents: lifecycle,
    milestones, accessCards: cards, messages: msgs,
    players, scores,
  };
}

router.get("/portal/my-export", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const payload = await buildMemberDataExportPayload(ctx.memberId);
  if (!payload) { { res.status(404).json({ error: "Member not found" }); return; } }
  res.setHeader("Content-Disposition", `attachment; filename="my-member-data-${ctx.memberId}.json"`);
  res.json(payload);
});

// ─── Self-serve data export queue (Task #468) ────────────────────────────────
// Members can trigger a tracked, archive-style export at any time. The flow
// reuses memberDataRequestsTable with requestType="access" and is parallel to
// the existing erasure flow so the controller dashboard can monitor both. The
// archive is generated immediately, persisted to private object storage, and
// surfaced as a signed download link that expires after 7 days.

import { DATA_EXPORT_VALID_DAYS } from "../lib/dataExportRetention";

function dataExportStatus(row: {
  status: string;
  resolvedAt: Date | string | null;
  artifactUrl: string | null;
}): "pending" | "ready" | "expired" | "failed" {
  if (row.status === "rejected") return "failed";
  if (row.status !== "completed" || !row.resolvedAt) return "pending";
  const resolvedAtMs = new Date(row.resolvedAt).getTime();
  const ageMs = Date.now() - resolvedAtMs;
  if (ageMs > DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000) return "expired";
  // artifactUrl may be null when object storage was unreachable at create
  // time — the download endpoint will regenerate the JSON on demand, so the
  // archive is still effectively "ready" for the member to fetch.
  return "ready";
}

function decorateExport<T extends { status: string; resolvedAt: Date | string | null; artifactUrl: string | null; id: number; purgedAt?: Date | string | null }>(row: T) {
  const computed = dataExportStatus(row);
  const resolvedAtMs = row.resolvedAt ? new Date(row.resolvedAt).getTime() : null;
  const expiresAt = resolvedAtMs ? new Date(resolvedAtMs + DATA_EXPORT_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString() : null;
  // Task #773: surface the actual purge timestamp written by the daily cron
  // so the UI can render "Removed on <date>" instead of inferring the date
  // from the 7-day expiry clock. NULL on legacy rows that were cleared
  // before this column existed; the UI falls back to expiresAt in that case.
  const purgedAt = row.purgedAt ? new Date(row.purgedAt).toISOString() : null;
  return {
    ...row,
    computedStatus: computed,
    expiresAt,
    purgedAt,
    downloadUrl: computed === "ready" ? `/api/portal/my-data-export/${row.id}/download` : null,
    // Companion endpoint that mints a short-lived signed object-storage URL
    // so the client can fetch the archive directly from storage instead of
    // proxying through us. Returns the proxy URL as a fallback when the
    // object isn't available (e.g. storage was unreachable at create time).
    signedUrlEndpoint: computed === "ready" ? `/api/portal/my-data-export/${row.id}/signed-url` : null,
  };
}

// GET /api/portal/my-data-export — list this member's tracked archive exports
router.get("/portal/my-data-export", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const rows = await db.select().from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.clubMemberId, ctx.memberId),
      eq(memberDataRequestsTable.requestType, "access"),
    ))
    .orderBy(desc(memberDataRequestsTable.requestedAt))
    .limit(20);
  // Task #970: also surface the audit timeline rows the daily purge cron
  // writes (entity='data_export', action='purge', metadata.source='cron')
  // so the mobile "My data" screen can show members exactly when the
  // system auto-deleted their archives — closing the data-minimisation
  // loop visibly for the data subject.
  const auditRows = await db.select({
    id: memberAuditLogTable.id,
    entityId: memberAuditLogTable.entityId,
    action: memberAuditLogTable.action,
    reason: memberAuditLogTable.reason,
    metadata: memberAuditLogTable.metadata,
    createdAt: memberAuditLogTable.createdAt,
    actorName: memberAuditLogTable.actorName,
  })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.clubMemberId, ctx.memberId),
      eq(memberAuditLogTable.entity, "data_export"),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt))
    .limit(50);
  res.json({
    exports: rows.map(decorateExport),
    validForDays: DATA_EXPORT_VALID_DAYS,
    auditEntries: auditRows.map(r => ({
      id: r.id,
      exportId: r.entityId,
      action: r.action,
      reason: r.reason,
      source: (r.metadata as Record<string, unknown> | null)?.source ?? null,
      createdAt: r.createdAt,
      actorName: r.actorName,
    })),
  });
});

// POST /api/portal/my-data-export — file a fresh export request and fulfill it
// synchronously. If a still-pending export already exists we return that one
// (idempotent) so members don't accidentally queue duplicates.
router.post("/portal/my-data-export", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const [pending] = await db.select().from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.clubMemberId, ctx.memberId),
      eq(memberDataRequestsTable.requestType, "access"),
      eq(memberDataRequestsTable.status, "pending"),
    ))
    .orderBy(desc(memberDataRequestsTable.requestedAt))
    .limit(1);
  if (pending) {
    res.status(200).json({ export: decorateExport(pending), reused: true });
    return;
  }

  const dueBy = new Date(); dueBy.setDate(dueBy.getDate() + 30);
  const [row] = await db.insert(memberDataRequestsTable).values({
    organizationId: ctx.orgId,
    clubMemberId: ctx.memberId,
    requestType: "access",
    notes: "Self-serve data export (Task #468)",
    dueBy,
  }).returning();

  // Fulfill synchronously: build the JSON snapshot and persist it to private
  // object storage so the same archive can be downloaded multiple times until
  // it expires. If object storage is not available we still mark the request
  // completed without an artifactUrl — the download endpoint will fall back to
  // regenerating the JSON from current data on demand.
  let artifactUrl: string | null = null;
  let archiveStatus: "completed" | "rejected" = "completed";
  let archiveError: string | null = null;
  try {
    const payload = await buildMemberDataExportPayload(ctx.memberId);
    if (!payload) {
      archiveStatus = "rejected";
      archiveError = "Member not found";
    } else {
      try {
        const svc = new ObjectStorageService();
        const buffer = Buffer.from(JSON.stringify(payload, null, 2));
        artifactUrl = await svc.saveRawBuffer(
          `data-exports/${ctx.orgId}/${ctx.memberId}/${row.id}.json`,
          buffer,
          "application/json",
        );
      } catch (err) {
        baseLogger.warn(
          { err: err instanceof Error ? err.message : String(err), requestId: row.id },
          "[portal] data export object storage save failed; falling back to on-demand regeneration",
        );
      }
    }
  } catch (err) {
    archiveStatus = "rejected";
    archiveError = err instanceof Error ? err.message : String(err);
    baseLogger.error({ err: archiveError, requestId: row.id }, "[portal] data export build failed");
  }

  const [updated] = await db.update(memberDataRequestsTable).set({
    status: archiveStatus,
    resolvedAt: new Date(),
    artifactUrl,
    notes: archiveError ? `Export failed: ${archiveError}` : row.notes,
  }).where(eq(memberDataRequestsTable.id, row.id)).returning();

  // Fire-and-forget acknowledgement (mirrors /portal/my-data-requests).
  void (async () => {
    try {
      const result = await notifyDataRequest({
        organizationId: ctx.orgId,
        request: updated,
        // Task #618: dedicated `completed_export` kind so members get a
        // self-explanatory subject + a one-tap download CTA over email
        // and push, not just the generic "privacy request completed" notice.
        kind: archiveStatus === "completed" ? "completed_export" : "rejected",
        senderUserId: null,
        logContext: { route: "portal.my-data-export.post", memberId: ctx.memberId },
      });
      await recordMemberAudit({
        req, organizationId: ctx.orgId, clubMemberId: ctx.memberId,
        entity: "data_request_notification", entityId: updated.id, action: "create",
        reason: `data export (${archiveStatus}) — email:${result.emailStatus}, in_app:${result.inAppMessageId ? "sent" : "skipped"}, push:${result.pushStatus}, sms:${result.smsStatus}`,
      });
    } catch (err) {
      baseLogger.error({ err: err instanceof Error ? err.message : String(err), requestId: updated.id }, "[portal] export acknowledgement failed");
    }
  })();

  res.status(201).json({ export: decorateExport(updated), reused: false });
});

// GET /api/portal/my-data-export/:id/signed-url — issue a fresh, short-lived
// signed object-storage URL the member can hit directly to download their
// archive without proxying through the API server. Falls back to the
// authenticated /download endpoint when the underlying object isn't present
// (e.g. when the storage sidecar wasn't reachable at create time).
router.get("/portal/my-data-export/:id/signed-url", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const [row] = await db.select().from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.id, id),
      eq(memberDataRequestsTable.clubMemberId, ctx.memberId),
      eq(memberDataRequestsTable.requestType, "access"),
    ));
  if (!row) { { res.status(404).json({ error: "Export not found" }); return; } }
  const computed = dataExportStatus(row);
  if (computed === "expired") { { res.status(410).json({ error: "Export has expired. Please request a fresh one." }); return; } }
  if (computed !== "ready") { { res.status(409).json({ error: `Export not ready (${computed}).` }); return; } }
  if (!row.artifactUrl) {
    // No stored object — fall back to the authenticated proxy download URL so
    // the member is never stuck without a way to retrieve their archive.
    res.json({ url: `/api/portal/my-data-export/${row.id}/download`, signed: false, expiresInSec: null });
    return;
  }
  try {
    const svc = new ObjectStorageService();
    const ttlSec = 15 * 60;
    const signedUrl = await svc.getSignedDownloadUrl(row.artifactUrl, ttlSec);
    // Task #922: stamp the moment a member fetches a fresh signed-URL so the
    // daily "expires in 24h" reminder cron can suppress the nudge for
    // members who already grabbed the file. Best-effort; never fail the
    // download just because this stamp didn't land.
    if (!row.artifactDownloadedAt) {
      try {
        await db.update(memberDataRequestsTable)
          .set({ artifactDownloadedAt: new Date() })
          .where(eq(memberDataRequestsTable.id, row.id));
      } catch (stampErr) {
        baseLogger.warn(
          { err: stampErr instanceof Error ? stampErr.message : String(stampErr), requestId: row.id },
          "[portal] artifactDownloadedAt stamp failed (signed-url)",
        );
      }
    }
    res.json({ url: signedUrl, signed: true, expiresInSec: ttlSec });
  } catch (err) {
    baseLogger.warn(
      { err: err instanceof Error ? err.message : String(err), requestId: row.id },
      "[portal] signed url generation failed; returning proxy download fallback",
    );
    res.json({ url: `/api/portal/my-data-export/${row.id}/download`, signed: false, expiresInSec: null });
  }
});

// GET /api/portal/my-data-export/:id/download — stream the archive (signed
// download). Member must own the request, the artifact must be unexpired.
router.get("/portal/my-data-export/:id/download", async (req: Request, res: Response) => {
  const ctx = await resolveMemberContext(req, res); if (!ctx) return;
  const id = parseInt(String((req.params as Record<string, string>).id));
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "Invalid id" }); return; } }
  const [row] = await db.select().from(memberDataRequestsTable)
    .where(and(
      eq(memberDataRequestsTable.id, id),
      eq(memberDataRequestsTable.clubMemberId, ctx.memberId),
      eq(memberDataRequestsTable.requestType, "access"),
    ));
  if (!row) { { res.status(404).json({ error: "Export not found" }); return; } }
  const computed = dataExportStatus(row);
  if (computed === "expired") { { res.status(410).json({ error: "Export has expired. Please request a fresh one." }); return; } }
  if (computed === "failed") { { res.status(409).json({ error: "Export failed. Please request a fresh one." }); return; } }
  if (computed === "pending") { { res.status(409).json({ error: "Export still being generated." }); return; } }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="my-member-data-${ctx.memberId}-${row.id}.json"`);

  // Task #922: stamp the moment the member streams the archive so the daily
  // "expires in 24h" reminder cron knows they already have a copy. Best-
  // effort; we never fail the download just because this stamp didn't land.
  if (!row.artifactDownloadedAt) {
    try {
      await db.update(memberDataRequestsTable)
        .set({ artifactDownloadedAt: new Date() })
        .where(eq(memberDataRequestsTable.id, row.id));
    } catch (stampErr) {
      baseLogger.warn(
        { err: stampErr instanceof Error ? stampErr.message : String(stampErr), requestId: row.id },
        "[portal] artifactDownloadedAt stamp failed (download)",
      );
    }
  }

  if (row.artifactUrl) {
    try {
      const svc = new ObjectStorageService();
      const file = await svc.getObjectEntityFile(row.artifactUrl);
      const [buffer] = await file.download();
      res.send(buffer);
      return;
    } catch (err) {
      baseLogger.warn(
        { err: err instanceof Error ? err.message : String(err), requestId: row.id },
        "[portal] data export object fetch failed; regenerating on demand",
      );
    }
  }

  // Fallback: regenerate from current data so the member is never left without
  // their export when object storage is unreachable.
  const payload = await buildMemberDataExportPayload(ctx.memberId);
  if (!payload) { { res.status(404).json({ error: "Member not found" }); return; } }
  res.send(JSON.stringify(payload, null, 2));
});

// ─── Spectator Follows (Task #377) ───────────────────────────────────────────
import { spectatorFollowsTable } from "@workspace/db";

// GET /api/portal/spectator-follows?tournamentId=...
router.get("/portal/spectator-follows", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = getPortalUserId(req)!;
  const tournamentId = req.query.tournamentId ? parseInt(req.query.tournamentId as string) : null;
  const conds = [eq(spectatorFollowsTable.userId, userId)];
  if (tournamentId) conds.push(eq(spectatorFollowsTable.tournamentId, tournamentId));
  const rows = await db.select().from(spectatorFollowsTable).where(and(...conds));
  res.json({ follows: rows });
});

// POST /api/portal/spectator-follows
// body: { tournamentId, playerId? | teeTimeId?, notify*? }
router.post("/portal/spectator-follows", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = getPortalUserId(req)!;
  const {
    tournamentId, playerId = null, teeTimeId = null,
    notifyBirdie = true, notifyEagle = true, notifyHio = true,
    notifyRoundStart = false, notifyRoundFinish = true, notifyTeeOff = true,
  } = req.body ?? {};
  if (!tournamentId || (!playerId && !teeTimeId)) {
    res.status(400).json({ error: "tournamentId and one of playerId|teeTimeId required" }); return;
  }
  const [row] = await db.insert(spectatorFollowsTable).values({
    userId, tournamentId, playerId, teeTimeId,
    notifyBirdie, notifyEagle, notifyHio,
    notifyRoundStart, notifyRoundFinish, notifyTeeOff,
  }).returning();
  res.status(201).json({ follow: row });
});

// PATCH /api/portal/spectator-follows/:id — update notify prefs
router.patch("/portal/spectator-follows/:id", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = getPortalUserId(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const allowed = ["notifyBirdie", "notifyEagle", "notifyHio", "notifyRoundStart", "notifyRoundFinish", "notifyTeeOff"] as const;
  const patch: Record<string, boolean> = {};
  for (const k of allowed) if (typeof req.body?.[k] === "boolean") patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) { { res.status(400).json({ error: "No valid fields" }); return; } }
  const [row] = await db.update(spectatorFollowsTable)
    .set(patch)
    .where(and(eq(spectatorFollowsTable.id, id), eq(spectatorFollowsTable.userId, userId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Not found" }); return; } }
  res.json({ follow: row });
});

// DELETE /api/portal/spectator-follows/:id
router.delete("/portal/spectator-follows/:id", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = getPortalUserId(req)!;
  const id = parseInt(String((req.params as Record<string, string>).id));
  const result = await db.delete(spectatorFollowsTable)
    .where(and(eq(spectatorFollowsTable.id, id), eq(spectatorFollowsTable.userId, userId)))
    .returning({ id: spectatorFollowsTable.id });
  if (result.length === 0) { { res.status(404).json({ error: "Not found" }); return; } }
  res.status(204).end();
});

// POST /api/portal/spectator-test-push (Task #803)
// Sends the requesting member a sample spectator highlight push translated
// into their currently selected language so they can verify the wording
// before subscribing to real follows. Rate-limited per user: a 30 s cooldown
// between attempts plus a hard cap of 5 sends per rolling hour.
const _spectatorTestPushAttempts = new Map<number, { recent: number[]; lastAt: number }>();
const SPECTATOR_TEST_PUSH_COOLDOWN_MS = 30 * 1000;
const SPECTATOR_TEST_PUSH_HOURLY_CAP = 5;
function _checkSpectatorTestPushRateLimit(userId: number): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = _spectatorTestPushAttempts.get(userId) ?? { recent: [], lastAt: 0 };
  if (now - entry.lastAt < SPECTATOR_TEST_PUSH_COOLDOWN_MS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((SPECTATOR_TEST_PUSH_COOLDOWN_MS - (now - entry.lastAt)) / 1000) };
  }
  entry.recent = entry.recent.filter(t => now - t < 60 * 60 * 1000);
  if (entry.recent.length >= SPECTATOR_TEST_PUSH_HOURLY_CAP) {
    return { allowed: false, retryAfterSeconds: Math.ceil((60 * 60 * 1000 - (now - entry.recent[0]!)) / 1000) };
  }
  entry.recent.push(now);
  entry.lastAt = now;
  _spectatorTestPushAttempts.set(userId, entry);
  return { allowed: true, retryAfterSeconds: 0 };
}
// Test export so unit tests can reset between cases.
export function _resetSpectatorTestPushRateLimit(): void {
  _spectatorTestPushAttempts.clear();
}

const SPECTATOR_TEST_EVENT_TYPES = new Set<ScoringEvent["eventType"]>([
  "hole_in_one", "eagle", "birdie", "round_start", "round_finish", "tee_off",
]);

router.post("/portal/spectator-test-push", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = getPortalUserId(req)!;

  const rl = _checkSpectatorTestPushRateLimit(userId);
  if (!rl.allowed) {
    res.status(429).json({
      error: "Too many test notifications. Please wait before trying again.",
      retryAfterSeconds: rl.retryAfterSeconds,
    });
    return;
  }

  const requestedType = typeof req.body?.eventType === "string" ? req.body.eventType : "birdie";
  const eventType: ScoringEvent["eventType"] = SPECTATOR_TEST_EVENT_TYPES.has(requestedType as ScoringEvent["eventType"])
    ? (requestedType as ScoringEvent["eventType"])
    : "birdie";

  const [u] = await db
    .select({
      lang: appUsersTable.preferredLanguage,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId));

  // Optional `lang` override lets the web spectator page (Task #941) preview
  // the alert in whatever language they have currently selected in the UI,
  // even if it differs from their stored `preferredLanguage`. We validate it
  // against the shared spectator-push translator's supported list and fall
  // back to the user's saved preference (then English) if it isn't supported.
  const requestedLang = typeof req.body?.lang === "string" ? req.body.lang : null;
  const lang = isSupportedSpectatorPushLang(requestedLang)
    ? requestedLang
    : (u?.lang ?? "en");
  const firstName = (u?.displayName?.trim().split(/\s+/)[0]) || u?.username || "Alex";

  const fakeEvent: ScoringEvent = {
    tournamentId: 0,
    playerId: userId,
    playerName: firstName,
    holeNumber: 7,
    strokes: 3,
    par: 4,
    toPar: -1,
    eventType,
    occurredAt: new Date().toISOString(),
    round: 1,
  };

  const { title, body } = translateSpectatorPush(lang, fakeEvent);

  const tokenRows = await db
    .select({ token: deviceTokensTable.token })
    .from(deviceTokensTable)
    .where(eq(deviceTokensTable.userId, userId));

  if (tokenRows.length === 0) {
    // Task #1463 — also report `classification: "no_address"` here so a
    // user with zero registered devices is surfaced under the same
    // delivery-status taxonomy as the post-fan-out branch below
    // (Task #1240). Otherwise admin tooling and tests have to special-case
    // this early return as a third "neither sent nor classified" state.
    res.status(200).json({
      delivered: false,
      classification: "no_address",
      reason: "no_device_token",
      language: lang,
      preview: { title, body },
    });
    return;
  }

  const result = await sendPushToUsers([userId], title, body, {
    type: "spectator_test",
    lang,
    eventType,
  });

  // Task #1240 — share the classifier with the *Notify* helpers so this
  // admin debug endpoint reports "no_address" instead of a misleading
  // delivered=false / failed=0 combination if the recipient happens to
  // have only invalid (non-Expo) tokens registered.
  const cls = classifyPushDelivery(result);
  res.json({
    delivered: cls === "sent",
    classification: cls,
    sent: result.sent,
    failed: result.failed,
    invalid: result.invalid,
    language: lang,
    preview: { title, body },
  });
});

// ---------------------------------------------------------------------------
// Email subscription self-service — Task #647
//
// Lets a signed-in member see every per-org email opt-out they currently have
// and toggle each one on or off without needing the original token-link from
// an email or admin involvement.
//
// The registry below is the single source of truth for which email types are
// surfaced on the profile "Email preferences" page. Adding a new opt-out
// table only requires extending this registry: the GET/POST endpoints and
// the UI table iterate over it generically.
// ---------------------------------------------------------------------------
type EmailSubscriptionType = {
  key: string;
  label: string;
  description: string;
  listOptOuts: (userId: number) => Promise<{ organizationId: number; optedOutAt: Date }[]>;
  insertOptOut: (userId: number, orgId: number) => Promise<void>;
  deleteOptOut: (userId: number, orgId: number) => Promise<void>;
};

const EMAIL_SUBSCRIPTION_TYPES: EmailSubscriptionType[] = [
  {
    key: "bounced_digest_schedule",
    label: "Bounced-reminders digest schedule changes",
    description:
      "Heads-up email sent when an org admin changes the schedule of the bounced-levy reminders digest. Opting out does not affect the regular digest itself.",
    listOptOuts: async (userId) => {
      const { bouncedDigestScheduleOptOutsTable } = await import("@workspace/db");
      return db
        .select({
          organizationId: bouncedDigestScheduleOptOutsTable.organizationId,
          optedOutAt: bouncedDigestScheduleOptOutsTable.optedOutAt,
        })
        .from(bouncedDigestScheduleOptOutsTable)
        .where(eq(bouncedDigestScheduleOptOutsTable.userId, userId));
    },
    insertOptOut: async (userId, orgId) => {
      const { bouncedDigestScheduleOptOutsTable } = await import("@workspace/db");
      await db
        .insert(bouncedDigestScheduleOptOutsTable)
        .values({ organizationId: orgId, userId })
        .onConflictDoNothing();
    },
    deleteOptOut: async (userId, orgId) => {
      const { bouncedDigestScheduleOptOutsTable } = await import("@workspace/db");
      await db.delete(bouncedDigestScheduleOptOutsTable).where(and(
        eq(bouncedDigestScheduleOptOutsTable.organizationId, orgId),
        eq(bouncedDigestScheduleOptOutsTable.userId, userId),
      ));
    },
  },
  {
    // Task #1045 — round-robin tie-break required alert email (Task #898).
    // Mirrors the one-click footer link in the email itself, so a director
    // who toggled off here will not receive the email even if a tie-break
    // is generated for them.
    key: "round_robin_tie_break_email",
    label: "Round-robin tie-break required alerts",
    description:
      "Email sent to tournament directors when a round-robin tie-break match is auto-generated. Push notifications and the in-app inbox row are unaffected.",
    listOptOuts: async (userId) => {
      const { roundRobinTieBreakEmailOptOutsTable } = await import("@workspace/db");
      return db
        .select({
          organizationId: roundRobinTieBreakEmailOptOutsTable.organizationId,
          optedOutAt: roundRobinTieBreakEmailOptOutsTable.optedOutAt,
        })
        .from(roundRobinTieBreakEmailOptOutsTable)
        .where(eq(roundRobinTieBreakEmailOptOutsTable.userId, userId));
    },
    insertOptOut: async (userId, orgId) => {
      const { roundRobinTieBreakEmailOptOutsTable } = await import("@workspace/db");
      await db
        .insert(roundRobinTieBreakEmailOptOutsTable)
        .values({ organizationId: orgId, userId })
        .onConflictDoNothing();
    },
    deleteOptOut: async (userId, orgId) => {
      const { roundRobinTieBreakEmailOptOutsTable } = await import("@workspace/db");
      await db.delete(roundRobinTieBreakEmailOptOutsTable).where(and(
        eq(roundRobinTieBreakEmailOptOutsTable.organizationId, orgId),
        eq(roundRobinTieBreakEmailOptOutsTable.userId, userId),
      ));
    },
  },
];

function findEmailSubscriptionType(key: unknown): EmailSubscriptionType | null {
  if (typeof key !== "string") return null;
  return EMAIL_SUBSCRIPTION_TYPES.find(t => t.key === key) ?? null;
}

// GET /api/portal/email-subscriptions — Task #647
// Returns the catalog of opt-outable email types and a row per (org, email-type)
// the caller is currently *eligible* to receive — i.e. the cross product of the
// user's org memberships (plus, if they have one, their session org and any org
// they already have an opt-out row for) with the catalog of email types. Each
// row carries the current `optedOut` state plus org-side display data so the
// UI can render a true bi-directional toggle without leaving the page.
router.get("/portal/email-subscriptions", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const sessionOrgId = (req.user as { organizationId?: number | null }).organizationId ?? null;

  // 1) Collect all opt-outs the user already has (across every type).
  const perType = await Promise.all(EMAIL_SUBSCRIPTION_TYPES.map(async (t) => {
    const optOuts = await t.listOptOuts(userId);
    return { type: t, optOuts };
  }));

  // 2) Eligible orgs = explicit org memberships ∪ session org ∪ any org we have
  //    an opt-out row for (so a row already opted out always remains visible
  //    even if the membership relationship has since lapsed).
  const memberships = await db
    .select({ orgId: orgMembershipsTable.organizationId })
    .from(orgMembershipsTable)
    .where(eq(orgMembershipsTable.userId, userId));
  const eligibleOrgIds = new Set<number>(memberships.map(r => r.orgId));
  if (sessionOrgId != null) eligibleOrgIds.add(sessionOrgId);
  for (const { optOuts } of perType) for (const r of optOuts) eligibleOrgIds.add(r.organizationId);

  const orgIdList = Array.from(eligibleOrgIds);
  const orgs = orgIdList.length === 0 ? [] : await db
    .select({ id: organizationsTable.id, name: organizationsTable.name })
    .from(organizationsTable)
    .where(inArray(organizationsTable.id, orgIdList));
  const orgNameById = new Map(orgs.map(o => [o.id, o.name]));

  // 3) Build the cross product, marking each row's current opted-out state.
  const subscriptions: Array<{
    orgId: number;
    orgName: string;
    emailType: string;
    emailTypeLabel: string;
    emailTypeDescription: string;
    optedOut: boolean;
    optedOutAt: Date | null;
  }> = [];

  for (const orgId of orgIdList) {
    const orgName = orgNameById.get(orgId);
    if (!orgName) continue; // org was hard-deleted — skip silently
    for (const { type, optOuts } of perType) {
      const existing = optOuts.find(r => r.organizationId === orgId);
      subscriptions.push({
        orgId,
        orgName,
        emailType: type.key,
        emailTypeLabel: type.label,
        emailTypeDescription: type.description,
        optedOut: !!existing,
        optedOutAt: existing?.optedOutAt ?? null,
      });
    }
  }
  subscriptions.sort((a, b) =>
    a.orgName.localeCompare(b.orgName) || a.emailTypeLabel.localeCompare(b.emailTypeLabel));

  res.json({
    types: EMAIL_SUBSCRIPTION_TYPES.map(t => ({
      key: t.key, label: t.label, description: t.description,
    })),
    subscriptions,
  });
});

// POST /api/portal/email-subscriptions/unsubscribe — Task #647
// Body: { orgId: number, emailType: string }
// Idempotent — repeated calls leave a single opt-out row. Bad org ids are
// caught by the table's FK constraint, surfaced here as a 400 to keep the
// response shape consistent with other malformed-input branches (and aligned
// with /resubscribe, which is a no-op delete in the same situation).
router.post("/portal/email-subscriptions/unsubscribe", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const orgId = Number(req.body?.orgId);
  const type = findEmailSubscriptionType(req.body?.emailType);
  if (!Number.isInteger(orgId) || orgId <= 0) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!type) { { res.status(400).json({ error: "Unknown emailType" }); return; } }
  try {
    await type.insertOptOut(userId, orgId);
  } catch (err: unknown) {
    // FK violation on organization_id => unknown org. Treat as a 400 rather
    // than a 500 since the input is the issue. Drizzle/pg surface the code
    // either at err.code or err.cause.code depending on driver wrapping.
    const code = (err as { code?: string } | null)?.code
      ?? (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (code === "23503") { { res.status(400).json({ error: "Unknown organization" }); return; } }
    throw err;
  }
  res.status(204).end();
});

// POST /api/portal/email-subscriptions/resubscribe — Task #647
// Body: { orgId: number, emailType: string }
// Idempotent — resubscribing when no opt-out row exists is a no-op 204.
router.post("/portal/email-subscriptions/resubscribe", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const orgId = Number(req.body?.orgId);
  const type = findEmailSubscriptionType(req.body?.emailType);
  if (!Number.isInteger(orgId) || orgId <= 0) { { res.status(400).json({ error: "Invalid orgId" }); return; } }
  if (!type) { { res.status(400).json({ error: "Unknown emailType" }); return; } }
  await type.deleteOptOut(userId, orgId);
  res.status(204).end();
});

// Wave 1 W1-D — Personal baseline endpoint.
// GET /portal/player/baseline?days=30&tournamentId=&generalPlayRoundId=&round=
// Returns trailing-N-day average SG per category, and (when a round
// key is supplied) the values for that round + the delta vs baseline.
router.get("/portal/player/baseline", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;

  const days = req.query.days ? parseInt(String(req.query.days)) : 30;
  const tournamentId = req.query.tournamentId ? parseInt(String(req.query.tournamentId)) : undefined;
  const generalPlayRoundId = req.query.generalPlayRoundId ? parseInt(String(req.query.generalPlayRoundId)) : undefined;
  const round = req.query.round ? parseInt(String(req.query.round)) : undefined;

  const thisRoundKey = (tournamentId || generalPlayRoundId)
    ? { tournamentId, generalPlayRoundId, round }
    : undefined;

  const result = await computePlayerBaseline(userId, { windowDays: days, thisRoundKey });
  res.json(result);
});

// Task #1002 — proximity to pin grouped by club. Mean & p90 in feet, plus
// green-in-regulation rate. Restricted to a recent trailing window so the
// chart reflects current form rather than career-long averages.
//
// Task #1349 — Resolve which of the three benchmarks (tour / scratch / mid-
// handicap) the chart should highlight as the *primary* comparison for this
// player. Resolution order:
//   1. `?baseline=tour|scratch|mid` query param (one-off override)
//   2. `app_users.preferred_proximity_baseline` (player's pinned choice)
//   3. Auto-derived from the player's current handicap index
//      (≤4 → tour, ≤12 → scratch, otherwise mid)
// The full benchmark trio is still returned per club so the UI can offer a
// "see other baselines" toggle without a second round-trip.
router.get("/portal/player/proximity-by-club", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const rawDays = req.query.days ? parseInt(String(req.query.days)) : 30;
  const days = Math.max(1, Math.min(365, Number.isFinite(rawDays) ? rawDays : 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const overrideRaw = typeof req.query.baseline === "string" ? req.query.baseline : null;
  const override = overrideRaw === "auto" ? null : overrideRaw;

  // Pull the player's pinned preference + best-available handicap index in
  // parallel with the shot fetch. The handicap index can come from three
  // places, in order of authority: the official WHS state row (latest
  // recalc), the most recent handicap_history snapshot, or the most recent
  // tournament registration. We accept the first one we find so a brand-new
  // member with only a registration row still gets a tailored baseline.
  const [shotRows, prefRow, whsRow, hcpHistoryRow, playerHcpRow] = await Promise.all([
    fetchAllUserShots(userId),
    db.select({ pref: appUsersTable.preferredProximityBaseline })
      .from(appUsersTable).where(eq(appUsersTable.id, userId)).limit(1),
    db.select({ hi: whsPlayerStateTable.currentHandicapIndex, asOf: whsPlayerStateTable.lastRecalcAt })
      .from(whsPlayerStateTable)
      .where(eq(whsPlayerStateTable.userId, userId))
      .orderBy(desc(whsPlayerStateTable.lastRecalcAt))
      .limit(1)
      .catch(() => [] as { hi: string | null; asOf: Date | null }[]),
    db.select({ hi: handicapHistoryTable.handicapIndex, asOf: handicapHistoryTable.recordedAt })
      .from(handicapHistoryTable)
      .where(eq(handicapHistoryTable.userId, userId))
      .orderBy(desc(handicapHistoryTable.recordedAt))
      .limit(1),
    db.select({ hi: playersTable.handicapIndex, asOf: playersTable.registeredAt })
      .from(playersTable)
      .where(and(eq(playersTable.userId, userId), isNotNull(playersTable.handicapIndex)))
      .orderBy(desc(playersTable.registeredAt))
      .limit(1),
  ]);

  const recent = shotRows.filter(s => {
    const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
    return t >= since.getTime();
  });

  // Task #1640 — bucket the *previous* `days`-day window so the coaching tip
  // can quote a 30-day-vs-prior-30-day delta ("−2.1 ft from prev 30d", "no
  // change", "+1.4 ft — slipping"). Window is the same length as the current
  // one, immediately preceding it: [since - days, since).
  const prevWindowStart = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);
  const previous = shotRows.filter(s => {
    const t = s.recordedAt instanceof Date ? s.recordedAt.getTime() : 0;
    return t >= prevWindowStart.getTime() && t < since.getTime();
  });

  const preference = prefRow[0]?.pref ?? null;
  // Task #1644 — track which of the three sources the handicap came from so
  // the UI can tell players "Where this comes from": the live WHS state, the
  // most recent handicap_history snapshot, or the legacy players row. Same
  // priority order as before — first non-null wins.
  type HandicapSource = "whs" | "history" | "profile";
  let rawHi: string | null = null;
  let handicapSource: HandicapSource | null = null;
  let handicapAsOf: Date | null = null;
  if (whsRow[0]?.hi != null) {
    rawHi = whsRow[0].hi;
    handicapSource = "whs";
    handicapAsOf = whsRow[0].asOf ?? null;
  } else if (hcpHistoryRow[0]?.hi != null) {
    rawHi = hcpHistoryRow[0].hi;
    handicapSource = "history";
    handicapAsOf = hcpHistoryRow[0].asOf ?? null;
  } else if (playerHcpRow[0]?.hi != null) {
    rawHi = playerHcpRow[0].hi;
    handicapSource = "profile";
    handicapAsOf = playerHcpRow[0].asOf ?? null;
  }
  const handicapIndex = rawHi != null ? parseFloat(String(rawHi)) : null;
  const { primary, source } = resolveProximityBaseline({ override, preference, handicapIndex });

  const clubs = computeProximityByClub(recent);
  const previousClubs = computeProximityByClub(previous);
  // Task #1348 — surface the 1-2 clubs with the largest gap vs tour as a
  // "work on this club" coaching tip so players see an action, not just a
  // chart they have to interpret. The same shape powers the AI Caddie hint
  // (see /portal/caddie/recommend) so post-round and on-course advice agree.
  // Task #1640 — pass the previous-window stats so each tip carries a trend
  // annotation and the AI Caddie hint can flip to encouragement when the
  // gap is closing.
  const coachingTips = computeProximityCoachingTips(clubs, {
    previousStats: previousClubs,
    previousWindowLabel: `prev ${days}d`,
  });
  // Task #2039 — enrich each tip with a 6-bucket weekly gap-vs-tour history
  // so the client can render an inline sparkline next to the trend label.
  // Done in the route (not in `computeProximityCoachingTips`) because the
  // helper works on already-aggregated stats — only the route still has the
  // raw shot rows needed for the per-week bucketing.
  const enrichedCoachingTips = coachingTips.map(tip => ({
    ...tip,
    weeklyGapHistory: computeWeeklyProximityHistory(shotRows, {
      club: tip.club,
      tourMeanFt: tip.tourMeanFt,
      weeks: 6,
    }),
  }));
  res.json({
    windowDays: days,
    windowStart: since.toISOString(),
    previousWindowStart: prevWindowStart.toISOString(),
    handicapIndex: handicapIndex !== null && Number.isFinite(handicapIndex) ? handicapIndex : null,
    // Task #1644 — surface where the handicap came from + how stale it is so
    // the player can decide whether to update WHS, log a round, or edit their
    // profile. `null` here means we have no handicap on file at all and the
    // UI should link the player to where they can add one.
    handicapSource,
    handicapAsOf: handicapAsOf ? handicapAsOf.toISOString() : null,
    preferredBaseline: preference ?? "auto",
    primaryBaseline: primary,
    baselineSource: source,
    clubs,
    coachingTips: enrichedCoachingTips,
  });
});

// Task #1349 — Persist the player's pinned proximity baseline so the chart
// remembers it across sessions and devices. Body: { baseline: 'auto'|'tour'|
// 'scratch'|'mid' }. 'auto' clears the pin and re-enables handicap-based
// auto-derivation.
router.put("/portal/player/proximity-baseline-preference", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const raw = (req.body as { baseline?: unknown }).baseline;
  if (typeof raw !== "string" || !["auto", "tour", "scratch", "mid"].includes(raw)) {
    res.status(400).json({ error: "baseline must be one of: auto, tour, scratch, mid" });
    return;
  }
  const next = raw === "auto" ? null : raw;
  await db.update(appUsersTable)
    .set({ preferredProximityBaseline: next, updatedAt: new Date() })
    .where(eq(appUsersTable.id, userId));
  res.json({ preferredBaseline: next ?? "auto" });
});

// Task #1002 — weather correlation. Buckets the player's recent rounds by
// the wind speed and mean temperature observed at the course on the round
// date (Open-Meteo archive) and returns SG-Total delta vs baseline.
router.get("/portal/player/weather-correlation", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const days = req.query.days ? parseInt(String(req.query.days)) : 30;
  const result = await computeWeatherCorrelation(userId, { windowDays: days });
  res.json(result);
});

// Wave 1 W1-D — Auto-club inference. Returns a suggestion only; the UI
// (HoleShotReviewModal) decides whether to apply it.
router.post("/portal/shots/infer-club", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = (req.user as { id: number }).id;
  const { distanceYards, toleranceYards } = req.body as {
    distanceYards?: number; toleranceYards?: number;
  };
  if (typeof distanceYards !== "number" || !Number.isFinite(distanceYards) || distanceYards <= 0) {
    res.status(400).json({ error: "distanceYards (positive number) is required" });
    return;
  }
  const suggestion = await inferClub({
    userId,
    distanceYards,
    toleranceYards: typeof toleranceYards === "number" ? toleranceYards : undefined,
  });
  res.json(suggestion);
});

// ── Round-robin tie-break inbox (Task #1050) ─────────────────────────
// Surfaces `member_messages` rows tagged `relatedEntity = 'round_robin_tie_break'`
// (written by `notifyRoundRobinTieBreak`) so the mobile in-app inbox can
// list the tie-break alert alongside handicap-committee notifications.
// Recipients miss the push or clear it from the OS shade and currently have
// no way to discover the new tie-break match from inside the app.
//
// Each row is enriched with the parent tournamentId (resolved through the
// bracket join chain) so the client can deep-link to
// `/(tabs)/match-play?tournamentId=…&focusMatchId=…` — the same contract the
// push handler in `app/_layout.tsx` honours.
router.get("/portal/my-tie-break-messages", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const memberRows = await db
    .select({ id: clubMembersTable.id, organizationId: clubMembersTable.organizationId })
    .from(clubMembersTable)
    .where(eq(clubMembersTable.userId, userId));
  if (memberRows.length === 0) {
    res.json({ unreadCount: 0, items: [] });
    return;
  }
  const memberIds = memberRows.map(m => m.id);

  const messages = await db
    .select({
      id: memberMessagesTable.id,
      organizationId: memberMessagesTable.organizationId,
      subject: memberMessagesTable.subject,
      body: memberMessagesTable.body,
      sentAt: memberMessagesTable.sentAt,
      readAt: memberMessagesTable.readAt,
      relatedEntityId: memberMessagesTable.relatedEntityId,
      orgName: organizationsTable.name,
    })
    .from(memberMessagesTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, memberMessagesTable.organizationId))
    .where(and(
      inArray(memberMessagesTable.clubMemberId, memberIds),
      eq(memberMessagesTable.relatedEntity, "round_robin_tie_break"),
      eq(memberMessagesTable.channel, "in_app"),
    ))
    .orderBy(desc(memberMessagesTable.sentAt))
    .limit(100);

  const matchIds = messages
    .map(m => m.relatedEntityId)
    .filter((x): x is number => x != null);
  const tournamentByMatchId = new Map<number, number>();
  if (matchIds.length > 0) {
    const matches = await db
      .select({
        matchId: bracketMatchesTable.id,
        tournamentId: matchPlayBracketTable.tournamentId,
      })
      .from(bracketMatchesTable)
      .innerJoin(matchPlayBracketTable, eq(matchPlayBracketTable.id, bracketMatchesTable.bracketId))
      .where(inArray(bracketMatchesTable.id, matchIds));
    for (const m of matches) tournamentByMatchId.set(m.matchId, m.tournamentId);
  }

  let unreadCount = 0;
  const items = messages.map(m => {
    if (!m.readAt) unreadCount += 1;
    return {
      id: m.id,
      organizationId: m.organizationId,
      orgName: m.orgName,
      subject: m.subject,
      body: m.body,
      sentAt: m.sentAt.toISOString(),
      readAt: m.readAt?.toISOString() ?? null,
      matchId: m.relatedEntityId,
      tournamentId: m.relatedEntityId != null
        ? tournamentByMatchId.get(m.relatedEntityId) ?? null
        : null,
    };
  });
  res.json({ unreadCount, items });
});

// ── Feed-post inbox (Task #2111) ─────────────────────────────────────
// Surfaces `member_messages` rows tagged `relatedEntity = 'feed_post'`
// (written by `fanoutFeedPostPush` in `routes/feed.ts`) so the mobile
// in-app notifications inbox can list "Pat posted to the feed" entries
// alongside handicap-committee and tie-break notifications.
//
// Without this surface, members who silenced their phone or whose OS
// dropped the push had no way to discover the new post from the
// notifications screen — the post still appeared on the Feed tab but
// never landed in the persistent inbox history. Mirrors the read /
// mark-read shape of `/portal/my-tie-break-messages` so the mobile
// `notifications.tsx` screen can fetch both with the same pagination
// and unread-count contract.
//
// Each row is enriched with the parent post's `organizationId` so the
// client can deep-link to `/(tabs)/feed?orgId=…&focusPostId=…` —
// matching the deep-link contract the push handler in
// `utils/handleNotificationData.ts` would honour for `type: feed_post`.
router.get("/portal/my-feed-post-messages", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;

  const memberRows = await db
    .select({ id: clubMembersTable.id, organizationId: clubMembersTable.organizationId })
    .from(clubMembersTable)
    .where(eq(clubMembersTable.userId, userId));
  if (memberRows.length === 0) {
    res.json({ unreadCount: 0, items: [] });
    return;
  }
  const memberIds = memberRows.map(m => m.id);

  const messages = await db
    .select({
      id: memberMessagesTable.id,
      organizationId: memberMessagesTable.organizationId,
      subject: memberMessagesTable.subject,
      body: memberMessagesTable.body,
      sentAt: memberMessagesTable.sentAt,
      readAt: memberMessagesTable.readAt,
      relatedEntityId: memberMessagesTable.relatedEntityId,
      orgName: organizationsTable.name,
    })
    .from(memberMessagesTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, memberMessagesTable.organizationId))
    .where(and(
      inArray(memberMessagesTable.clubMemberId, memberIds),
      eq(memberMessagesTable.relatedEntity, "feed_post"),
      eq(memberMessagesTable.channel, "in_app"),
    ))
    .orderBy(desc(memberMessagesTable.sentAt))
    .limit(100);

  let unreadCount = 0;
  const items = messages.map(m => {
    if (!m.readAt) unreadCount += 1;
    return {
      id: m.id,
      organizationId: m.organizationId,
      orgName: m.orgName,
      subject: m.subject,
      body: m.body,
      sentAt: m.sentAt.toISOString(),
      readAt: m.readAt?.toISOString() ?? null,
      postId: m.relatedEntityId,
    };
  });
  res.json({ unreadCount, items });
});

router.post("/portal/my-feed-post-messages/:id/read", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const id = parseInt((req.params as Record<string, string>).id ?? "", 10);
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "id required" }); return; } }

  const memberRows = await db
    .select({ id: clubMembersTable.id })
    .from(clubMembersTable)
    .where(eq(clubMembersTable.userId, userId));
  if (memberRows.length === 0) { { res.json({ success: true, updated: 0 }); return; } }
  const memberIds = memberRows.map(m => m.id);

  const updated = await db.update(memberMessagesTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(memberMessagesTable.id, id),
      inArray(memberMessagesTable.clubMemberId, memberIds),
      eq(memberMessagesTable.relatedEntity, "feed_post"),
      isNull(memberMessagesTable.readAt),
    ))
    .returning({ id: memberMessagesTable.id });
  res.json({ success: true, updated: updated.length });
});

router.post("/portal/my-tie-break-messages/:id/read", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const id = parseInt((req.params as Record<string, string>).id ?? "", 10);
  if (!Number.isFinite(id)) { { res.status(400).json({ error: "id required" }); return; } }

  const memberRows = await db
    .select({ id: clubMembersTable.id })
    .from(clubMembersTable)
    .where(eq(clubMembersTable.userId, userId));
  if (memberRows.length === 0) { { res.json({ success: true, updated: 0 }); return; } }
  const memberIds = memberRows.map(m => m.id);

  const updated = await db.update(memberMessagesTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(memberMessagesTable.id, id),
      inArray(memberMessagesTable.clubMemberId, memberIds),
      eq(memberMessagesTable.relatedEntity, "round_robin_tie_break"),
      isNull(memberMessagesTable.readAt),
    ))
    .returning({ id: memberMessagesTable.id });
  res.json({ success: true, updated: updated.length });
});

// ── Side-game receipt toggle announcement (Task #1270) ──────────────────
// One-time backfill announcement card pointing existing members at the
// new "Side-game payment receipts" toggle on `#comm-prefs`. The helper
// lazily creates a `member_messages` row the first time an eligible
// member loads the portal so we never have to bulk-backfill rows for the
// entire member base. Newly-registered members (clubMembers.createdAt
// >= cutoff) are not eligible — see lib for the cutoff constant.
router.get(
  "/portal/announcements/side-game-receipt-toggle",
  async (req: Request, res: Response) => {
    if (!requirePlayer(req, res)) return;
    const userId = req.user!.id;
    const announcement = await getActiveSideGameReceiptToggleAnnouncement(userId);
    res.json({ announcement });
  },
);

router.post(
  "/portal/announcements/side-game-receipt-toggle/dismiss",
  async (req: Request, res: Response) => {
    if (!requirePlayer(req, res)) return;
    const userId = req.user!.id;
    const result = await dismissSideGameReceiptToggleAnnouncement(userId);
    res.json({ success: true, ...result });
  },
);

// ---------------------------------------------------------------------------
// Task #1832 — single "Email digests" surface in account-settings.
//
// `GET /api/portal/digest-preferences` enumerates every user-scoped
// controller-facing email digest the registry knows about (today: the
// stuck-erasure cleanup digest and the monthly member-prefs digest)
// alongside the caller's current opt-in state. `PATCH .../:id` flips a
// single digest on or off.
//
// The per-(user, org) bounced-digest schedule pair is intentionally not
// listed here — a global toggle would be ambiguous for a controller
// who runs multiple clubs, and the existing per-org email-subscription
// surface already exposes that one. The shared registry filters those
// out automatically.
//
// Audit: a flip is recorded in `member_audit_log` mirroring what the
// public unsubscribe-link handler emits, but with `source =
// "portal_digest_settings"` so the timeline can distinguish a
// controller flipping the toggle in-app from a one-click email link.
// We pass `organizationId: 0` because the toggle is user-scoped (no
// single org owns it); the audit query API filters those out from the
// per-org timeline by design.
// ---------------------------------------------------------------------------
router.get("/portal/digest-preferences", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const { listUserLevelDigestSubscriptionsForUser } = await import(
    "../lib/digestSubscriptionRegistry"
  );
  const digests = await listUserLevelDigestSubscriptionsForUser(userId);
  res.json({ digests });
});

router.patch("/portal/digest-preferences/:id", async (req: Request, res: Response) => {
  if (!requirePlayer(req, res)) return;
  const userId = req.user!.id;
  const id = String(req.params.id || "");
  const body = (req.body ?? {}) as { optedIn?: unknown };
  if (typeof body.optedIn !== "boolean") {
    res.status(400).json({ error: "optedIn must be a boolean" });
    return;
  }
  const {
    setUserLevelDigestOptedIn,
    findDigestSubscription,
    isControllerEligibleForAnyOrg,
  } = await import("../lib/digestSubscriptionRegistry");
  // Mirror the GET-side eligibility gate so a hand-rolled request
  // from a non-controller can't toggle a hidden-by-the-UI digest
  // pref. Self-only scope keeps this low-risk (no IDOR / privilege
  // escalation), but keeping read-vs-write surfaces consistent
  // prevents drift if a future digest's underlying pref column is
  // ever read by a different code path.
  if (!(await isControllerEligibleForAnyOrg(userId))) {
    res.status(403).json({ error: "Not eligible for any digest subscription" });
    return;
  }
  const digest = findDigestSubscription(id);
  // Reject digests that aren't surfaced in the consolidated "Email
  // digests" section. Two cases share this 404 path:
  //   - per-(user, org) digests like `bounced_digest_schedule`
  //     (`!storage.userScopedForPortal`), which use the existing
  //     per-org `EMAIL_SUBSCRIPTION_TYPES` settings instead.
  //   - user-scoped digests like `erasure_storage_digest` that opt
  //     out of `portalListing` because they have their own dedicated
  //     UI row elsewhere on `PortalCommPrefs.tsx` — flipping them
  //     from this endpoint would create a second source of truth and
  //     drift from the older notification-prefs PATCH.
  if (!digest || !digest.storage.userScopedForPortal || !digest.portalListing) {
    res.status(404).json({ error: "Unknown digest subscription" });
    return;
  }
  let result;
  try {
    result = await setUserLevelDigestOptedIn(userId, id, body.optedIn);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (digest.auditKind && result.previousOptedIn !== body.optedIn) {
    const colKey = id === "erasure_storage_digest"
      ? "notifyErasureStorageDigest"
      : id === "member_prefs_digest"
        ? "notifyMemberPrefsDigest"
        : "optedIn";
    // The toggle is user-level (not owned by a single club), but
    // `member_audit_log.organization_id` is a NOT-NULL FK to
    // `organizations.id` — passing 0 trips the FK. Anchor the audit
    // row to one of the user's controller orgs (their direct
    // `app_users.organizationId` if set, otherwise the first
    // controller-level membership). `metadata.scope = "user_level"`
    // tells per-org timeline consumers to filter the row out so it
    // doesn't pollute one club's audit feed. If the user somehow
    // has no anchor org we skip the audit (the toggle still saves);
    // the eligibility filter on GET means this is unreachable
    // through the UI.
    let anchorOrgId: number | null = null;
    const [me] = await db
      .select({ orgId: appUsersTable.organizationId })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, userId))
      .limit(1);
    if (me?.orgId) {
      anchorOrgId = me.orgId;
    } else {
      const [firstCtrlMembership] = await db
        .select({ orgId: orgMembershipsTable.organizationId })
        .from(orgMembershipsTable)
        .where(and(
          eq(orgMembershipsTable.userId, userId),
          inArray(orgMembershipsTable.role, [
            "org_admin",
            "membership_secretary",
            "treasurer",
          ]),
        ))
        .limit(1);
      anchorOrgId = firstCtrlMembership?.orgId ?? null;
    }
    if (anchorOrgId !== null) {
      await recordMemberAudit({
        req,
        organizationId: anchorOrgId,
        clubMemberId: null,
        entity: "comm_prefs",
        entityId: userId,
        action: "update",
        changes: { [colKey]: { from: result.previousOptedIn, to: body.optedIn } },
        reason: "Toggled from portal digest-preferences settings",
        metadata: {
          source: "portal_digest_settings",
          scope: "user_level",
          kind: digest.auditKind,
          direction: body.optedIn ? "resubscribe" : "unsubscribe",
          targetUserId: userId,
        },
      });
    }
  }
  res.json({
    id,
    optedIn: body.optedIn,
    previousOptedIn: result.previousOptedIn,
  });
});

export default router;
