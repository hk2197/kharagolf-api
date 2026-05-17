import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import PDFDocument from "pdfkit";
import { generateTournamentReportPDF } from "../lib/pdfTournamentReport";
import { db } from "@workspace/db";
import { tournamentsTable, playersTable, coursesTable, organizationsTable, scoresTable, holeDetailsTable, leaguesTable, leagueMembersTable, leagueStandingsTable, leagueRoundsTable, leagueFixturesTable, leagueRoundResultsTable, roundSubmissionsTable, shotsTable, teeTimesTable, teeTimePlayersTable, waitlistTable, sideGamesConfigTable, sideGameResultsTable, eclecticScoresView, invitationsTable, tournamentAnnouncementsTable, mediaTable, sponsorsTable, sponsorshipAssignmentsTable, matchResultsTable, appUsersTable, flightsTable, prizeCategoriesTable, prizeAwardsTable, tournamentRoundsTable, sponsorEventsTable, adCampaignsTable, adSlotsTable, marketplaceSlotsTable, marketplaceBookingsTable, clubMembersTable, clubChampionshipTable, championshipFlightTable, championshipWinnerTable, eventTeamsTable, eventTeamMembersTable, tournamentMerchandiseTable, shopProductsTable, shopOrdersTable, shopProductVariantsTable, holeHazardsTable, courseHoleGeometryTable, achievementsTable, handicapHistoryTable, profileShareEventsTable, profileShareDailyAggregatesTable, badgeShareEventsTable, badgeShareVisitEventsTable, recapShareEventsTable, userFollowsTable } from "@workspace/db";
import { eq, and, sql, max, gt, desc, isNull, or, asc, inArray, count } from "drizzle-orm";
import { computeLeaderboard, notifyLeaderboardUpdate, notifyScoringEvent, addSSEClient, removeSSEClient, addOddsClient, removeOddsClient, notifyMarkerLiveScore, getNotableEvents, type ScoringEvent } from "../lib/realtime";
import { deliverSpectatorPush } from "../lib/spectatorNotify";
import { translateSpectatorPush, isSupportedSpectatorPushLang } from "../lib/spectatorPushI18n";
import { getBadgeOgStrings, normalizeBadgeOgLang, interpolateBadgeOg } from "../lib/badgeOgI18n";
import { resolveBadgeOgFontDirs } from "../lib/badgeOgFonts";
import { aggregateAndRankTeams, type RoundTeamResult } from "../lib/leagueTeamStandings";
import { addMarketplaceSSEClient, removeMarketplaceSSEClient, broadcastSlotUpdate, formatSlot } from "./marketplace";
import { getClubTheme } from "../lib/clubTheming";
import QRCode from "qrcode";
import { sendTournamentRegistrationEmail, sendMarketplaceBookingEmail } from "../lib/mailer";
import { sendTransactionalPush } from "../lib/comms";
import { evaluateAchievementsForPlayer, getBadgeDef, ALL_BADGES, computeBadgeProgress, type BadgeProgress } from "../lib/achievementEngine";
import { localizeBadge, resolveBadgeI18nLangFromReq, normalizeBadgeI18nLang } from "../lib/badgeI18n";
import { buildBadgeOgUnlockedSvg, buildBadgeOgLockedSvg, splitEarnedLine } from "../lib/badgeOgSvg";
import { getWeather } from "../lib/weather";
import { computePlaysLike, bearingDeg, fetchElevations } from "../lib/playsLike";
import { holeGreenContoursTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { lookupGolferByGhinNumber, resolveGhinCredentials } from "../lib/ghin";
import { orgGhinCredentialsTable } from "@workspace/db";
import nodemailer from "nodemailer";
import { getEffectivePlanConfig } from "../lib/planConfigLoader";
import { TIER_DISPLAY, type SubscriptionTier } from "../lib/subscriptionTiers";
import { selectAdSlotCreative, DEFAULT_SLOT_KEYS as AD_CAMPAIGN_DEFAULT_SLOT_KEYS } from "./ad-campaigns";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { enforceRateLimit, getClientIp, profileShareEventScopes, badgeShareEventScopes, badgeShareVisitScopes, recapShareScopes, publicFollowsListScopes } from "../lib/publicRateLimit";
// Task #1832 — shared registry-driven mount for the controller-facing
// email digest unsubscribe / re-subscribe routes (see comment block at
// the call-site below).
import { mountPublicDigestRoutes } from "../lib/digestSubscriptionRegistry";
import { recordEmailConversionForRequest } from "../lib/emailCtaConversion";

const router: IRouter = Router({ mergeParams: true });

// Returns true when an IPv4/IPv6 string points to a private, loopback,
// link-local, multicast, or otherwise non-public destination that the
// server must never make outbound requests to (SSRF guard).
function isPrivateOrReservedIp(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    if (a === 10) return true;                    // 10.0.0.0/8
    if (a === 127) return true;                   // loopback
    if (a === 0) return true;                     // 0.0.0.0/8
    if (a === 169 && b === 254) return true;      // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;      // 192.168/16
    if (a >= 224) return true;                    // multicast / reserved
    return false;
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:")) return true;   // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
    if (lower.startsWith("ff")) return true;      // multicast
    if (lower.startsWith("::ffff:")) {
      const v4 = lower.slice(7);
      if (net.isIPv4(v4)) return isPrivateOrReservedIp(v4);
    }
    return false;
  }
  return true;
}

// Small in-memory LRU cache for sponsor creative image bytes used by the
// scorecard PDF route. The campaign delivery engine often returns the same
// scorecard_footer creative for repeated downloads of the same tournament,
// and re-fetching the image over HTTP every time adds avoidable latency and
// outbound bandwidth. The cache is keyed by `creativeId|mediaUrl` so that
// invalidation happens automatically when a campaign points at a new
// creative URL. Negative results (fetch failures, policy violations) are
// also memoised briefly so a broken creative doesn't repeatedly stall PDF
// generation.
type CreativeImageCacheEntry = { buf: Buffer | null; expiresAt: number };
const CREATIVE_IMAGE_CACHE_MAX = 64;
const CREATIVE_IMAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CREATIVE_IMAGE_CACHE_NEG_TTL_MS = 60 * 1000;  // 1 minute for failures
const _creativeImageCache = new Map<string, CreativeImageCacheEntry>();

function _creativeImageCacheGet(key: string): Buffer | null | undefined {
  const entry = _creativeImageCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    _creativeImageCache.delete(key);
    return undefined;
  }
  // Refresh LRU recency.
  _creativeImageCache.delete(key);
  _creativeImageCache.set(key, entry);
  return entry.buf;
}

function _creativeImageCacheSet(key: string, buf: Buffer | null): void {
  const ttl = buf ? CREATIVE_IMAGE_CACHE_TTL_MS : CREATIVE_IMAGE_CACHE_NEG_TTL_MS;
  _creativeImageCache.set(key, { buf, expiresAt: Date.now() + ttl });
  while (_creativeImageCache.size > CREATIVE_IMAGE_CACHE_MAX) {
    const oldest = _creativeImageCache.keys().next().value;
    if (oldest === undefined) break;
    _creativeImageCache.delete(oldest);
  }
}

// Coalesce concurrent misses for the same key so that a burst of PDF
// requests for the same tournament only triggers one upstream fetch.
const _creativeImageInflight = new Map<string, Promise<Buffer | null>>();

async function fetchCreativeImageCached(creativeId: number | string, rawUrl: string): Promise<Buffer | null> {
  const key = `${creativeId}|${rawUrl}`;
  const cached = _creativeImageCacheGet(key);
  if (cached !== undefined) return cached;
  const existing = _creativeImageInflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      const buf = await fetchCreativeImageSafe(rawUrl);
      _creativeImageCacheSet(key, buf);
      return buf;
    } finally {
      _creativeImageInflight.delete(key);
    }
  })();
  _creativeImageInflight.set(key, p);
  return p;
}

// Best-effort, SSRF-hardened fetch of a remote sponsor creative image for
// embedding in PDFs. Returns null on any failure or policy violation.
async function fetchCreativeImageSafe(rawUrl: string): Promise<Buffer | null> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  // Block bracketed IP literals that resolve to internal targets.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) return null;
  try {
    const resolved = await dnsLookup(hostname, { all: true });
    if (!resolved.length) return null;
    if (resolved.some(r => isPrivateOrReservedIp(r.address))) return null;
  } catch { return null; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(parsed.toString(), { signal: ctrl.signal, redirect: "error" });
    clearTimeout(timer);
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    if (!/^image\/(png|jpe?g)/.test(ct)) return null;
    const len = Number(r.headers.get("content-length") ?? 0);
    if (len && len > 5 * 1024 * 1024) return null; // hard cap 5MB
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.byteLength > 5 * 1024 * 1024) return null;
    return buf;
  } catch { return null; }
}

// GET /api/public/badges
// Public: returns the full catalog of badges that players can unlock.
// Used by the website + mobile "Badges" pages to render locked-vs-unlocked
// state alongside the player's earned badges.
router.get("/badges", async (_req: Request, res: Response) => {
  res.json({ badges: ALL_BADGES });
});

// GET /api/public/orgs/:orgId/tournaments/:tournamentId
// Public: no auth required — returns tournament info for registration page
router.get("/orgs/:orgId/tournaments/:tournamentId", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select()
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  if (tournament.status === "completed" || tournament.status === "cancelled") {
    res.status(400).json({ error: "Registration is closed for this tournament" });
    return;
  }

  let courseName: string | null = null;
  if (tournament.courseId) {
    const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId));
    courseName = course?.name ?? null;
  }

  const [org] = await db.select({ name: organizationsTable.name, defaultLanguage: organizationsTable.defaultLanguage }).from(organizationsTable).where(eq(organizationsTable.id, orgId));

  const [playerCount, flightRows, roundRows] = await Promise.all([
    db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId)),
    db.select({ id: flightsTable.id, name: flightsTable.name }).from(flightsTable).where(eq(flightsTable.tournamentId, tournamentId)),
    db.select({
      roundNumber: tournamentRoundsTable.roundNumber,
      courseId: tournamentRoundsTable.courseId,
      courseName: coursesTable.name,
      scheduledDate: tournamentRoundsTable.scheduledDate,
    }).from(tournamentRoundsTable)
      .leftJoin(coursesTable, eq(tournamentRoundsTable.courseId, coursesTable.id))
      .where(eq(tournamentRoundsTable.tournamentId, tournamentId))
      .orderBy(asc(tournamentRoundsTable.roundNumber)),
  ]);

  res.json({
    id: tournament.id,
    name: tournament.name,
    description: tournament.description,
    format: tournament.format,
    status: tournament.status,
    startDate: tournament.startDate,
    endDate: tournament.endDate,
    maxPlayers: tournament.maxPlayers,
    entryFee: tournament.entryFee,
    memberEntryFee: tournament.memberEntryFee,
    currency: tournament.currency ?? "INR",
    rounds: tournament.rounds,
    membersOnly: tournament.membersOnly,
    courseName,
    organizationName: org?.name ?? "Golf Club",
    organizationId: orgId,
    defaultLanguage: org?.defaultLanguage ?? "en",
    playerCount: playerCount.length,
    isFull: tournament.maxPlayers ? playerCount.length >= tournament.maxPlayers : false,
    tiebreakerMethod: tournament.tiebreakerMethod ?? null,
    leaderboardType: tournament.leaderboardType ?? null,
    flights: flightRows,
    roundCourseAssignments: roundRows,
  });
});

// GET /api/public/orgs/:orgId/tournaments/:tournamentId/calendar.ics
// Public: downloads a standards-compliant iCalendar file for the tournament
router.get("/orgs/:orgId/tournaments/:tournamentId/calendar.ics", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select()
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [org] = await db
    .select({ name: organizationsTable.name, address: organizationsTable.address, contactEmail: organizationsTable.contactEmail })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));

  let courseName: string | null = null;
  if (tournament.courseId) {
    const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId));
    courseName = course?.name ?? null;
  }

  const fmtIcsDate = (d: Date) =>
    d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const now = new Date();
  const startDate = tournament.startDate ? new Date(tournament.startDate) : now;
  const endDate = tournament.endDate
    ? new Date(tournament.endDate)
    : new Date(startDate.getTime() + 8 * 60 * 60 * 1000); // +8h if no endDate

  const escIcs = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const orgName = org?.name ?? "Golf Club";
  const location = [courseName, org?.address].filter(Boolean).join(", ");
  const descParts = [
    `Format: ${escIcs(tournament.format?.replace(/_/g, " ") ?? "Golf Tournament")}`,
    `Organised by ${escIcs(orgName)}`,
    tournament.description ? escIcs(tournament.description) : "",
  ].filter(Boolean);
  const description = descParts.join("\\n");

  const uid = `kharagolf-tournament-${tournamentId}@kharagolf.com`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KHARAGOLF//Tournament//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${fmtIcsDate(now)}`,
    `DTSTART:${fmtIcsDate(startDate)}`,
    `DTEND:${fmtIcsDate(endDate)}`,
    `SUMMARY:${escIcs(tournament.name)}`,
    ...(description ? [`DESCRIPTION:${description}`] : []),
    ...(location ? [`LOCATION:${escIcs(location)}`] : []),
    ...(org?.contactEmail ? [`ORGANIZER;CN=${escIcs(orgName)}:mailto:${org.contactEmail}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const icsContent = lines.join("\r\n");
  const filename = `${tournament.name.replace(/[^a-zA-Z0-9]/g, "-")}.ics`;

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(icsContent);
});

// GET /api/public/tournaments/:tournamentId/calendar.ics — simplified alias (no orgId required)
router.get("/tournaments/:tournamentId/calendar.ics", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const [tournament] = await db.select().from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [org] = await db
    .select({ name: organizationsTable.name, address: organizationsTable.address, contactEmail: organizationsTable.contactEmail })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, tournament.organizationId));

  let courseName: string | null = null;
  if (tournament.courseId) {
    const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId));
    courseName = course?.name ?? null;
  }

  const fmtIcsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const escIcs = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const now = new Date();
  const startDate = tournament.startDate ? new Date(tournament.startDate) : now;
  const endDate = tournament.endDate ? new Date(tournament.endDate) : new Date(startDate.getTime() + 8 * 60 * 60 * 1000);
  const orgName = org?.name ?? "Golf Club";
  const location = [courseName, org?.address].filter(Boolean).join(", ");
  const descParts2 = [
    `Format: ${escIcs(tournament.format?.replace(/_/g, " ") ?? "Golf Tournament")}`,
    `Organised by ${escIcs(orgName)}`,
    tournament.description ? escIcs(tournament.description) : "",
  ].filter(Boolean);
  const description = descParts2.join("\\n");

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//KHARAGOLF//Tournament//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:kharagolf-tournament-${tournamentId}@kharagolf.com`,
    `DTSTAMP:${fmtIcsDate(now)}`,
    `DTSTART:${fmtIcsDate(startDate)}`,
    `DTEND:${fmtIcsDate(endDate)}`,
    `SUMMARY:${escIcs(tournament.name)}`,
    ...(description ? [`DESCRIPTION:${description}`] : []),
    ...(location ? [`LOCATION:${escIcs(location)}`] : []),
    ...(org?.contactEmail ? [`ORGANIZER;CN=${escIcs(orgName)}:mailto:${org.contactEmail}`] : []),
    "END:VEVENT", "END:VCALENDAR",
  ];

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${tournament.name.replace(/[^a-zA-Z0-9]/g, "-")}.ics"`);
  res.send(lines.join("\r\n"));
});

// GET /api/public/orgs/:orgId/tournaments/:tournamentId/merchandise
// Public: returns linked merchandise for a tournament (for registration add-ons display)
router.get("/orgs/:orgId/tournaments/:tournamentId/merchandise", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  // Verify tournament belongs to org
  const [tournament] = await db.select({ id: tournamentsTable.id })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const merchandiseRows = await db
    .select({
      id: tournamentMerchandiseTable.id,
      displayOrder: tournamentMerchandiseTable.displayOrder,
      note: tournamentMerchandiseTable.note,
      productId: shopProductsTable.id,
      productName: shopProductsTable.name,
      productCategory: shopProductsTable.category,
      price: shopProductsTable.markupPrice,
      imageUrl: shopProductsTable.imageUrl,
      stockCount: shopProductsTable.stockCount,
    })
    .from(tournamentMerchandiseTable)
    .innerJoin(shopProductsTable, eq(tournamentMerchandiseTable.productId, shopProductsTable.id))
    .where(and(
      eq(tournamentMerchandiseTable.tournamentId, tournamentId),
      eq(shopProductsTable.isActive, true),
    ))
    .orderBy(tournamentMerchandiseTable.displayOrder);

  // Attach variants for each product so consumers can render variant-level pickers
  const productIds = merchandiseRows.map(m => m.productId);
  const variantRows = productIds.length > 0
    ? await db
        .select({
          id: shopProductVariantsTable.id,
          productId: shopProductVariantsTable.productId,
          color: shopProductVariantsTable.color,
          size: shopProductVariantsTable.size,
          sku: shopProductVariantsTable.sku,
          price: shopProductVariantsTable.salePrice,
          stockQty: shopProductVariantsTable.stockQty,
        })
        .from(shopProductVariantsTable)
        .where(inArray(shopProductVariantsTable.productId, productIds))
    : [];

  const merchandise = merchandiseRows.map(m => ({
    id: m.id,
    displayOrder: m.displayOrder,
    note: m.note,
    productId: m.productId,
    productName: m.productName,
    productCategory: m.productCategory,
    price: m.price,
    imageUrl: m.imageUrl,
    stockCount: m.stockCount,
    variants: variantRows
      .filter(v => v.productId === m.productId)
      .map(v => ({
        id: v.id,
        label: [v.size, v.color].filter(Boolean).join(" / ") || v.sku || `Variant ${v.id}`,
        price: v.price ?? m.price,
        stock: v.stockQty ?? 0,
      })),
  }));

  res.json(merchandise);
});

// POST /api/public/orgs/:orgId/tournaments/:tournamentId/merchandise/order
// Public: create pending merchandise orders tagged to a tournament (for pro-shop pickup)
// Items are persisted with paymentMode="pro_shop_pickup", status="pending"
// and tournamentId set — visible in tournament reporting + pro shop orders.
router.post("/orgs/:orgId/tournaments/:tournamentId/merchandise/order", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  // Verify tournament belongs to org
  const [tournament] = await db.select({ id: tournamentsTable.id, name: tournamentsTable.name })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const { customerName, customerEmail, customerPhone, items } = req.body;
  if (!customerName || !customerEmail) { { res.status(400).json({ error: "customerName and customerEmail are required" }); return; } }
  if (!Array.isArray(items) || items.length === 0) { { res.status(400).json({ error: "items array is required" }); return; } }

  const createdOrders: number[] = [];

  for (const item of items) {
    const { productId, variantId, quantity } = item;
    if (!productId || !quantity || quantity < 1) continue;

    // Verify product belongs to this org and is active, and is linked to this tournament
    const [merch] = await db.select({
      productId: shopProductsTable.id,
      productName: shopProductsTable.name,
      price: shopProductsTable.markupPrice,
    })
      .from(tournamentMerchandiseTable)
      .innerJoin(shopProductsTable, eq(tournamentMerchandiseTable.productId, shopProductsTable.id))
      .where(and(
        eq(tournamentMerchandiseTable.tournamentId, tournamentId),
        eq(tournamentMerchandiseTable.productId, productId),
        eq(shopProductsTable.organizationId, orgId),
        eq(shopProductsTable.isActive, true),
      ));
    if (!merch) continue;

    // Validate variantId belongs to this product/org when provided
    if (variantId) {
      const [variant] = await db.select({ id: shopProductVariantsTable.id })
        .from(shopProductVariantsTable)
        .innerJoin(shopProductsTable, eq(shopProductVariantsTable.productId, shopProductsTable.id))
        .where(and(
          eq(shopProductVariantsTable.id, variantId),
          eq(shopProductVariantsTable.productId, productId),
          eq(shopProductsTable.organizationId, orgId),
        ));
      if (!variant) continue;
    }

    const unitPrice = parseFloat(String(merch.price ?? 0));
    const [order] = await db.insert(shopOrdersTable).values({
      organizationId: orgId,
      productId: merch.productId,
      variantId: variantId ?? null,
      customerName: String(customerName),
      customerEmail: String(customerEmail),
      customerPhone: customerPhone ?? null,
      quantity: parseInt(String(quantity)),
      unitPrice: String(unitPrice),
      totalAmount: String(unitPrice * parseInt(String(quantity))),
      paymentMode: "pro_shop_pickup",
      status: "pending",
      tournamentId,
    }).returning({ id: shopOrdersTable.id });

    if (order) createdOrders.push(order.id);
  }

  if (createdOrders.length === 0) {
    res.status(400).json({ error: "No valid merchandise items to order" });
    return;
  }

  res.status(201).json({
    success: true,
    orderIds: createdOrders,
    message: `${createdOrders.length} merchandise item(s) reserved for ${tournament.name}. Collect and pay at the Pro Shop on event day.`,
  });
});

// POST /api/public/orgs/:orgId/tournaments/:tournamentId/register
// Public: no auth required — self-register for a tournament
router.post("/orgs/:orgId/tournaments/:tournamentId/register", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select()
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  if (tournament.status === "completed" || tournament.status === "cancelled") {
    res.status(400).json({ error: "Registration is closed for this tournament" });
    return;
  }

  const { firstName, lastName, email, phone, handicapIndex, flight, teeBox, inviteToken, portalUserId } = req.body;

  // Members-only gating: requires an authenticated portal session with a verified club membership linkage
  if (tournament.membersOnly) {
    const sessionUser = req.user as { id?: number } | undefined;
    if (!sessionUser?.id) {
      res.status(403).json({
        error: "This tournament is open to club members only. Please sign in to the Player Portal to register.",
        membersOnly: true,
      });
      return;
    }
    // Verify the authenticated user is linked (userId set) to an active club membership in this org
    const [linkedMember] = await db
      .select({ id: clubMembersTable.id, subscriptionStatus: clubMembersTable.subscriptionStatus })
      .from(clubMembersTable)
      .where(
        and(
          eq(clubMembersTable.organizationId, orgId),
          eq(clubMembersTable.userId, sessionUser.id),
        )
      )
      .limit(1);

    if (!linkedMember || linkedMember.subscriptionStatus === "cancelled") {
      res.status(403).json({
        error: "This tournament is open to club members only. Your portal account does not have an active club membership for this club.",
        membersOnly: true,
      });
      return;
    }
  }

  if (tournament.maxPlayers) {
    const existing = await db.select().from(playersTable).where(eq(playersTable.tournamentId, tournamentId));
    if (existing.length >= tournament.maxPlayers) {
      // Tournament full — add to waitlist instead
      if (!firstName?.trim() || !lastName?.trim() || !email?.trim()) {
        res.status(400).json({ error: "First name, last name and email are required" });
        return;
      }
      // Find next waitlist position
      const [maxPos] = await db
        .select({ maxPos: max(waitlistTable.position) })
        .from(waitlistTable)
        .where(eq(waitlistTable.tournamentId, tournamentId));
      const nextPos = (maxPos?.maxPos ?? 0) + 1;

      const teeBoxValues = ["blue", "white", "red", "gold", "black"] as const;
      const rawTeeBox = (teeBox || "white").toLowerCase();
      const validatedTeeBox = teeBoxValues.includes(rawTeeBox as typeof teeBoxValues[number])
        ? (rawTeeBox as typeof teeBoxValues[number])
        : ("white" as const);

      const [entry] = await db
        .insert(waitlistTable)
        .values({
          tournamentId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone?.trim() || null,
          handicapIndex: handicapIndex ? String(parseFloat(handicapIndex)) : null,
          flight: flight?.trim() || null,
          teeBox: validatedTeeBox,
          position: nextPos,
        })
        .returning();

      res.status(202).json({
        waitlisted: true,
        position: nextPos,
        message: `Tournament is full. You are #${nextPos} on the waitlist.`,
        waitlistId: entry.id,
      });
      return;
    }
  }

  if (!firstName?.trim() || !lastName?.trim()) {
    res.status(400).json({ error: "First name and last name are required" });
    return;
  }

  if (!email?.trim()) {
    res.status(400).json({ error: "Email address is required" });
    return;
  }

  // Validate invite token if provided (pre-flight checks before entering transaction)
  if (inviteToken) {
    const [invite] = await db
      .select({
        id: invitationsTable.id,
        status: invitationsTable.status,
        expiresAt: invitationsTable.expiresAt,
        tournamentId: invitationsTable.tournamentId,
        leagueId: invitationsTable.leagueId,
        organizationId: invitationsTable.organizationId,
      })
      .from(invitationsTable)
      .where(eq(invitationsTable.token, inviteToken as string));

    if (!invite) {
      res.status(400).json({ error: "Invalid invite token" });
      return;
    }
    if (invite.status === "revoked") {
      res.status(400).json({ error: "This invitation has been revoked" });
      return;
    }
    if (invite.status === "accepted") {
      res.status(400).json({ error: "This invitation has already been used" });
      return;
    }
    if (new Date(invite.expiresAt) < new Date()) {
      res.status(400).json({ error: "This invitation has expired" });
      return;
    }
    if (invite.organizationId !== orgId) {
      res.status(400).json({ error: "Invitation is for a different organization" });
      return;
    }
    if (invite.leagueId && !invite.tournamentId) {
      res.status(400).json({ error: "This invitation is for a league, not a tournament" });
      return;
    }
    if (invite.tournamentId !== null && invite.tournamentId !== tournamentId) {
      res.status(400).json({ error: "Invitation is for a different tournament" });
      return;
    }
  }

  const teeBoxValues = ["blue", "white", "red", "gold", "black"] as const;
  const rawTeeBox = (teeBox || "white").toLowerCase();
  const validatedTeeBox = teeBoxValues.includes(rawTeeBox as typeof teeBoxValues[number])
    ? (rawTeeBox as typeof teeBoxValues[number])
    : ("white" as const);

  // Atomically insert player + consume invite token inside a transaction.
  // The invite UPDATE uses a conditional WHERE (status='pending' AND expiresAt>now())
  // so a concurrent request that already claimed it returns 0 rows and the tx rolls back.
  let player: typeof playersTable.$inferSelect;
  try {
    player = await db.transaction(async (tx) => {
      // If an invite token was supplied, claim it atomically first
      if (inviteToken) {
        const claimed = await tx
          .update(invitationsTable)
          .set({ status: "accepted", acceptedAt: new Date() })
          .where(
            and(
              eq(invitationsTable.token, inviteToken as string),
              eq(invitationsTable.status, "pending"),
              gt(invitationsTable.expiresAt, new Date()),
            ),
          )
          .returning({ id: invitationsTable.id });

        if (claimed.length === 0) {
          throw new Error("INVITE_ALREADY_USED");
        }
      }

      const [inserted] = await tx
        .insert(playersTable)
        .values({
          tournamentId,
          userId: null,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone?.trim() || null,
          handicapIndex: handicapIndex ? String(parseFloat(handicapIndex)) : null,
          flight: flight?.trim() || null,
          teeBox: validatedTeeBox,
          paymentStatus: "unpaid",
          checkedIn: false,
          currentRound: 1,
          teamName: null,
        })
        .returning();

      return inserted;
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "INVITE_ALREADY_USED") {
      res.status(409).json({ error: "This invitation has already been used" });
    } else {
      res.status(500).json({ error: "Registration failed" });
    }
    return;
  }

  // Fire-and-forget welcome email if autoWelcome is enabled (non-blocking)
  if (tournament.autoWelcome && player.email) {
    const registrantName = player.firstName;
    const registrantEmail = player.email;
    Promise.resolve().then(async () => {
      try {
        const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
        await sendTournamentRegistrationEmail(registrantEmail, registrantName, tournament.name, org?.name ?? "KHARAGOLF", tournament.startDate, {
          orgName: org?.name ?? "KHARAGOLF",
          logoUrl: org?.logoUrl ?? undefined,
          primaryColor: org?.primaryColor ?? undefined,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logger.error({ email: registrantEmail, eventName: tournament.name, errMsg }, "[public] Failed to send registration email");
      }
    });
  }

  // Fire-and-forget: send registration-confirmed push to the player's device (if linked)
  if (player.userId) {
    const userId = player.userId;
    const tName = tournament.name;
    // Task #1240 — fire-and-forget (deferred via `Promise.resolve().then`,
    // result discarded inside try/catch — only throws are logged).
    // Classifier intentionally not consulted; the registration record
    // and confirmation email are the durable signals.
    Promise.resolve().then(async () => {
      try {
        await sendTransactionalPush(
          [userId],
          "Registration Confirmed",
          `You're registered for ${tName}. Good luck on the course!`,
          { type: "registration_confirmed", tournamentId },
        );
      } catch (e) {
        console.warn("[push] registration-confirmed push error:", e);
      }
    });
  }

  // Task #2020 — best-effort: if this self-registration originated
  // from an email CTA click in the last 24h, attribute it back to the
  // notification key. Fire-and-forget; never blocks the 201 response.
  void recordEmailConversionForRequest(req, "tournament_registered", {
    userId: player.userId ?? null,
  });

  res.status(201).json({
    ...player,
    playerId: player.id,
    handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null,
    tournamentName: tournament.name,
  });
});

// GET /api/public/tournaments/:tournamentId/players
// Mobile: list players for a tournament (used by mobile score entry)
router.get("/tournaments/:tournamentId/players", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const players = await db
    .select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
      flight: playersTable.flight,
      teeBox: playersTable.teeBox,
      checkedIn: playersTable.checkedIn,
      profileImage: appUsersTable.profileImage,
    })
    .from(playersTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, playersTable.userId))
    .where(eq(playersTable.tournamentId, tournamentId))
    .orderBy(playersTable.lastName);

  res.json(players.map(p => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    handicapIndex: p.handicapIndex ? Number(p.handicapIndex) : null,
    flight: p.flight,
    teeBox: p.teeBox,
    checkedIn: p.checkedIn,
    profileImage: p.profileImage ?? null,
  })));
});

// GET /api/public/tournaments
// Mobile: list active/upcoming tournaments across all orgs
router.get("/tournaments", async (req: Request, res: Response) => {
  const orgIdParam = req.query.orgId ? parseInt(req.query.orgId as string) : null;
  const statusFilter = or(eq(tournamentsTable.status, "active"), eq(tournamentsTable.status, "upcoming"));
  const whereClause = orgIdParam && !isNaN(orgIdParam)
    ? and(statusFilter, eq(tournamentsTable.organizationId, orgIdParam))
    : statusFilter;

  const tournaments = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      status: tournamentsTable.status,
      startDate: tournamentsTable.startDate,
      endDate: tournamentsTable.endDate,
      organizationId: tournamentsTable.organizationId,
      courseId: tournamentsTable.courseId,
      selfPosting: tournamentsTable.selfPosting,
      allowSelfScoring: tournamentsTable.allowSelfScoring,
      markerValidation: tournamentsTable.markerValidation,
      entryFee: tournamentsTable.entryFee,
      currency: tournamentsTable.currency,
      maxPlayers: tournamentsTable.maxPlayers,
    })
    .from(tournamentsTable)
    .where(whereClause)
    .orderBy(desc(tournamentsTable.startDate));

  // Enrich with org, course names, and player count
  const enriched = await Promise.all(tournaments.map(async (t) => {
    const [org, playerRows] = await Promise.all([
      db.select({ name: organizationsTable.name, primaryColor: organizationsTable.primaryColor }).from(organizationsTable).where(eq(organizationsTable.id, t.organizationId)).then(r => r[0]),
      db.select({ id: playersTable.id }).from(playersTable).where(eq(playersTable.tournamentId, t.id)),
    ]);
    let courseName: string | null = null;
    if (t.courseId) {
      const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, t.courseId));
      courseName = course?.name ?? null;
    }
    const playerCount = playerRows.length;
    return {
      ...t,
      organizationName: org?.name ?? "Golf Club",
      organizationPrimaryColor: org?.primaryColor ?? null,
      courseName,
      playerCount,
      isFull: t.maxPlayers ? playerCount >= t.maxPlayers : false,
      currency: t.currency ?? "INR",
    };
  }));

  res.json(enriched);
});

// GET /api/public/leagues — public leagues across all orgs
router.get("/leagues", async (req: Request, res: Response) => {
  const leagues = await db
    .select({
      id: leaguesTable.id,
      name: leaguesTable.name,
      description: leaguesTable.description,
      format: leaguesTable.format,
      type: leaguesTable.type,
      status: leaguesTable.status,
      seasonStart: leaguesTable.seasonStart,
      seasonEnd: leaguesTable.seasonEnd,
      maxMembers: leaguesTable.maxMembers,
      entryFee: leaguesTable.entryFee,
      currency: leaguesTable.currency,
      handicapAllowance: leaguesTable.handicapAllowance,
      roundsCount: leaguesTable.roundsCount,
      organizationId: leaguesTable.organizationId,
    })
    .from(leaguesTable)
    .where(eq(leaguesTable.isPublic, true));
  res.json(leagues);
});

// GET /api/public/leagues/:leagueId/standings — public standings for a league
router.get("/leagues/:leagueId/standings", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const [league] = await db.select({ isPublic: leaguesTable.isPublic }).from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }
  if (!league.isPublic) { { res.status(403).json({ error: "League is not public" }); return; } }

  const standings = await db
    .select({
      id: leagueStandingsTable.id,
      memberId: leagueStandingsTable.memberId,
      // Task #2239 — surface the linked appUsersTable.id so the mobile
      // per-player league standings rows can navigate into the public
      // profile viewer (or the private member fallback) for that
      // player, matching the affordance already on the league members
      // tab and the round-result expanded rows.
      userId: leagueMembersTable.userId,
      roundsPlayed: leagueStandingsTable.roundsPlayed,
      won: leagueStandingsTable.won,
      drawn: leagueStandingsTable.drawn,
      lost: leagueStandingsTable.lost,
      totalPoints: leagueStandingsTable.totalPoints,
      totalGross: leagueStandingsTable.totalGross,
      totalNet: leagueStandingsTable.totalNet,
      totalStableford: leagueStandingsTable.totalStableford,
      bestScore: leagueStandingsTable.bestScore,
      position: leagueStandingsTable.position,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      handicapIndex: leagueMembersTable.handicapIndex,
      teamName: leagueMembersTable.teamName,
      profileImage: appUsersTable.profileImage,
    })
    .from(leagueStandingsTable)
    .innerJoin(leagueMembersTable, eq(leagueMembersTable.id, leagueStandingsTable.memberId))
    .leftJoin(appUsersTable, eq(appUsersTable.id, leagueMembersTable.userId))
    .where(eq(leagueStandingsTable.leagueId, leagueId))
    .orderBy(leagueStandingsTable.position);

  res.json(standings.map(s => ({ ...s, profileImage: s.profileImage ?? null, userId: s.userId ?? null })));
});

// GET /api/public/leagues/:leagueId/standings/teams — public team standings
router.get("/leagues/:leagueId/standings/teams", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const [league] = await db.select({
    isPublic: leaguesTable.isPublic,
    format: leaguesTable.format,
    pointsPerWin: leaguesTable.pointsPerWin,
    pointsPerDraw: leaguesTable.pointsPerDraw,
    pointsPerLoss: leaguesTable.pointsPerLoss,
  }).from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }
  if (!league.isPublic) { { res.status(403).json({ error: "League is not public" }); return; } }

  const teams = await db
    .select({ id: eventTeamsTable.id, name: eventTeamsTable.name, colour: eventTeamsTable.colour })
    .from(eventTeamsTable)
    .where(eq(eventTeamsTable.leagueId, leagueId))
    .orderBy(asc(eventTeamsTable.id));

  if (teams.length === 0) { { res.json([]); return; } }

  const teamMembers = await db
    .select({ teamId: eventTeamMembersTable.teamId, leagueMemberId: eventTeamMembersTable.leagueMemberId })
    .from(eventTeamMembersTable)
    .where(inArray(eventTeamMembersTable.teamId, teams.map(t => t.id)));

  const memberToTeam = new Map<number, number>();
  for (const m of teamMembers) {
    if (m.leagueMemberId != null) memberToTeam.set(m.leagueMemberId, m.teamId);
  }

  // Fetch all round results for format-aware aggregation
  const roundResults = await db
    .select({
      roundId: leagueRoundResultsTable.roundId,
      memberId: leagueRoundResultsTable.memberId,
      grossScore: leagueRoundResultsTable.grossScore,
      netScore: leagueRoundResultsTable.netScore,
      stablefordPoints: leagueRoundResultsTable.stablefordPoints,
      matchResult: leagueRoundResultsTable.matchResult,
    })
    .from(leagueRoundResultsTable)
    .where(eq(leagueRoundResultsTable.leagueId, leagueId));

  const fmt = league.format ?? "stroke_play";
  const isStableford = ["stableford", "better_ball", "alliance", "waltz"].includes(fmt);
  const isMatchPlay = fmt === "match_play";
  const isNet = ["net_stroke", "scramble", "shamble"].includes(fmt);

  const teamRoundMap = new Map<number, Map<number, RoundTeamResult>>();
  for (const t of teams) teamRoundMap.set(t.id, new Map());

  const allRoundIds = [...new Set(roundResults.map(r => r.roundId))];
  for (const roundId of allRoundIds) {
    const roundData = roundResults.filter(r => r.roundId === roundId);
    const teamRoundData = new Map<number, typeof roundData>();
    for (const t of teams) teamRoundData.set(t.id, []);
    for (const row of roundData) {
      const tid = memberToTeam.get(row.memberId);
      if (tid == null) continue;
      teamRoundData.get(tid)!.push(row);
    }
    for (const [tid, memberResults] of teamRoundData.entries()) {
      if (memberResults.length === 0) continue;
      const roundMap = teamRoundMap.get(tid)!;
      let won = 0, drawn = 0, lost = 0;
      let grossScore: number | null = null, netScore: number | null = null, stablefordPoints: number | null = null;
      if (isMatchPlay) {
        for (const r of memberResults) {
          if (r.matchResult === "win") won++;
          else if (r.matchResult === "halve" || r.matchResult === "draw") drawn++;
          else if (r.matchResult === "loss") lost++;
        }
      } else if (isStableford) {
        const valid = memberResults.filter(r => r.stablefordPoints != null);
        if (valid.length > 0) {
          const pts = valid.map(r => r.stablefordPoints!).sort((a, b) => b - a);
          if (fmt === 'better_ball') {
            stablefordPoints = pts[0];
          } else if (fmt === 'alliance') {
            stablefordPoints = pts.slice(0, 2).reduce((s, v) => s + v, 0);
          } else {
            stablefordPoints = pts.reduce((s, v) => s + v, 0);
          }
          grossScore = valid.reduce((s, r) => s + (r.grossScore ?? 0), 0);
        }
      } else if (isNet) {
        const valid = memberResults.filter(r => r.netScore != null);
        if (valid.length > 0) {
          netScore = Math.min(...valid.map(r => r.netScore!));
          grossScore = valid.find(r => r.netScore === netScore)?.grossScore ?? null;
          stablefordPoints = valid.find(r => r.netScore === netScore)?.stablefordPoints ?? null;
        }
      } else {
        const valid = memberResults.filter(r => r.grossScore != null);
        if (valid.length > 0) {
          grossScore = Math.min(...valid.map(r => r.grossScore!));
          netScore = valid.find(r => r.grossScore === grossScore)?.netScore ?? null;
          stablefordPoints = valid.find(r => r.grossScore === grossScore)?.stablefordPoints ?? null;
        }
      }
      roundMap.set(roundId, { won, drawn, lost, grossScore, netScore, stablefordPoints });
    }
  }

  // Accumulate and rank using shared helper (same logic used by private endpoint)
  const ranked = aggregateAndRankTeams(teams, teamRoundMap, league);

  res.json(ranked);
});

// GET /api/public/leagues/:leagueId/rounds — public rounds for a league
router.get("/leagues/:leagueId/rounds", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const [league] = await db.select({ isPublic: leaguesTable.isPublic }).from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }
  if (!league.isPublic) { { res.status(403).json({ error: "League is not public" }); return; } }

  const rounds = await db
    .select()
    .from(leagueRoundsTable)
    .where(eq(leagueRoundsTable.leagueId, leagueId))
    .orderBy(leagueRoundsTable.roundNumber);

  res.json(rounds);
});

// GET /api/public/leagues/:leagueId/members — public members list for a league
router.get("/leagues/:leagueId/members", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const [league] = await db.select({ isPublic: leaguesTable.isPublic }).from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }
  if (!league.isPublic) { { res.status(403).json({ error: "League is not public" }); return; } }

  const members = await db
    .select({
      id: leagueMembersTable.id,
      // Task #1457 — surface the linked appUsersTable.id so the mobile
      // league members tab can navigate into the public profile viewer
      // (or the private member fallback) for that player.
      userId: leagueMembersTable.userId,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      handicapIndex: leagueMembersTable.handicapIndex,
      teamName: leagueMembersTable.teamName,
      joinedAt: leagueMembersTable.joinedAt,
      paymentStatus: leagueMembersTable.paymentStatus,
      profileImage: appUsersTable.profileImage,
    })
    .from(leagueMembersTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, leagueMembersTable.userId))
    .where(eq(leagueMembersTable.leagueId, leagueId))
    .orderBy(leagueMembersTable.joinedAt);

  res.json(members.map(m => ({ ...m, profileImage: m.profileImage ?? null, userId: m.userId ?? null })));
});

// GET /api/public/leagues/:leagueId/fixtures — public fixtures for a league
router.get("/leagues/:leagueId/fixtures", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const [league] = await db.select({ isPublic: leaguesTable.isPublic }).from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }
  if (!league.isPublic) { { res.status(403).json({ error: "League is not public" }); return; } }

  const fixtures = await db
    .select()
    .from(leagueFixturesTable)
    .where(eq(leagueFixturesTable.leagueId, leagueId))
    .orderBy(leagueFixturesTable.roundNumber, leagueFixturesTable.id);

  // Task #2240 — surface the linked appUsersTable.id so the mobile
  // fixtures tab can navigate into the public profile viewer (or the
  // private member fallback) for each home/away player, matching the
  // affordance already on /leagues/:leagueId/members and the round
  // results card.
  const memberFields = {
    id: leagueMembersTable.id,
    userId: leagueMembersTable.userId,
    firstName: leagueMembersTable.firstName,
    lastName: leagueMembersTable.lastName,
  };
  const results = await Promise.all(fixtures.map(async (f) => {
    const [home] = await db.select(memberFields).from(leagueMembersTable).where(eq(leagueMembersTable.id, f.homeId));
    const [away] = await db.select(memberFields).from(leagueMembersTable).where(eq(leagueMembersTable.id, f.awayId));
    return {
      ...f,
      home: home ? { ...home, userId: home.userId ?? null } : null,
      away: away ? { ...away, userId: away.userId ?? null } : null,
    };
  }));

  res.json(results);
});

// GET /api/public/leagues/:leagueId/rounds/:roundId/results — per-round scores for completed rounds
router.get("/leagues/:leagueId/rounds/:roundId/results", async (req: Request, res: Response) => {
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));
  const roundId = parseInt(String((req.params as Record<string, string>).roundId));
  const [league] = await db.select({ isPublic: leaguesTable.isPublic }).from(leaguesTable).where(eq(leaguesTable.id, leagueId));
  if (!league) { { res.status(404).json({ error: "League not found" }); return; } }
  if (!league.isPublic) { { res.status(403).json({ error: "League is not public" }); return; } }

  const results = await db
    .select({
      id: leagueRoundResultsTable.id,
      memberId: leagueRoundResultsTable.memberId,
      // Task #1791 — surface the linked appUsersTable.id so the mobile
      // RoundResultCard can navigate into the public profile viewer (or
      // the private member fallback) for each scorer, matching the
      // affordance already on /leagues/:leagueId/members.
      userId: leagueMembersTable.userId,
      grossScore: leagueRoundResultsTable.grossScore,
      netScore: leagueRoundResultsTable.netScore,
      stablefordPoints: leagueRoundResultsTable.stablefordPoints,
      matchResult: leagueRoundResultsTable.matchResult,
      firstName: leagueMembersTable.firstName,
      lastName: leagueMembersTable.lastName,
      handicapIndex: leagueMembersTable.handicapIndex,
      profileImage: appUsersTable.profileImage,
    })
    .from(leagueRoundResultsTable)
    .innerJoin(leagueMembersTable, eq(leagueMembersTable.id, leagueRoundResultsTable.memberId))
    .leftJoin(appUsersTable, eq(appUsersTable.id, leagueMembersTable.userId))
    .where(and(eq(leagueRoundResultsTable.leagueId, leagueId), eq(leagueRoundResultsTable.roundId, roundId)));

  res.json(results.map(r => ({ ...r, profileImage: r.profileImage ?? null, userId: r.userId ?? null })));
});

// GET /api/public/tournaments/:tournamentId/leaderboard
// Optional query params:
//   ?view=cumulative  → filters leaderboard to players with at least 1 complete round,
//                       sorts by cumulative gross score, includes roundScores[] per player,
//                       and sets cumulativeView:true. Intended for multi-round tournaments.
//   (default)        → full leaderboard including in-progress players, cumulativeView:false
router.get("/tournaments/:tournamentId/leaderboard", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const cumulativeView = req.query.view === "cumulative";
  const leaderboard = await computeLeaderboard(tournamentId);
  if (!leaderboard) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  const [t] = await db.select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  const orgId = t?.organizationId ?? null;
  let organizationName: string | null = null;
  let organizationLogoUrl: string | null = null;
  let organizationPrimaryColor: string | null = null;
  let sponsors: Array<{ id: number; name: string; logoUrl: string | null; tier: string; websiteUrl: string | null }> = [];
  if (orgId) {
    const [org] = await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));
    organizationName = org?.name ?? null;
    organizationLogoUrl = org?.logoUrl ?? null;
    organizationPrimaryColor = org?.primaryColor ?? null;

    sponsors = await db.select({
      id: sponsorsTable.id,
      name: sponsorsTable.name,
      logoUrl: sponsorsTable.logoUrl,
      tier: sponsorsTable.tier,
      websiteUrl: sponsorsTable.websiteUrl,
    }).from(sponsorsTable)
      .where(and(
        eq(sponsorsTable.organizationId, orgId),
        eq(sponsorsTable.isActive, true),
        or(isNull(sponsorsTable.tournamentId), eq(sponsorsTable.tournamentId, tournamentId)),
      ))
      .orderBy(asc(sponsorsTable.displayOrder));
  }

  // When cumulative view is requested, filter to players who have at least one completed round
  // and re-sort by cumulative gross score ascending.
  let entries = leaderboard.entries;
  let netEntries = leaderboard.netEntries;
  let stablefordEntries = leaderboard.stablefordEntries;
  if (cumulativeView && leaderboard.rounds > 1) {
    const hasCompletedRound = (e: { roundScores?: { isComplete: boolean }[] }) =>
      (e.roundScores ?? []).some((rs) => rs.isComplete);
    entries = entries.filter(hasCompletedRound);
    netEntries = netEntries.filter(hasCompletedRound);
    stablefordEntries = stablefordEntries.filter(hasCompletedRound);
    // Sort by cumulative gross score (lower = better); ties broken by net score
    entries = [...entries].sort((a, b) => (a.grossScore ?? 9999) - (b.grossScore ?? 9999));
    netEntries = [...netEntries].sort((a, b) => (a.netScore ?? 9999) - (b.netScore ?? 9999));
    stablefordEntries = [...stablefordEntries].sort((a, b) => (b.stablefordPoints ?? 0) - (a.stablefordPoints ?? 0));
    // Re-assign positions
    let pos = 1;
    for (let i = 0; i < entries.length; i++) {
      if (i > 0 && entries[i].grossScore !== entries[i - 1].grossScore) pos = i + 1;
      (entries[i] as Record<string, unknown>).position = pos;
      (entries[i] as Record<string, unknown>).positionDisplay = String(pos);
    }
    let npos = 1;
    for (let i = 0; i < netEntries.length; i++) {
      if (i > 0 && netEntries[i].netScore !== netEntries[i - 1].netScore) npos = i + 1;
      (netEntries[i] as Record<string, unknown>).position = npos;
      (netEntries[i] as Record<string, unknown>).positionDisplay = String(npos);
    }
    let spos = 1;
    for (let i = 0; i < stablefordEntries.length; i++) {
      if (i > 0 && stablefordEntries[i].stablefordPoints !== stablefordEntries[i - 1].stablefordPoints) spos = i + 1;
      (stablefordEntries[i] as Record<string, unknown>).position = spos;
      (stablefordEntries[i] as Record<string, unknown>).positionDisplay = String(spos);
    }
  }

  res.json({
    ...leaderboard,
    entries,
    netEntries,
    stablefordEntries,
    organizationId: orgId,
    organizationName,
    organizationLogoUrl,
    organizationPrimaryColor,
    sponsors,
    cumulativeView,
  });
});

// GET /api/public/tournaments/:tournamentId/leaderboard/stream — SSE for public leaderboard
router.get("/tournaments/:tournamentId/leaderboard/stream", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const langParam = typeof req.query.lang === "string" ? req.query.lang : null;
  const lang = isSupportedSpectatorPushLang(langParam) ? langParam : "en";
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  addSSEClient(tournamentId, res, lang);

  // Send initial leaderboard snapshot so clients don't need a separate fetch for type/tiebreaker
  try {
    const leaderboard = await computeLeaderboard(tournamentId);
    if (leaderboard) {
      res.write(`data: ${JSON.stringify({ type: "leaderboard_update", data: { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod } })}\n\n`);
    } else {
      res.write(": connected\n\n");
    }
  } catch {
    res.write(": connected\n\n");
  }

  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    removeSSEClient(tournamentId, res);
  });
});

// ─── Spectator Mode (Task #377) ──────────────────────────────────────────────

// GET /api/public/tournaments/:id/tee-sheet — alias of /tee-times with the
// shape consumed by the spectator UI.
router.get("/tournaments/:tournamentId/tee-sheet", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const [tournament] = await db
    .select({ status: tournamentsTable.status })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  if (tournament.status === "draft") { { res.status(403).json({ error: "Tee sheet is not yet published" }); return; } }

  const teeTimes = await db.select().from(teeTimesTable)
    .where(eq(teeTimesTable.tournamentId, tournamentId))
    .orderBy(teeTimesTable.teeTime);

  const results = await Promise.all(teeTimes.map(async (tt) => {
    const players = await db
      .select({
        playerId: teeTimePlayersTable.playerId,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
        flight: playersTable.flight,
        handicapIndex: playersTable.handicapIndex,
      })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, tt.id));
    return { id: tt.id, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round, players };
  }));

  res.json(results);
});

// GET /api/public/tournaments/:id/notable-events — backlog of recent birdie/eagle/HIO/round events
// When a `?lang=xx` query is provided each event is decorated with the
// localised `title` + `body` strings produced by the server-side spectator
// push translator. This is the single source of truth for these strings —
// the web spectator dashboard renders them as-is rather than carrying its
// own English copy (Task #802).
router.get("/tournaments/:tournamentId/notable-events", (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50") || 50, 100);
  const langParam = typeof req.query.lang === "string" ? req.query.lang : null;
  const lang = isSupportedSpectatorPushLang(langParam) ? langParam : "en";
  const events = getNotableEvents(tournamentId, limit).map((ev) => {
    const { title, body } = translateSpectatorPush(lang, ev);
    return { ...ev, title, body, lang };
  });
  res.json({ events });
});

// GET /api/public/tournaments/:id/pace-board?round=1 — public pace snapshot
// Lightweight version: marshal-only fields stripped, but groups, current hole,
// and deviation are exposed so spectators can see pace + countdown.
router.get("/tournaments/:tournamentId/pace-board", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const round = parseInt((req.query.round as string) ?? "1") || 1;

  const [tournament] = await db
    .select({ status: tournamentsTable.status, courseId: tournamentsTable.courseId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  if (tournament.status === "draft") { { res.status(403).json({ error: "Tournament not yet published" }); return; } }

  const teeTimes = await db.select().from(teeTimesTable)
    .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, round)))
    .orderBy(teeTimesTable.teeTime);

  const now = Date.now();
  const groups = await Promise.all(teeTimes.map(async (tt) => {
    const players = await db
      .select({
        playerId: teeTimePlayersTable.playerId,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
      })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, tt.id));

    // Determine current hole from highest score submitted by any group member.
    const playerIds = players.map(p => p.playerId);
    let currentHole = 0;
    let lastHoleAt: Date | null = null;
    if (playerIds.length > 0) {
      const rows = await db
        .select({ holeNumber: scoresTable.holeNumber, submittedAt: scoresTable.submittedAt })
        .from(scoresTable)
        .where(and(
          eq(scoresTable.tournamentId, tournamentId),
          eq(scoresTable.round, round),
          inArray(scoresTable.playerId, playerIds),
        ))
        .orderBy(desc(scoresTable.holeNumber), desc(scoresTable.submittedAt))
        .limit(1);
      if (rows[0]) { currentHole = rows[0].holeNumber; lastHoleAt = rows[0].submittedAt; }
    }

    const teeMs = tt.teeTime.getTime();
    const minutesUntilTeeOff = Math.round((teeMs - now) / 60000);
    const status: "scheduled" | "upcoming" | "in_progress" | "complete" =
      currentHole >= 18 ? "complete"
      : currentHole > 0 ? "in_progress"
      : minutesUntilTeeOff <= 15 && minutesUntilTeeOff > -5 ? "upcoming"
      : "scheduled";

    return {
      teeTimeId: tt.id,
      teeTime: tt.teeTime.toISOString(),
      round,
      startingHole: tt.startingHole,
      players: players.map(p => ({ id: p.playerId, name: `${p.firstName} ${p.lastName}` })),
      currentHole,
      minutesUntilTeeOff,
      status,
      lastHoleCompletedAt: lastHoleAt?.toISOString() ?? null,
    };
  }));

  res.json({ groups, round, updatedAt: new Date().toISOString() });
});

// GET /api/public/tournaments/:id/spectator-feed — combined snapshot for spectator app.
router.get("/tournaments/:tournamentId/spectator-feed", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const leaderboard = await computeLeaderboard(tournamentId);
  if (!leaderboard) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // Reuse same pace + tee-sheet logic by calling internally is awkward — we
  // duplicate a minimal version here.
  const round = parseInt((req.query.round as string) ?? "1") || 1;
  const teeTimes = await db.select().from(teeTimesTable)
    .where(and(eq(teeTimesTable.tournamentId, tournamentId), eq(teeTimesTable.round, round)))
    .orderBy(teeTimesTable.teeTime);

  const tees = await Promise.all(teeTimes.map(async (tt) => {
    const players = await db
      .select({
        playerId: teeTimePlayersTable.playerId,
        firstName: playersTable.firstName, lastName: playersTable.lastName,
      })
      .from(teeTimePlayersTable)
      .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
      .where(eq(teeTimePlayersTable.teeTimeId, tt.id));
    return {
      id: tt.id, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round,
      players: players.map(p => ({ playerId: p.playerId, firstName: p.firstName, lastName: p.lastName })),
    };
  }));

  const [t] = await db
    .select({ organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  let organizationName: string | null = null;
  let organizationLogoUrl: string | null = null;
  let organizationPrimaryColor: string | null = null;
  if (t?.organizationId) {
    const [org] = await db
      .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, t.organizationId));
    organizationName = org?.name ?? null;
    organizationLogoUrl = org?.logoUrl ?? null;
    organizationPrimaryColor = org?.primaryColor ?? null;
  }

  res.json({
    leaderboard: {
      ...leaderboard,
      organizationName,
      organizationLogoUrl,
      organizationPrimaryColor,
    },
    teeSheet: tees,
    notableEvents: getNotableEvents(tournamentId, 30),
    updatedAt: new Date().toISOString(),
  });
});

// GET /api/public/share/tournament/:id — minimal HTML page with Open Graph
// metadata so social media crawlers and shared links show a rich preview.
router.get("/share/tournament/:tournamentId", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const [tournament] = await db
    .select({
      name: tournamentsTable.name,
      organizationId: tournamentsTable.organizationId,
      startDate: tournamentsTable.startDate,
      status: tournamentsTable.status,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) {
    res.status(404).type("text/html").send("<h1>Tournament not found</h1>");
    return;
  }

  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, tournament.organizationId));

  // Spectator URL on the web app — use BASE_URL convention via env or default.
  const origin = `${req.protocol}://${req.get("host")}`;
  const webBase = process.env.WEB_APP_URL ?? `${origin}/kharagolf-web`;
  const spectatorUrl = `${webBase}/spectator/${tournamentId}`;

  const title = `${tournament.name} — Live Leaderboard`;
  const description = `Follow live scoring, group positions, and notable moments at ${tournament.name}${org?.name ? ` hosted by ${org.name}` : ""}.`;
  const image = org?.logoUrl ?? `${origin}/logo.png`;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="index,follow" />
<link rel="canonical" href="${esc(spectatorUrl)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(spectatorUrl)}" />
<meta property="og:image" content="${esc(image)}" />
<meta property="og:site_name" content="${esc(org?.name ?? "KharaGolf")}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${esc(image)}" />
<meta http-equiv="refresh" content="0; url=${esc(spectatorUrl)}" />
<style>body{font-family:system-ui,sans-serif;background:#0b1512;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style>
</head>
<body>
<div style="text-align:center;padding:2rem">
  <h1 style="margin:0 0 .5rem">${esc(tournament.name)}</h1>
  <p style="color:#9ca3af;margin:0 0 1rem">${esc(description)}</p>
  <p><a style="color:#22c55e" href="${esc(spectatorUrl)}">Open spectator view →</a></p>
</div>
</body>
</html>`;

  res.set("Cache-Control", "public, max-age=60");
  res.type("text/html").send(html);
});

// GET /api/public/tournaments/:tournamentId/holes
// Mobile: get hole par data for score entry. Optional ?round=N for multi-course events.
router.get("/tournaments/:tournamentId/holes", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const roundParam = req.query.round ? parseInt(req.query.round as string) : null;

  const [tournament] = await db.select({
    courseId: tournamentsTable.courseId,
    rounds: tournamentsTable.rounds,
    localRules: tournamentsTable.localRules,
    localRulesConfig: tournamentsTable.localRulesConfig,
  }).from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));

  // When a specific round is requested, check if it has its own course assignment
  let effectiveCourseId = tournament?.courseId ?? null;
  if (roundParam !== null && !isNaN(roundParam)) {
    const [roundRow] = await db.select({ courseId: tournamentRoundsTable.courseId })
      .from(tournamentRoundsTable)
      .where(and(eq(tournamentRoundsTable.tournamentId, tournamentId), eq(tournamentRoundsTable.roundNumber, roundParam)));
    if (roundRow?.courseId) effectiveCourseId = roundRow.courseId;
  }

  const localRules = tournament?.localRules ?? null;
  const localRulesConfig = tournament?.localRulesConfig ?? null;

  if (!effectiveCourseId) {
    const defaultHoles = Array.from({ length: 18 }, (_, i) => ({
      holeNumber: i + 1,
      par: [4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 4, 3, 4, 5, 4, 3, 4, 5][i] ?? 4,
      handicap: i + 1,
    }));
    res.json({ holes: defaultHoles, rounds: tournament?.rounds ?? 1, localRules, localRulesConfig, courseRating: null, courseSlope: null, coursePar: null });
    return;
  }

  const holes = await db
    .select()
    .from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, effectiveCourseId))
    .orderBy(holeDetailsTable.holeNumber);

  const [courseData] = await db
    .select({ rating: coursesTable.rating, slope: coursesTable.slope, par: coursesTable.par })
    .from(coursesTable)
    .where(eq(coursesTable.id, effectiveCourseId));

  // Wave 1 W1-B — surface courseId + organizationId so the mobile app can
  // call GET /organizations/:orgId/courses/:courseId/bundle to pre-cache the
  // full offline-ready course payload (geometry + holes) for this round.
  const [orgRow] = await db
    .select({ organizationId: coursesTable.organizationId })
    .from(coursesTable)
    .where(eq(coursesTable.id, effectiveCourseId));

  res.json({
    holes,
    rounds: tournament?.rounds ?? 1,
    localRules,
    localRulesConfig,
    courseRating: courseData?.rating ? Number(courseData.rating) : null,
    courseSlope: courseData?.slope ?? null,
    coursePar: courseData?.par ?? null,
    courseId: effectiveCourseId,
    organizationId: orgRow?.organizationId ?? null,
  });
});

// Helper: when an authenticated Bearer token is present, verify the client-supplied playerId
// is linked to the session user (by userId or email). Returns true if allowed; false = 403.
async function enforceScoreOwnership(req: Request, res: Response, playerId: number, tournamentId: number): Promise<boolean> {
  if (!req.isAuthenticated()) return true; // Unauthenticated requests are allowed (public mode)

  const [player] = await db
    .select({ userId: playersTable.userId, email: playersTable.email })
    .from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));

  if (!player) return true; // 404 handled downstream

  const userEmail = req.user!.email ?? "";
  const isOwner =
    (player.userId != null && player.userId === req.user!.id) ||
    (player.email != null && userEmail !== "" &&
      player.email.toLowerCase() === userEmail.toLowerCase());

  if (!isOwner) {
    res.status(403).json({ error: "You may only post scores for your own player record." });
    return false;
  }
  return true;
}

// GET /api/public/tournaments/:tournamentId/players/:playerId/scores
// Mobile: get a player's current scores
router.get("/tournaments/:tournamentId/players/:playerId/scores", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));

  const scores = await db
    .select()
    .from(scoresTable)
    .where(and(eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.playerId, playerId)));

  res.json(scores);
});

// POST /api/public/tournaments/:tournamentId/players/:playerId/scores
// Mobile: submit hole score. When authenticated, enforces identity ownership.
router.post("/tournaments/:tournamentId/players/:playerId/scores", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { round = 1, holeNumber, strokes, putts, fairwayHit, girHit, clientKnownAt } = req.body;

  if (!holeNumber || strokes === undefined || strokes === null) {
    res.status(400).json({ error: "holeNumber and strokes are required" });
    return;
  }

  // Enforce identity: authenticated users may only post for their own player record
  if (!await enforceScoreOwnership(req, res, playerId, tournamentId)) return;

  // Verify player belongs to tournament
  const [player] = await db.select({ id: playersTable.id, userId: playersTable.userId, firstName: playersTable.firstName, lastName: playersTable.lastName }).from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));

  if (!player) {
    res.status(404).json({ error: "Player not found in this tournament" });
    return;
  }

  // Wave 1 W1-B — sync-conflict detector. If the client tells us when it
  // last saw the row (`clientKnownAt`) and the server has a newer version,
  // return 409 with both payloads so the mobile UI can surface a "two
  // devices both edited this hole" dialog. Last-write-wins is still the
  // eventual behaviour — this just exposes the conflict so the player can
  // pick which value sticks rather than silently clobbering the other
  // device's entry.
  if (clientKnownAt) {
    const clientKnownDate = new Date(clientKnownAt);
    if (!Number.isNaN(clientKnownDate.getTime())) {
      const [serverRow] = await db
        .select()
        .from(scoresTable)
        .where(and(
          eq(scoresTable.tournamentId, tournamentId),
          eq(scoresTable.playerId, playerId),
          eq(scoresTable.round, round),
          eq(scoresTable.holeNumber, holeNumber),
        ))
        .limit(1);
      if (serverRow && serverRow.updatedAt && serverRow.updatedAt > clientKnownDate) {
        res.status(409).json({
          error: "Score was modified by another device since you last loaded it.",
          conflict: true,
          server: serverRow,
          client: { strokes, putts: putts ?? null, fairwayHit: fairwayHit ?? null, girHit: girHit ?? null, clientKnownAt },
        });
        return;
      }
    }
  }

  // Only overwrite optional fields when explicitly provided in the request so
  // callers that update one column (e.g. a manual putts edit) don't clobber
  // others (strokes, fairwayHit, girHit) recorded earlier in the round.
  const updateSet: Record<string, unknown> = { strokes, updatedAt: new Date() };
  if (putts !== undefined) updateSet.putts = putts;
  if (fairwayHit !== undefined) updateSet.fairwayHit = fairwayHit;
  if (girHit !== undefined) updateSet.girHit = girHit;

  const [score] = await db
    .insert(scoresTable)
    .values({ tournamentId, playerId, round, holeNumber, strokes, putts: putts ?? null, fairwayHit: fairwayHit ?? null, girHit: girHit ?? null, isVerified: false })
    .onConflictDoUpdate({
      target: [scoresTable.playerId, scoresTable.round, scoresTable.holeNumber],
      set: updateSet,
    })
    .returning();

  // Update player's current hole tracker
  await db.update(playersTable).set({ currentHole: holeNumber }).where(eq(playersTable.id, playerId));

  // Trigger leaderboard SSE update
  const leaderboard = await computeLeaderboard(tournamentId);
  if (leaderboard) notifyLeaderboardUpdate(tournamentId, { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod });

  // Fire-and-forget: notify marker live SSE clients for this player's active share token
  Promise.resolve().then(async () => {
    try {
      const [activeSubmission] = await db
        .select({ markerShareToken: roundSubmissionsTable.markerShareToken, markerShareTokenExpiresAt: roundSubmissionsTable.markerShareTokenExpiresAt })
        .from(roundSubmissionsTable)
        .where(and(eq(roundSubmissionsTable.playerId, playerId), eq(roundSubmissionsTable.round, round)));
      if (activeSubmission?.markerShareToken && activeSubmission.markerShareTokenExpiresAt && activeSubmission.markerShareTokenExpiresAt > new Date()) {
        notifyMarkerLiveScore(activeSubmission.markerShareToken, {
          tournamentId, playerId, round, holeNumber, strokes,
          playerName: `${player.firstName} ${player.lastName}`,
          occurredAt: new Date().toISOString(),
        });
      }
    } catch { /* non-fatal */ }
  }).catch(() => {});

  res.json(score);

  // Fire-and-forget: broadcast scoring_event SSE for birdie or better
  Promise.resolve().then(async () => {
    try {
      const [tournament] = await db
        .select({ courseId: tournamentsTable.courseId })
        .from(tournamentsTable)
        .where(eq(tournamentsTable.id, tournamentId));
      if (!tournament?.courseId) return;
      const [holeDetail] = await db
        .select({ par: holeDetailsTable.par })
        .from(holeDetailsTable)
        .where(and(eq(holeDetailsTable.courseId, tournament.courseId), eq(holeDetailsTable.holeNumber, holeNumber)));
      const par = holeDetail?.par ?? 4;
      const toPar = strokes - par;
      if (toPar <= -1) {
        const eventType: ScoringEvent["eventType"] =
          strokes === 1 ? "hole_in_one" : toPar <= -2 ? "eagle" : "birdie";
        const evt: ScoringEvent = {
          tournamentId,
          playerId,
          playerName: `${player.firstName} ${player.lastName}`,
          holeNumber,
          strokes,
          par,
          toPar,
          eventType,
          round,
          occurredAt: new Date().toISOString(),
        };
        notifyScoringEvent(tournamentId, evt);
        deliverSpectatorPush(evt).catch(() => {});
      }
      // Round start (first hole scored) and finish (hole 18) — also notable.
      const holeCountRow = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(scoresTable)
        .where(and(eq(scoresTable.playerId, playerId), eq(scoresTable.tournamentId, tournamentId), eq(scoresTable.round, round)));
      const holesPlayed = holeCountRow[0]?.n ?? 0;
      if (holesPlayed === 1) {
        const evt: ScoringEvent = {
          tournamentId, playerId,
          playerName: `${player.firstName} ${player.lastName}`,
          holeNumber, strokes, par, toPar,
          eventType: "round_start",
          round,
          occurredAt: new Date().toISOString(),
        };
        notifyScoringEvent(tournamentId, evt);
        deliverSpectatorPush(evt).catch(() => {});
      } else if (holesPlayed >= 18) {
        const evt: ScoringEvent = {
          tournamentId, playerId,
          playerName: `${player.firstName} ${player.lastName}`,
          holeNumber, strokes, par, toPar,
          eventType: "round_finish",
          round,
          occurredAt: new Date().toISOString(),
        };
        notifyScoringEvent(tournamentId, evt);
        deliverSpectatorPush(evt).catch(() => {});
      }
    } catch { /* ignore */ }
  });

  // Fire-and-forget achievement evaluation for registered players (after response sent)
  if (player.userId) {
    evaluateAchievementsForPlayer(player.userId, playerId, tournamentId).catch(() => {});
  }
});

// POST /api/public/tournaments/:tournamentId/players/:playerId/submit
// Mobile: player submits round for marker validation — generates a 6-digit code.
// When authenticated, enforces identity ownership.
router.post("/tournaments/:tournamentId/players/:playerId/submit", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { round = 1, markerPlayerId: rawMarkerPlayerId, markerName: rawMarkerName } = req.body;
  const markerPlayerId = rawMarkerPlayerId ? parseInt(rawMarkerPlayerId) : undefined;
  const markerNameNote = (!markerPlayerId && rawMarkerName) ? String(rawMarkerName).slice(0, 200) : undefined;

  // Enforce identity: authenticated users may only submit for their own player record
  if (!await enforceScoreOwnership(req, res, playerId, tournamentId)) return;

  const [player] = await db.select().from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));

  if (!player) { { res.status(404).json({ error: "Player not found" }); return; } }

  // Gate: allowSelfScoring must be enabled on the tournament
  const [tournament] = await db.select({ allowSelfScoring: tournamentsTable.allowSelfScoring, selfPosting: tournamentsTable.selfPosting })
    .from(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (!tournament?.allowSelfScoring && !tournament?.selfPosting) {
    res.status(403).json({ error: "Player self-scoring is not enabled for this tournament" }); return;
  }

  // Get all scores for this round
  const scores = await db.select().from(scoresTable)
    .where(and(eq(scoresTable.playerId, playerId), eq(scoresTable.round, round)));

  if (scores.length === 0) { { res.status(400).json({ error: "No scores recorded for this round" }); return; } }

  const totalStrokes = scores.reduce((acc, s) => acc + s.strokes, 0);
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  // Upsert submission — persist markerPlayerId for notification + audit trail
  const [submission] = await db
    .insert(roundSubmissionsTable)
    .values({
      tournamentId,
      playerId,
      round,
      markerCode: code,
      status: "pending",
      totalStrokes,
      ...(markerPlayerId && !isNaN(markerPlayerId) ? { markerPlayerId } : {}),
      ...(markerNameNote ? { notes: `Marker: ${markerNameNote}` } : {}),
    })
    .onConflictDoUpdate({
      target: [roundSubmissionsTable.playerId, roundSubmissionsTable.round],
      set: {
        markerCode: code, status: "pending", totalStrokes,
        submittedAt: new Date(), reviewedAt: null, rejectionReason: null,
        ...(markerPlayerId && !isNaN(markerPlayerId) ? { markerPlayerId } : {}),
        ...(markerNameNote ? { notes: `Marker: ${markerNameNote}` } : {}),
      },
    })
    .returning();

  res.json({
    submissionId: submission.id,
    totalStrokes,
    playerName: `${player.firstName} ${player.lastName}`,
    message: "Round submitted for marker validation. Your marker can log in to validate your scores.",
  });

  // Fire-and-forget achievement evaluation after round submission (after response sent)
  if (player.userId) {
    evaluateAchievementsForPlayer(player.userId, playerId, tournamentId).catch(() => {});
  }

  // Note: push notification to the marker is sent from the portal sign endpoint
  // (POST /api/portal/submissions/:id/sign) which fires when the player formally signs
  // their card (status → submitted). This prevents notifying too early.
});

// NOTE: Public unauthenticated approve/reject/code-lookup endpoints have been
// removed. Marker validation now requires portal email/password authentication
// via POST /api/portal/submissions/:id/approve|reject (Bearer token required).

// GET /api/public/tournaments/:tournamentId/players/:playerId/submission
// Mobile: player checks their submission status
router.get("/tournaments/:tournamentId/players/:playerId/submission", async (req: Request, res: Response) => {
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { round = "1" } = req.query;

  const [submission] = await db.select().from(roundSubmissionsTable)
    .where(and(eq(roundSubmissionsTable.playerId, playerId), eq(roundSubmissionsTable.round, parseInt(round as string))));

  if (!submission) { { res.json(null); return; } }

  res.json({
    submissionId: submission.id,
    status: submission.status,
    markerCode: submission.status === "pending" ? submission.markerCode : null,
    totalStrokes: submission.totalStrokes,
    rejectionReason: submission.rejectionReason,
    submittedAt: submission.submittedAt,
    reviewedAt: submission.reviewedAt,
  });
});

// ── SHOT TRACKING ─────────────────────────────────────────────

// ── Typed DTOs for batch endpoints ───────────────────────────────────
interface ShotBatchItem {
  round?: number;
  holeNumber: number;
  shotNumber: number;
  shotType?: string;
  latitude?: number | null;
  longitude?: number | null;
  distanceToPin?: number | null;
  recordedAt?: string;
}

interface ScoreBatchItem {
  round?: number;
  holeNumber: number;
  strokes: number;
  putts?: number | null;
  fairwayHit?: boolean | null;
  girHit?: boolean | null;
  // Wave 1 W1-B — when present, the server compares against the row's
  // current `updatedAt` and marks the row as conflicted (rather than
  // overwriting) if another device wrote a newer value.
  clientKnownAt?: string | null;
}

// Helper: verify player belongs to this tournament
async function validatePlayerInTournament(playerId: number, tournamentId: number): Promise<boolean> {
  const [player] = await db
    .select({ id: playersTable.id })
    .from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));
  return !!player;
}

// POST /api/public/tournaments/:tournamentId/players/:playerId/shots
// Mobile: log a single GPS shot
router.post("/tournaments/:tournamentId/players/:playerId/shots", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { round = 1, holeNumber, shotNumber, shotType, latitude, longitude, distanceToPin } = req.body;

  if (!holeNumber || !shotNumber) {
    res.status(400).json({ error: "holeNumber and shotNumber are required" });
    return;
  }

  if (!(await validatePlayerInTournament(playerId, tournamentId))) {
    res.status(403).json({ error: "Player does not belong to this tournament" });
    return;
  }

  const [shot] = await db
    .insert(shotsTable)
    .values({
      tournamentId,
      playerId,
      round,
      holeNumber,
      shotNumber,
      shotType: shotType ?? "fairway",
      latitude: latitude != null ? String(latitude) : null,
      longitude: longitude != null ? String(longitude) : null,
      distanceToPin: distanceToPin != null ? String(distanceToPin) : null,
      source: "phone",
    })
    .returning();

  res.status(201).json(shot);
});

// POST /api/public/tournaments/:tournamentId/players/:playerId/shots/batch
// Mobile: bulk upload shots (offline queue flush)
router.post("/tournaments/:tournamentId/players/:playerId/shots/batch", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { shots } = req.body;

  if (!Array.isArray(shots) || shots.length === 0) {
    res.status(400).json({ error: "shots array is required" });
    return;
  }

  if (!(await validatePlayerInTournament(playerId, tournamentId))) {
    res.status(403).json({ error: "Player does not belong to this tournament" });
    return;
  }

  const rows = (shots as ShotBatchItem[]).map((s) => ({
    tournamentId,
    playerId,
    round: s.round ?? 1,
    holeNumber: s.holeNumber,
    shotNumber: s.shotNumber,
    shotType: (s.shotType ?? "fairway") as "tee" | "fairway" | "approach" | "chip" | "sand" | "putt",
    latitude: s.latitude != null ? String(s.latitude) : null,
    longitude: s.longitude != null ? String(s.longitude) : null,
    distanceToPin: s.distanceToPin != null ? String(s.distanceToPin) : null,
    source: "phone" as const,
    recordedAt: s.recordedAt ? new Date(s.recordedAt) : new Date(),
  }));

  await db.insert(shotsTable).values(rows);
  res.status(201).json({ synced: rows.length });
});

// GET /api/public/tournaments/:tournamentId/players/:playerId/shots
// Mobile: get shots for a player round
router.get("/tournaments/:tournamentId/players/:playerId/shots", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const round = parseInt((req.query.round as string) ?? "1");

  const shots = await db
    .select()
    .from(shotsTable)
    .where(and(eq(shotsTable.tournamentId, tournamentId), eq(shotsTable.playerId, playerId), eq(shotsTable.round, round)))
    .orderBy(shotsTable.holeNumber, shotsTable.shotNumber);

  res.json(shots);
});

// ── BULK SCORE SYNC (offline queue flush) ─────────────────────

// POST /api/public/tournaments/:tournamentId/players/:playerId/scores/batch
// Mobile: flush offline score queue in one request. When authenticated, enforces identity ownership.
router.post("/tournaments/:tournamentId/players/:playerId/scores/batch", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const playerId = parseInt(String((req.params as Record<string, string>).playerId));
  const { scores } = req.body;

  if (!Array.isArray(scores) || scores.length === 0) {
    res.status(400).json({ error: "scores array is required" });
    return;
  }

  // Enforce identity: authenticated users may only batch-sync for their own player record
  if (!await enforceScoreOwnership(req, res, playerId, tournamentId)) return;

  const [player] = await db.select({ id: playersTable.id, userId: playersTable.userId }).from(playersTable)
    .where(and(eq(playersTable.id, playerId), eq(playersTable.tournamentId, tournamentId)));
  if (!player) { { res.status(404).json({ error: "Player not found in this tournament" }); return; } }

  // Wave 1 W1-B — per-row conflict detection. When a row carries
  // `clientKnownAt`, compare against the server's current `updatedAt`; if the
  // server is newer, skip the write and report it back so the mobile flush
  // handler can surface a "two devices both edited this hole" chooser instead
  // of silently clobbering the other device's entry.
  const conflicts: Array<{
    holeNumber: number;
    round: number;
    server: typeof scoresTable.$inferSelect;
    client: { strokes: number; putts: number | null; fairwayHit: boolean | null; girHit: boolean | null; clientKnownAt: string };
  }> = [];
  let synced = 0;
  for (const s of scores as ScoreBatchItem[]) {
    const round = s.round ?? 1;
    if (s.clientKnownAt) {
      const clientKnownDate = new Date(s.clientKnownAt);
      if (!Number.isNaN(clientKnownDate.getTime())) {
        const [serverRow] = await db
          .select()
          .from(scoresTable)
          .where(and(
            eq(scoresTable.tournamentId, tournamentId),
            eq(scoresTable.playerId, playerId),
            eq(scoresTable.round, round),
            eq(scoresTable.holeNumber, s.holeNumber),
          ))
          .limit(1);
        if (serverRow && serverRow.updatedAt && serverRow.updatedAt > clientKnownDate) {
          conflicts.push({
            holeNumber: s.holeNumber,
            round,
            server: serverRow,
            client: { strokes: s.strokes, putts: s.putts ?? null, fairwayHit: s.fairwayHit ?? null, girHit: s.girHit ?? null, clientKnownAt: s.clientKnownAt },
          });
          continue;
        }
      }
    }
    await db
      .insert(scoresTable)
      .values({ tournamentId, playerId, round, holeNumber: s.holeNumber, strokes: s.strokes, putts: s.putts ?? null, fairwayHit: s.fairwayHit ?? null, girHit: s.girHit ?? null, isVerified: false })
      .onConflictDoUpdate({
        target: [scoresTable.playerId, scoresTable.round, scoresTable.holeNumber],
        set: { strokes: s.strokes, putts: s.putts ?? null, fairwayHit: s.fairwayHit ?? null, girHit: s.girHit ?? null, updatedAt: new Date() },
      });
    synced += 1;
  }

  // Update current hole to the furthest hole that was actually written.
  const writtenHoles = (scores as ScoreBatchItem[])
    .filter((s) => !conflicts.some((c) => c.holeNumber === s.holeNumber && c.round === (s.round ?? 1)))
    .map((s) => s.holeNumber);
  if (writtenHoles.length > 0) {
    const maxHole = Math.max(...writtenHoles);
    await db.update(playersTable).set({ currentHole: maxHole }).where(eq(playersTable.id, playerId));
  }

  const leaderboard = await computeLeaderboard(tournamentId);
  if (leaderboard) notifyLeaderboardUpdate(tournamentId, { entries: leaderboard.entries, netEntries: leaderboard.netEntries, stablefordEntries: leaderboard.stablefordEntries, availableViews: leaderboard.availableViews, leaderboardType: leaderboard.leaderboardType, tiebreakerMethod: leaderboard.tiebreakerMethod });

  if (conflicts.length > 0) {
    res.status(409).json({ synced, conflicts, conflict: true, error: `${conflicts.length} hole(s) had newer server values; resolve before retrying.` });
  } else {
    res.json({ synced });
  }

  // Fire-and-forget achievement evaluation for registered players (after response sent)
  if (player.userId) {
    evaluateAchievementsForPlayer(player.userId, playerId, tournamentId).catch(() => {});
  }
});

// ── WEATHER PROXY ──────────────────────────────────────────────

// GET /api/public/weather?lat=XX&lng=XX
// Returns weather with 15-minute server-side cache.
// Uses OpenWeatherMap (if OPENWEATHERMAP_API_KEY is set) or Open-Meteo fallback.
router.get("/weather", async (req: Request, res: Response) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) { { res.status(400).json({ error: "lat and lng are required" }); return; } }
  const latN = parseFloat(lat as string);
  const lngN = parseFloat(lng as string);
  if (isNaN(latN) || isNaN(lngN)) { { res.status(400).json({ error: "lat and lng must be numbers" }); return; } }

  try {
    const data = await getWeather(latN, lngN);
    res.json(data);
  } catch {
    res.status(502).json({ error: "Failed to fetch weather" });
  }
});

// GET /api/public/orgs/:orgId/tournaments/:tournamentId/waitlist-position?email=...
// Player can check their waitlist position (promoted entries are no longer waiting)
router.get("/orgs/:orgId/tournaments/:tournamentId/waitlist-position", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const email = (req.query.email as string)?.toLowerCase().trim();
  if (!email) { { res.status(400).json({ error: "email query parameter required" }); return; } }

  const [entry] = await db
    .select()
    .from(waitlistTable)
    .where(and(
      eq(waitlistTable.tournamentId, tournamentId),
      sql`lower(${waitlistTable.email}) = ${email}`,
      sql`${waitlistTable.promotedAt} IS NULL`,
    ));

  if (!entry) { { res.status(404).json({ error: "Not on waitlist" }); return; } }
  // Count how many active (not promoted) entries are ahead in queue
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waitlistTable)
    .where(and(
      eq(waitlistTable.tournamentId, tournamentId),
      sql`${waitlistTable.position} < ${entry.position}`,
      sql`${waitlistTable.promotedAt} IS NULL`,
    ));
  res.json({ position: entry.position, queuePosition: (count ?? 0) + 1, firstName: entry.firstName, lastName: entry.lastName, registeredAt: entry.registeredAt });
});

// NOTE: CSV score export is available on the authenticated admin route:
// GET /api/orgs/:orgId/tournaments/:tournamentId/export/scores.csv

// GET /api/public/tournaments/:id/tee-times — public tee sheet
// Only available for published tournaments (upcoming/active/completed — not draft)
router.get("/tournaments/:id/tee-times", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).id));

  const [tournament] = await db
    .select({ id: tournamentsTable.id, status: tournamentsTable.status })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }

  if (tournament.status === 'draft') {
    res.status(403).json({ error: "Tee sheet is not yet published" });
    return;
  }

  const teeTimes = await db.select().from(teeTimesTable)
    .where(eq(teeTimesTable.tournamentId, tournamentId))
    .orderBy(teeTimesTable.teeTime);

  const results = await Promise.all(
    teeTimes.map(async (tt) => {
      const players = await db
        .select({
          playerId: teeTimePlayersTable.playerId,
          firstName: playersTable.firstName,
          lastName: playersTable.lastName,
          flight: playersTable.flight,
          handicapIndex: playersTable.handicapIndex,
        })
        .from(teeTimePlayersTable)
        .innerJoin(playersTable, eq(playersTable.id, teeTimePlayersTable.playerId))
        .where(eq(teeTimePlayersTable.teeTimeId, tt.id));
      return { id: tt.id, teeTime: tt.teeTime.toISOString(), hole: tt.startingHole, round: tt.round, players };
    }),
  );

  res.json(results);
});

// GET /api/public/tournaments/:tournamentId/side-games — public side game config + results + skins
router.get("/tournaments/:tournamentId/side-games", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [cfg] = await db
    .select()
    .from(sideGamesConfigTable)
    .where(eq(sideGamesConfigTable.tournamentId, tournamentId));

  const manualResults = await db
    .select({
      id: sideGameResultsTable.id,
      gameType: sideGameResultsTable.gameType,
      holeNumber: sideGameResultsTable.holeNumber,
      round: sideGameResultsTable.round,
      notes: sideGameResultsTable.notes,
      prize: sideGameResultsTable.prize,
      playerId: sideGameResultsTable.playerId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    })
    .from(sideGameResultsTable)
    .leftJoin(playersTable, eq(playersTable.id, sideGameResultsTable.playerId))
    .where(eq(sideGameResultsTable.tournamentId, tournamentId))
    .orderBy(sideGameResultsTable.recordedAt);

  // Auto-calculate skins if enabled
  let skinsResults: Array<{
    hole: number; round: number; winnerId: number | null; winnerName: string | null; winnerScore: number | null; tied: boolean; carriedFrom: number | null;
  }> = [];

  if (cfg?.skinsEnabled) {
    const [tournament] = await db
      .select({ rounds: tournamentsTable.rounds })
      .from(tournamentsTable)
      .where(eq(tournamentsTable.id, tournamentId));

    const allScores = await db
      .select({
        playerId: scoresTable.playerId,
        holeNumber: scoresTable.holeNumber,
        strokes: scoresTable.strokes,
        round: scoresTable.round,
        firstName: playersTable.firstName,
        lastName: playersTable.lastName,
      })
      .from(scoresTable)
      .leftJoin(playersTable, eq(playersTable.id, scoresTable.playerId))
      .where(eq(scoresTable.tournamentId, tournamentId));

    const rounds = tournament?.rounds ?? 1;
    for (let r = 1; r <= rounds; r++) {
      const roundScores = allScores.filter(s => s.round === r);
      let carryHole: number | null = null;
      for (let hole = 1; hole <= 18; hole++) {
        const holeScores = roundScores.filter(s => s.holeNumber === hole);
        if (holeScores.length === 0) {
          skinsResults.push({ hole, round: r, winnerId: null, winnerName: null, winnerScore: null, tied: false, carriedFrom: null });
          continue;
        }
        const minStrokes = Math.min(...holeScores.map(s => s.strokes));
        const winners = holeScores.filter(s => s.strokes === minStrokes);
        const tied = winners.length > 1;
        if (tied) {
          carryHole = hole;
          skinsResults.push({ hole, round: r, winnerId: null, winnerName: null, winnerScore: minStrokes, tied: true, carriedFrom: null });
        } else {
          const w = winners[0];
          skinsResults.push({ hole, round: r, winnerId: w.playerId, winnerName: `${w.firstName} ${w.lastName}`, winnerScore: w.strokes, tied: false, carriedFrom: carryHole });
          carryHole = null;
        }
      }
    }
  }

  res.json({
    config: cfg ?? null,
    manual: manualResults,
    skins: skinsResults,
  });
});

// GET /api/public/tournaments/:tournamentId/eclectic — best score per player per hole across all rounds
router.get("/tournaments/:tournamentId/eclectic", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const eclecticRows = await db
    .select()
    .from(eclecticScoresView)
    .where(eq(eclecticScoresView.tournamentId, tournamentId));

  const players = await db
    .select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, handicapIndex: playersTable.handicapIndex })
    .from(playersTable)
    .where(eq(playersTable.tournamentId, tournamentId));

  const holes = await db
    .select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
    .from(holeDetailsTable)
    .innerJoin(tournamentsTable, eq(tournamentsTable.courseId, holeDetailsTable.courseId))
    .where(eq(tournamentsTable.id, tournamentId))
    .orderBy(holeDetailsTable.holeNumber);

  const byPlayer = new Map<number, { holeNumber: number; bestStrokes: number }[]>();
  for (const row of eclecticRows) {
    if (!byPlayer.has(row.playerId)) byPlayer.set(row.playerId, []);
    byPlayer.get(row.playerId)!.push({ holeNumber: row.holeNumber, bestStrokes: Number(row.bestStrokes) });
  }

  const results = players.map(p => {
    const holeData = byPlayer.get(p.id) ?? [];
    const totalEclectic = holeData.reduce((acc, h) => acc + h.bestStrokes, 0);
    const totalPar = holes.reduce((acc, h) => acc + h.par, 0);
    return {
      playerId: p.id,
      playerName: `${p.firstName} ${p.lastName}`,
      handicapIndex: p.handicapIndex ? Number(p.handicapIndex) : null,
      totalEclectic: holeData.length > 0 ? totalEclectic : null,
      totalPar: holes.length > 0 ? totalPar : null,
      eclecticToPar: holeData.length > 0 && holes.length > 0 ? totalEclectic - totalPar : null,
      holeScores: holeData.sort((a, b) => a.holeNumber - b.holeNumber),
    };
  }).filter(p => p.totalEclectic !== null).sort((a, b) => (a.eclecticToPar ?? 999) - (b.eclecticToPar ?? 999));

  res.json({ tournamentId, results });
});

// GET /api/public/tournaments/:tournamentId/results — final tournament results with side games
// Only available once the tournament is in 'completed' status
router.get("/tournaments/:tournamentId/results", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select({ id: tournamentsTable.id, status: tournamentsTable.status, organizationId: tournamentsTable.organizationId })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  if (tournament.status !== "completed") {
    res.status(403).json({ error: "Results are only available after the tournament is completed" });
    return;
  }

  const [leaderboard, sideGamesCfg, sideGamesManual, orgRow, orgSponsors] = await Promise.all([
    computeLeaderboard(tournamentId),
    db.select().from(sideGamesConfigTable).where(eq(sideGamesConfigTable.tournamentId, tournamentId)).then(r => r[0] ?? null),
    db.select({
      id: sideGameResultsTable.id,
      gameType: sideGameResultsTable.gameType,
      holeNumber: sideGameResultsTable.holeNumber,
      round: sideGameResultsTable.round,
      notes: sideGameResultsTable.notes,
      prize: sideGameResultsTable.prize,
      playerId: sideGameResultsTable.playerId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    })
    .from(sideGameResultsTable)
    .leftJoin(playersTable, eq(playersTable.id, sideGameResultsTable.playerId))
    .where(eq(sideGameResultsTable.tournamentId, tournamentId)),
    db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, tournament.organizationId)).then(r => r[0] ?? null),
    db.select({
      id: sponsorsTable.id,
      name: sponsorsTable.name,
      logoUrl: sponsorsTable.logoUrl,
      tier: sponsorsTable.tier,
      websiteUrl: sponsorsTable.websiteUrl,
      displayOrder: sponsorsTable.displayOrder,
    })
    .from(sponsorsTable)
    .where(and(
      eq(sponsorsTable.organizationId, tournament.organizationId),
      eq(sponsorsTable.isActive, true),
      or(eq(sponsorsTable.tournamentId, tournamentId), isNull(sponsorsTable.tournamentId)),
    ))
    .orderBy(asc(sponsorsTable.displayOrder)),
  ]);

  if (!leaderboard) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  // Auto-compute skins if enabled
  type SkinResult = { hole: number; round: number; winnerId: number | null; winnerName: string | null; winnerScore: number | null; tied: boolean; carriedFrom: number | null };
  let skinsResults: SkinResult[] = [];

  if (sideGamesCfg?.skinsEnabled) {
    const allScores = await db
      .select({ playerId: scoresTable.playerId, holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes, round: scoresTable.round, firstName: playersTable.firstName, lastName: playersTable.lastName })
      .from(scoresTable)
      .leftJoin(playersTable, eq(playersTable.id, scoresTable.playerId))
      .where(eq(scoresTable.tournamentId, tournamentId));

    const rounds = leaderboard.rounds ?? 1;
    const holeCount = 18;
    for (let r = 1; r <= rounds; r++) {
      const roundScores = allScores.filter(s => s.round === r);
      let carryHole: number | null = null;
      for (let hole = 1; hole <= holeCount; hole++) {
        const holeScores = roundScores.filter(s => s.holeNumber === hole);
        if (holeScores.length === 0) { skinsResults.push({ hole, round: r, winnerId: null, winnerName: null, winnerScore: null, tied: false, carriedFrom: null }); continue; }
        const minStrokes = Math.min(...holeScores.map(s => s.strokes));
        const winners = holeScores.filter(s => s.strokes === minStrokes);
        if (winners.length > 1) {
          carryHole = hole;
          skinsResults.push({ hole, round: r, winnerId: null, winnerName: null, winnerScore: minStrokes, tied: true, carriedFrom: null });
        } else {
          const w = winners[0];
          skinsResults.push({ hole, round: r, winnerId: w.playerId, winnerName: `${w.firstName} ${w.lastName}`, winnerScore: w.strokes, tied: false, carriedFrom: carryHole });
          carryHole = null;
        }
      }
    }
  }

  res.json({
    ...leaderboard,
    sideGamesConfig: sideGamesCfg,
    sideGameWinners: sideGamesManual,
    skinsResults,
    organizationName: orgRow?.name ?? null,
    organizationLogoUrl: orgRow?.logoUrl ?? null,
    organizationPrimaryColor: orgRow?.primaryColor ?? null,
    sponsors: orgSponsors,
  });
});

// GET /api/public/tournaments/:tournamentId/results/pdf — downloadable results PDF
// Only available once the tournament is in 'completed' status
router.get("/tournaments/:tournamentId/results/pdf", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));

  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      status: tournamentsTable.status,
      organizationId: tournamentsTable.organizationId,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      rounds: tournamentsTable.rounds,
      startDate: tournamentsTable.startDate,
      courseId: tournamentsTable.courseId,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }
  if (tournament.status !== "completed") {
    res.status(403).json({ error: "Results are only available after the tournament is completed" });
    return;
  }

  const [leaderboard, sideGamesManual, orgRow, orgSponsors] = await Promise.all([
    computeLeaderboard(tournamentId),
    db.select({
      gameType: sideGameResultsTable.gameType,
      holeNumber: sideGameResultsTable.holeNumber,
      prize: sideGameResultsTable.prize,
      notes: sideGameResultsTable.notes,
      playerId: sideGameResultsTable.playerId,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
    })
    .from(sideGameResultsTable)
    .leftJoin(playersTable, eq(playersTable.id, sideGameResultsTable.playerId))
    .where(eq(sideGameResultsTable.tournamentId, tournamentId)),
    db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
      .from(organizationsTable).where(eq(organizationsTable.id, tournament.organizationId)).then(r => r[0] ?? null),
    db.select({ name: sponsorsTable.name, tier: sponsorsTable.tier, logoUrl: sponsorsTable.logoUrl, websiteUrl: sponsorsTable.websiteUrl })
      .from(sponsorsTable)
      .where(and(
        eq(sponsorsTable.organizationId, tournament.organizationId),
        eq(sponsorsTable.isActive, true),
        or(eq(sponsorsTable.tournamentId, tournamentId), isNull(sponsorsTable.tournamentId)),
      ))
      .orderBy(asc(sponsorsTable.displayOrder)),
  ]);

  if (!leaderboard) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const isStableford = (tournament.format ?? "") === "stableford";

  const [courseRow, roundCourseRows] = await Promise.all([
    tournament.courseId
      ? db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId)).then(r => r[0] ?? null)
      : Promise.resolve(null),
    db.select({ roundNumber: tournamentRoundsTable.roundNumber, courseName: coursesTable.name })
      .from(tournamentRoundsTable)
      .leftJoin(coursesTable, eq(tournamentRoundsTable.courseId, coursesTable.id))
      .where(eq(tournamentRoundsTable.tournamentId, tournamentId))
      .orderBy(asc(tournamentRoundsTable.roundNumber)),
  ]);

  const tournamentDate = tournament.startDate
    ? new Date(tournament.startDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : null;

  const pdfBuffer = await generateTournamentReportPDF({
    org: {
      name: orgRow?.name ?? "KHARAGOLF",
      logoUrl: orgRow?.logoUrl ?? null,
      primaryColor: orgRow?.primaryColor ?? null,
    },
    tournament: {
      name: tournament.name,
      format: tournament.format ?? "stroke",
      coursePar: leaderboard.coursePar ?? 72,
      rounds: tournament.rounds ?? 1,
      courseName: courseRow?.name ?? null,
      date: tournamentDate,
      roundCourseAssignments: roundCourseRows.map(r => ({ roundNumber: r.roundNumber, courseName: r.courseName ?? null })),
    },
    entries: (leaderboard.entries ?? []).map((e: Record<string, unknown>) => ({
      positionDisplay: String(e.positionDisplay ?? e.position ?? ""),
      playerName: String(e.playerName ?? ""),
      playingHandicap: Number(e.playingHandicap ?? 0),
      grossScore: e.grossScore != null ? Number(e.grossScore) : null,
      netScore: e.netScore != null ? Number(e.netScore) : null,
      scoreToPar: e.scoreToPar != null ? Number(e.scoreToPar) : null,
      stablefordPoints: e.stablefordPoints != null ? Number(e.stablefordPoints) : null,
      holesCompleted: Number(e.holesCompleted ?? 0),
      roundScores: Array.isArray(e.roundScores)
        ? (e.roundScores as Array<Record<string, unknown>>).map(rs => ({
            round: Number(rs.round),
            grossScore: Number(rs.grossScore ?? 0),
            scoreToPar: Number(rs.scoreToPar ?? 0),
            isComplete: Boolean(rs.isComplete),
          }))
        : undefined,
    })),
    netEntries: (leaderboard.netEntries ?? []).map((e: Record<string, unknown>) => ({
      positionDisplay: String(e.positionDisplay ?? e.position ?? ""),
      playerName: String(e.playerName ?? ""),
      playingHandicap: Number(e.playingHandicap ?? 0),
      grossScore: e.grossScore != null ? Number(e.grossScore) : null,
      netScore: e.netScore != null ? Number(e.netScore) : null,
      scoreToPar: e.scoreToPar != null ? Number(e.scoreToPar) : null,
      stablefordPoints: e.stablefordPoints != null ? Number(e.stablefordPoints) : null,
      holesCompleted: Number(e.holesCompleted ?? 0),
    })),
    sideGameWinners: sideGamesManual.map(w => ({
      gameType: w.gameType,
      holeNumber: w.holeNumber ?? null,
      firstName: w.firstName ?? null,
      lastName: w.lastName ?? null,
      prize: w.prize ?? null,
      notes: w.notes ?? null,
    })),
    sponsors: orgSponsors,
    isStableford,
  });

  const safeName = tournament.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}_results.pdf"`);
  res.setHeader("Content-Length", pdfBuffer.length);
  res.end(pdfBuffer);
});

// POST /api/public/orgs/:orgId/leagues/:leagueId/join
// Public: join a league, optionally consuming an invite token.
// Mirrors the tournament registration flow: validates + atomically consumes invite token.
router.post("/orgs/:orgId/leagues/:leagueId/join", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const leagueId = parseInt(String((req.params as Record<string, string>).leagueId));

  const [league] = await db
    .select()
    .from(leaguesTable)
    .where(and(eq(leaguesTable.id, leagueId), eq(leaguesTable.organizationId, orgId)));

  if (!league) {
    res.status(404).json({ error: "League not found" });
    return;
  }

  const { firstName, lastName, email, phone, handicapIndex, teamName, inviteToken } = req.body;

  if (!firstName || !lastName) {
    res.status(400).json({ error: "firstName and lastName are required" });
    return;
  }

  // Members-only gating: requires an authenticated portal session with a verified club membership linkage
  if (league.membersOnly) {
    const sessionUser = req.user as { id?: number } | undefined;
    if (!sessionUser?.id) {
      res.status(403).json({
        error: "This league is open to club members only. Please sign in to the Player Portal to register.",
        membersOnly: true,
      });
      return;
    }
    const [linkedMember] = await db
      .select({ id: clubMembersTable.id, subscriptionStatus: clubMembersTable.subscriptionStatus })
      .from(clubMembersTable)
      .where(
        and(
          eq(clubMembersTable.organizationId, orgId),
          eq(clubMembersTable.userId, sessionUser.id),
        )
      )
      .limit(1);
    if (!linkedMember || linkedMember.subscriptionStatus === "cancelled") {
      res.status(403).json({
        error: "This league is open to club members only. Your portal account does not have an active club membership for this club.",
        membersOnly: true,
      });
      return;
    }
  }

  // Validate invite token pre-flight (cheap checks before entering transaction)
  if (inviteToken) {
    const [invite] = await db
      .select({
        id: invitationsTable.id,
        status: invitationsTable.status,
        expiresAt: invitationsTable.expiresAt,
        tournamentId: invitationsTable.tournamentId,
        leagueId: invitationsTable.leagueId,
        organizationId: invitationsTable.organizationId,
      })
      .from(invitationsTable)
      .where(eq(invitationsTable.token, inviteToken as string));

    if (!invite) { { res.status(400).json({ error: "Invalid invite token" }); return; } }
    if (invite.status === "revoked") { { res.status(400).json({ error: "This invitation has been revoked" }); return; } }
    if (invite.status === "accepted") { { res.status(400).json({ error: "This invitation has already been used" }); return; } }
    if (new Date(invite.expiresAt) < new Date()) { { res.status(400).json({ error: "This invitation has expired" }); return; } }
    if (invite.organizationId !== orgId) { { res.status(400).json({ error: "Invitation is for a different organization" }); return; } }
    if (invite.tournamentId && !invite.leagueId) { { res.status(400).json({ error: "This invitation is for a tournament, not a league" }); return; } }
    if (invite.leagueId !== null && invite.leagueId !== leagueId) { { res.status(400).json({ error: "Invitation is for a different league" }); return; } }
  }

  // Atomically claim invite token + insert member inside a transaction.
  // The UPDATE WHERE (status='pending' AND expiresAt>now()) returns 0 rows if another
  // concurrent request already claimed the token, causing the transaction to roll back.
  let member: typeof leagueMembersTable.$inferSelect;
  try {
    member = await db.transaction(async (tx) => {
      if (inviteToken) {
        const claimed = await tx
          .update(invitationsTable)
          .set({ status: "accepted", acceptedAt: new Date() })
          .where(
            and(
              eq(invitationsTable.token, inviteToken as string),
              eq(invitationsTable.status, "pending"),
              gt(invitationsTable.expiresAt, new Date()),
            ),
          )
          .returning({ id: invitationsTable.id });

        if (claimed.length === 0) {
          throw new Error("INVITE_ALREADY_USED");
        }
      }

      const [inserted] = await tx
        .insert(leagueMembersTable)
        .values({
          leagueId,
          userId: null,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email?.trim() || null,
          handicapIndex: handicapIndex ? String(parseFloat(handicapIndex)) : null,
          teamName: teamName?.trim() || null,
        })
        .returning();

      await tx
        .insert(leagueStandingsTable)
        .values({ leagueId, memberId: inserted.id })
        .onConflictDoNothing();

      return inserted;
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "";
    if (msg === "INVITE_ALREADY_USED") {
      res.status(409).json({ error: "This invitation has already been used" });
    } else {
      res.status(500).json({ error: "Join failed" });
    }
    return;
  }

  res.status(201).json({ ...member, leagueName: league.name });
});

// GET /api/public/invitations/:token — resolve an invite token to league/tournament metadata
// Used by the public league-join landing page to display event info before accepting.
router.get("/invitations/:token", async (req: Request, res: Response) => {
  const { token } = (req.params as Record<string, string>);
  if (!token) { { res.status(400).json({ error: "Token required" }); return; } }

  const [invite] = await db
    .select({
      id: invitationsTable.id,
      status: invitationsTable.status,
      expiresAt: invitationsTable.expiresAt,
      organizationId: invitationsTable.organizationId,
      leagueId: invitationsTable.leagueId,
      tournamentId: invitationsTable.tournamentId,
      recipientName: invitationsTable.recipientName,
    })
    .from(invitationsTable)
    .where(eq(invitationsTable.token, token));

  if (!invite) { { res.status(404).json({ error: "Invitation not found" }); return; } }

  const effectiveStatus = invite.status === "pending" && new Date(invite.expiresAt) < new Date() ? "expired" : invite.status;
  if (effectiveStatus === "revoked") { { res.status(410).json({ error: "This invitation has been revoked" }); return; } }
  if (effectiveStatus === "accepted") { { res.status(409).json({ error: "This invitation has already been used" }); return; } }
  if (effectiveStatus === "expired") { { res.status(410).json({ error: "This invitation has expired" }); return; } }

  let leagueName: string | null = null;
  let leagueMembersOnly: boolean = false;
  let leagueEntryFee: string | null = null;
  let leagueMemberEntryFee: string | null = null;
  let leagueCurrency: string | null = null;
  let tournamentName: string | null = null;
  let orgName: string | null = null;

  if (invite.leagueId) {
    const [l] = await db.select({
      name: leaguesTable.name,
      membersOnly: leaguesTable.membersOnly,
      entryFee: leaguesTable.entryFee,
      memberEntryFee: leaguesTable.memberEntryFee,
      currency: leaguesTable.currency,
    }).from(leaguesTable).where(eq(leaguesTable.id, invite.leagueId));
    leagueName = l?.name ?? null;
    leagueMembersOnly = l?.membersOnly ?? false;
    leagueEntryFee = l?.entryFee ?? null;
    leagueMemberEntryFee = l?.memberEntryFee ?? null;
    leagueCurrency = l?.currency ?? null;
  }
  if (invite.tournamentId) {
    const [t] = await db.select({ name: tournamentsTable.name }).from(tournamentsTable).where(eq(tournamentsTable.id, invite.tournamentId));
    tournamentName = t?.name ?? null;
  }
  if (invite.organizationId) {
    const [o] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, invite.organizationId));
    orgName = o?.name ?? null;
  }

  res.json({
    organizationId: invite.organizationId,
    leagueId: invite.leagueId,
    tournamentId: invite.tournamentId,
    recipientName: invite.recipientName,
    leagueName,
    leagueMembersOnly,
    leagueEntryFee,
    leagueMemberEntryFee,
    leagueCurrency,
    tournamentName,
    orgName,
    expiresAt: invite.expiresAt,
  });
});

// GET /api/public/tournaments/:tournamentId/announcements — public feed for live leaderboard + mobile
// Public tournaments: no auth required. Private tournaments: require authenticated enrolled player.
router.get("/tournaments/:tournamentId/announcements", async (req: Request, res: Response) => {
  const tid = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tid)) {
    res.status(400).json({ error: "Invalid tournament ID" });
    return;
  }

  const [t] = await db
    .select({ isPublic: tournamentsTable.isPublic })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tid));
  if (!t) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  if (!t.isPublic) {
    // Private tournament: require the caller to be an authenticated enrolled player
    if (!req.isAuthenticated()) {
      res.status(403).json({ error: "Authentication required to view announcements for this tournament" });
      return;
    }
    const caller = req.user as { id?: number; email?: string } | undefined;
    const [enrollment] = await db
      .select({ id: playersTable.id })
      .from(playersTable)
      .where(and(
        eq(playersTable.tournamentId, tid),
        sql`(${playersTable.userId} = ${caller?.id ?? 0} OR lower(${playersTable.email}) = lower(${caller?.email ?? ''}))`,
      ));
    if (!enrollment) {
      res.status(403).json({ error: "You must be registered in this tournament to view announcements" });
      return;
    }
  }

  const rows = await db
    .select({
      id: tournamentAnnouncementsTable.id,
      body: tournamentAnnouncementsTable.body,
      type: tournamentAnnouncementsTable.type,
      authorName: tournamentAnnouncementsTable.authorName,
      sentAt: tournamentAnnouncementsTable.sentAt,
    })
    .from(tournamentAnnouncementsTable)
    .where(eq(tournamentAnnouncementsTable.tournamentId, tid))
    .orderBy(desc(tournamentAnnouncementsTable.sentAt));
  res.json(rows);
});

// GET /api/public/tournaments/:tournamentId/gallery
// Returns approved media items for a tournament (no auth required)
router.get("/tournaments/:tournamentId/gallery", async (req: Request, res: Response) => {
  const tid = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tid)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const items = await db
    .select({
      id: mediaTable.id,
      objectPath: mediaTable.objectPath,
      caption: mediaTable.caption,
      uploaderName: mediaTable.uploaderName,
      uploadedByUserId: mediaTable.uploadedByUserId,
      mediaType: mediaTable.mediaType,
      approved: mediaTable.approved,
      createdAt: mediaTable.createdAt,
    })
    .from(mediaTable)
    .where(and(eq(mediaTable.tournamentId, tid), eq(mediaTable.approved, true)))
    .orderBy(desc(mediaTable.createdAt))
    .limit(100);

  res.json(items);
});

// GET /api/public/tournaments/:tournamentId/bracket
// Public: returns match play bracket data for a tournament (no auth required)
router.get("/tournaments/:tournamentId/bracket", async (req: Request, res: Response) => {
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  if (isNaN(tournamentId)) { { res.status(400).json({ error: "Invalid tournamentId" }); return; } }

  const [tournament] = await db
    .select({ id: tournamentsTable.id, name: tournamentsTable.name, format: tournamentsTable.format })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  if (tournament.format !== "match_play") {
    res.json({ format: tournament.format, matches: [], rounds: [] });
    return;
  }

  const matches = await db
    .select()
    .from(matchResultsTable)
    .where(eq(matchResultsTable.tournamentId, tournamentId))
    .orderBy(asc(matchResultsTable.round), asc(matchResultsTable.id));

  if (matches.length === 0) {
    res.json({ format: tournament.format, matches: [], rounds: [] });
    return;
  }

  const players = await db
    .select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName })
    .from(playersTable)
    .where(and(eq(playersTable.tournamentId, tournamentId)));

  const playerMap = new Map(players.map(p => [p.id, `${p.firstName} ${p.lastName}`]));

  const enriched = matches.map(m => ({
    id: m.id,
    round: m.round,
    player1Id: m.player1Id,
    player1Name: playerMap.get(m.player1Id) ?? "TBD",
    player2Id: m.player2Id,
    player2Name: playerMap.get(m.player2Id) ?? "TBD",
    winnerId: m.winnerId ?? null,
    winnerName: m.winnerId ? (playerMap.get(m.winnerId) ?? null) : null,
    result: m.result ?? null,
    isComplete: m.isComplete,
  }));

  const roundNums = Array.from(new Set(enriched.map(m => m.round))).sort((a, b) => a - b);
  const rounds = roundNums.map(r => ({
    round: r,
    label: roundLabel(r, roundNums.length),
    matches: enriched.filter(m => m.round === r),
  }));

  res.json({ format: tournament.format, rounds, matches: enriched });
});

function roundLabel(round: number, totalRounds: number): string {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return "Final";
  if (fromEnd === 1) return "Semi Finals";
  if (fromEnd === 2) return "Quarter Finals";
  // fromEnd === 3 means 4 rounds: R1 is Round of 16 (2^(fromEnd+1) players)
  const playerCount = Math.pow(2, fromEnd + 1);
  return `Round of ${playerCount}`;
}

// GET /api/public/orgs/:orgId/contact — public club contact information
router.get("/orgs/:orgId/contact", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  if (isNaN(orgId)) { { res.status(400).json({ error: "Invalid orgId" }); return; } }

  const [org] = await db
    .select({
      name: organizationsTable.name,
      contactEmail: organizationsTable.contactEmail,
      contactPhone: organizationsTable.contactPhone,
      address: organizationsTable.address,
      website: organizationsTable.website,
      logoUrl: organizationsTable.logoUrl,
    })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));

  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  res.json(org);
});

// GET /api/public/scorecard/:shareToken — full scorecard data for a shared player entry
router.get("/scorecard/:shareToken", async (req: Request, res: Response) => {
  const { shareToken } = (req.params as Record<string, string>);
  if (!shareToken) { { res.status(400).json({ error: "Missing share token" }); return; } }

  const [player] = await db
    .select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      handicapIndex: playersTable.handicapIndex,
      teeBox: playersTable.teeBox,
      tournamentId: playersTable.tournamentId,
      publicHidden: playersTable.publicHidden,
    })
    .from(playersTable)
    .where(eq(playersTable.shareToken, shareToken));

  if (!player) { { res.status(404).json({ error: "Scorecard not found" }); return; } }
  // Honor per-scorecard privacy hide flag (Task #383)
  if (player.publicHidden) { { res.status(404).json({ error: "Scorecard not found" }); return; } }

  const [tournament] = await db
    .select({
      id: tournamentsTable.id,
      name: tournamentsTable.name,
      format: tournamentsTable.format,
      startDate: tournamentsTable.startDate,
      rounds: tournamentsTable.rounds,
      organizationId: tournamentsTable.organizationId,
      courseId: tournamentsTable.courseId,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, player.tournamentId));

  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [org] = await db
    .select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, tournament.organizationId));

  let courseName: string | null = null;
  let holeDetails: { holeNumber: number; par: number }[] = [];
  if (tournament.courseId) {
    const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, tournament.courseId));
    courseName = course?.name ?? null;
    holeDetails = await db
      .select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par })
      .from(holeDetailsTable)
      .where(eq(holeDetailsTable.courseId, tournament.courseId))
      .orderBy(holeDetailsTable.holeNumber);
  }

  const parMap = new Map(holeDetails.map(h => [h.holeNumber, h.par]));

  const scores = await db
    .select()
    .from(scoresTable)
    .where(eq(scoresTable.playerId, player.id))
    .orderBy(scoresTable.round, scoresTable.holeNumber);

  const rounds = [...new Set(scores.map(s => s.round))].sort((a, b) => a - b);
  const roundData = rounds.map(roundNum => {
    const roundScores = scores.filter(s => s.round === roundNum);
    const gross = roundScores.reduce((a, s) => a + s.strokes, 0);
    const par = roundScores.reduce((a, s) => a + (parMap.get(s.holeNumber) ?? 4), 0);
    const holes = roundScores.map(s => ({
      holeNumber: s.holeNumber,
      par: parMap.get(s.holeNumber) ?? 4,
      strokes: s.strokes,
      toPar: s.strokes - (parMap.get(s.holeNumber) ?? 4),
      putts: s.putts ?? null,
      fairwayHit: s.fairwayHit ?? null,
      girHit: s.girHit ?? null,
    }));
    const fw = roundScores.filter(s => s.fairwayHit !== null);
    const gir = roundScores.filter(s => s.girHit !== null);
    const putts = roundScores.filter(s => s.putts !== null);
    return {
      round: roundNum,
      gross,
      net: null,
      toPar: gross - par,
      holes,
      fairwayPct: fw.length > 0 ? Math.round((fw.filter(s => s.fairwayHit).length / fw.length) * 100) : null,
      girPct: gir.length > 0 ? Math.round((gir.filter(s => s.girHit).length / gir.length) * 100) : null,
      totalPutts: putts.reduce((a, s) => a + (s.putts ?? 0), 0) || null,
    };
  });

  // Fetch prize awards for this player in this tournament, preferring structured award fields
  const prizeAwards = await db
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
    })
    .from(prizeAwardsTable)
    .innerJoin(prizeCategoriesTable, eq(prizeAwardsTable.prizeCategoryId, prizeCategoriesTable.id))
    .where(and(eq(prizeAwardsTable.playerId, player.id), eq(prizeAwardsTable.tournamentId, tournament.id)));

  res.json({
    player: {
      id: player.id,
      firstName: player.firstName,
      lastName: player.lastName,
      handicapIndex: player.handicapIndex ? Number(player.handicapIndex) : null,
      teeBox: player.teeBox,
    },
    tournament: {
      id: tournament.id,
      name: tournament.name,
      format: tournament.format,
      startDate: tournament.startDate,
      rounds: tournament.rounds,
      organizationId: tournament.organizationId,
    },
    organization: { name: org?.name ?? "Golf Club", logoUrl: org?.logoUrl ?? null, primaryColor: org?.primaryColor ?? null },
    courseName,
    rounds: roundData,
    prizeAwards: prizeAwards.map(a => ({
      awardId: a.awardId,
      categoryName: a.categoryName,
      description: a.description ?? null,
      prizeValue: a.awardAmount ? Number(a.awardAmount) : (a.categoryValue ? Number(a.categoryValue) : null),
      currency: a.awardCurrency ?? a.categoryCurrency,
      notes: a.notes ?? null,
      awardedAt: a.awardedAt,
    })),
  });
});

// GET /api/public/scorecard/:shareToken/source-breakdown/:round
// Task #1017 — public mirror of /portal/rounds/:round/source-breakdown so that
// shared scorecard pages can show the same Watch/Phone/Scorer/Manual % badges
// per round. Resolves the player via shareToken (no auth required), then
// counts shots by source for the requested round in that player's tournament.
router.get("/scorecard/:shareToken/source-breakdown/:round", async (req: Request, res: Response) => {
  const { shareToken } = (req.params as Record<string, string>);
  const round = parseInt(String((req.params as Record<string, string>).round), 10);
  if (!shareToken) { { res.status(400).json({ error: "Missing share token" }); return; } }
  if (isNaN(round)) { { res.status(400).json({ error: "Invalid round" }); return; } }

  const [player] = await db
    .select({ id: playersTable.id, publicHidden: playersTable.publicHidden })
    .from(playersTable)
    .where(eq(playersTable.shareToken, shareToken));
  if (!player || player.publicHidden) {
    res.status(404).json({ error: "Scorecard not found" }); return;
  }

  const rows = await db
    .select({ source: shotsTable.source, n: count(shotsTable.id) })
    .from(shotsTable)
    .where(and(eq(shotsTable.playerId, player.id), eq(shotsTable.round, round)))
    .groupBy(shotsTable.source);

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

// GET /api/public/scorecard/:shareToken/pdf — PDFKit A4 scorecard PDF
router.get("/scorecard/:shareToken/pdf", async (req: Request, res: Response) => {
  const { shareToken } = (req.params as Record<string, string>);
  if (!shareToken) { { res.status(400).json({ error: "Missing share token" }); return; } }

  const [player] = await db
    .select({ id: playersTable.id, firstName: playersTable.firstName, lastName: playersTable.lastName, handicapIndex: playersTable.handicapIndex, teeBox: playersTable.teeBox, tournamentId: playersTable.tournamentId })
    .from(playersTable).where(eq(playersTable.shareToken, shareToken));
  if (!player) { { res.status(404).json({ error: "Scorecard not found" }); return; } }

  const [tournament] = await db
    .select({ id: tournamentsTable.id, name: tournamentsTable.name, format: tournamentsTable.format, startDate: tournamentsTable.startDate, rounds: tournamentsTable.rounds, organizationId: tournamentsTable.organizationId, courseId: tournamentsTable.courseId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, player.tournamentId));
  if (!tournament) { { res.status(404).json({ error: "Tournament not found" }); return; } }

  const [org] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, tournament.organizationId));

  let holeDetails: { holeNumber: number; par: number }[] = [];
  if (tournament.courseId) {
    holeDetails = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par }).from(holeDetailsTable).where(eq(holeDetailsTable.courseId, tournament.courseId)).orderBy(holeDetailsTable.holeNumber);
  }
  const parMap = new Map(holeDetails.map(h => [h.holeNumber, h.par]));

  const scores = await db.select().from(scoresTable).where(eq(scoresTable.playerId, player.id)).orderBy(scoresTable.round, scoresTable.holeNumber);
  const rounds = [...new Set(scores.map(s => s.round))].sort((a, b) => a - b);

  // Task #1181 — same Watch/Phone/Scorer/Manual breakdown shown on the share
  // page and the downloadable card image is rendered per round in the PDF so
  // the data-quality signal survives printing/forwarding. Counts come from
  // shotsTable grouped by (round, source); rounds with no shot data render no
  // strip (matches the page behaviour when total === 0).
  type SrcKey = "watch" | "phone" | "scorer" | "manual";
  const sourceRows = await db
    .select({ round: shotsTable.round, source: shotsTable.source, n: count(shotsTable.id) })
    .from(shotsTable)
    .where(eq(shotsTable.playerId, player.id))
    .groupBy(shotsTable.round, shotsTable.source);
  const sourceBreakdownByRound = new Map<number, { counts: Record<SrcKey, number>; total: number }>();
  for (const r of sourceRows) {
    if (r.round == null) continue;
    const src = ((r.source ?? "manual") as string) as SrcKey;
    let entry = sourceBreakdownByRound.get(r.round);
    if (!entry) {
      entry = { counts: { watch: 0, phone: 0, scorer: 0, manual: 0 }, total: 0 };
      sourceBreakdownByRound.set(r.round, entry);
    }
    const n = Number(r.n);
    if (src === "watch" || src === "phone" || src === "scorer" || src === "manual") {
      entry.counts[src] = n;
    }
    entry.total += n;
  }

  // Resolve a sponsor creative for the printed scorecard footer through the
  // campaign delivery engine (Task #445). Each generated PDF is treated as a
  // unique session so weighted/frequency-capped rotation works the same way
  // as the digital AdSlot surfaces.
  const adSessionId = `pdf_${shareToken}_${Date.now()}`;
  const footerAd = await selectAdSlotCreative(
    tournament.organizationId,
    "scorecard_footer",
    adSessionId,
    player.tournamentId,
  ).catch(() => null);

  // Fire-and-forget: log a scorecard_footer impression for the chosen campaign.
  if (footerAd && footerAd.creative && footerAd.campaign && footerAd.sponsor) {
    db.insert(sponsorEventsTable).values({
      sponsorId: footerAd.sponsor.id,
      organizationId: tournament.organizationId,
      tournamentId: player.tournamentId,
      eventType: "impression",
      source: "scorecard_footer",
      sessionId: adSessionId,
      slotKey: "scorecard_footer",
      campaignId: footerAd.campaign.id,
      creativeId: footerAd.creative.id,
    }).catch(() => null);
  }

  // Best-effort fetch of the creative image bytes for embedding in the PDF.
  // SSRF hardening: only HTTPS, resolve the hostname and refuse private,
  // loopback, link-local, or unspecified IP targets before making the request.
  let footerImage: Buffer | null = null;
  if (footerAd && footerAd.creative && footerAd.creative.mediaType === "image") {
    footerImage = await fetchCreativeImageCached(footerAd.creative.id, footerAd.creative.mediaUrl);
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="scorecard_${player.firstName}_${player.lastName}.pdf"`);

  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);

  const gold = "#C9A84C";
  const dark = "#0a1a0f";
  const W = 515;

  // Header
  doc.rect(0, 0, 595, 70).fill(dark);
  doc.fillColor(gold).fontSize(20).font("Helvetica-Bold").text("KHARAGOLF", 40, 22, { continued: true });
  doc.fillColor("white").fontSize(14).font("Helvetica").text(`  ${org?.name ?? ""}`, { continued: false });
  doc.fillColor("white").fontSize(10).text(tournament.name, 40, 46);
  doc.fillColor(gold).fontSize(9).text(`${player.firstName} ${player.lastName}  |  HCP: ${player.handicapIndex ?? "N/A"}  |  Tees: ${player.teeBox ?? "White"}`, 40, 58);

  let y = 85;

  for (const roundNum of rounds) {
    const rScores = scores.filter(s => s.round === roundNum).sort((a, b) => a.holeNumber - b.holeNumber);
    const gross = rScores.reduce((a, s) => a + s.strokes, 0);
    const par = rScores.reduce((a, s) => a + (parMap.get(s.holeNumber) ?? 4), 0);

    // Round header
    doc.fillColor(dark).rect(40, y, W, 18).fill();
    doc.fillColor(gold).fontSize(10).font("Helvetica-Bold").text(`ROUND ${roundNum}   Gross: ${gross}   Score to Par: ${gross - par >= 0 ? "+" : ""}${gross - par}`, 44, y + 4);
    y += 22;

    // Column headers
    const holes = Array.from({ length: 18 }, (_, i) => i + 1);
    const colW = Math.floor(W / 20);
    doc.fillColor("#1a3a2a").rect(40, y, W, 14).fill();
    doc.fillColor(gold).fontSize(7).font("Helvetica-Bold");
    doc.text("HOLE", 40, y + 3);
    holes.forEach((h, i) => { doc.text(String(h), 40 + 40 + i * colW, y + 3); });
    doc.text("TOT", 40 + 40 + 18 * colW, y + 3);
    y += 14;

    // Par row
    doc.fillColor("#0f2918").rect(40, y, W, 13).fill();
    doc.fillColor("#9ca3af").fontSize(7).font("Helvetica");
    doc.text("PAR", 40, y + 3);
    let parTotal = 0;
    holes.forEach((h, i) => { const p = parMap.get(h) ?? 4; parTotal += p; doc.text(String(p), 40 + 40 + i * colW, y + 3); });
    doc.text(String(parTotal), 40 + 40 + 18 * colW, y + 3);
    y += 13;

    // Score row
    doc.fillColor("#111").rect(40, y, W, 14).fill();
    doc.fillColor("white").fontSize(7).font("Helvetica-Bold");
    doc.text("SCORE", 40, y + 3);
    holes.forEach((h, i) => {
      const s = rScores.find(sc => sc.holeNumber === h);
      const tp = s ? s.strokes - (parMap.get(h) ?? 4) : null;
      if (s) {
        const bg = tp! <= -2 ? "#d97706" : tp! === -1 ? "#b91c1c" : tp! === 0 ? "#374151" : tp! === 1 ? "#1d4ed8" : "#6b21a8";
        doc.fillColor(bg).rect(40 + 40 + i * colW - 1, y + 1, colW + 1, 12).fill();
        doc.fillColor("white").text(String(s.strokes), 40 + 40 + i * colW, y + 3);
      } else {
        doc.fillColor("#666").text("–", 40 + 40 + i * colW, y + 3);
      }
    });
    doc.fillColor("white").text(String(gross), 40 + 40 + 18 * colW, y + 3);
    y += 18;

    // Task #1181 — render the same Watch/Phone/Scorer/Manual % breakdown
    // shown on the share page and the downloadable card image, per round.
    // Skip rounds with no shot data so blank scorecards don't gain an empty
    // strip. Colour palette mirrors ShotSourceBadges (sky / purple / amber /
    // grey) so the printed PDF reads identically to the digital page.
    const breakdown = sourceBreakdownByRound.get(roundNum);
    if (breakdown && breakdown.total > 0) {
      const stripH = 14;
      doc.fillColor("#0f1d12").rect(40, y, W, stripH).fill();
      doc.fillColor(gold).fontSize(7).font("Helvetica-Bold").text("SOURCE", 44, y + 4);
      const palette: Record<SrcKey, { label: string; bg: string; fg: string }> = {
        watch:  { label: "Watch",  bg: "#0c4a6e", fg: "#7DD3FC" },
        phone:  { label: "Phone",  bg: "#581c87", fg: "#D8B4FE" },
        scorer: { label: "Scorer", bg: "#78350f", fg: "#FCD34D" },
        manual: { label: "Manual", bg: "#374151", fg: "#D1D5DB" },
      };
      const order: SrcKey[] = ["watch", "phone", "scorer", "manual"];
      let chipX = 80;
      const chipY = y + 2;
      const chipH = 10;
      const chipPad = 4;
      const chipGap = 4;
      doc.fontSize(7).font("Helvetica-Bold");
      for (const src of order) {
        const n = breakdown.counts[src];
        if (n === 0) continue;
        const pct = Math.round((n / breakdown.total) * 100);
        const text = `${palette[src].label} ${pct}%`;
        const textW = doc.widthOfString(text);
        const chipW = textW + chipPad * 2;
        if (chipX + chipW > 40 + W - 4) break; // avoid overflow on extreme cases
        doc.fillColor(palette[src].bg).rect(chipX, chipY, chipW, chipH).fill();
        doc.fillColor(palette[src].fg).text(text, chipX + chipPad, chipY + 2, { lineBreak: false });
        chipX += chipW + chipGap;
      }
      y += stripH + 2;
    }
  }

  // Sponsor footer (Task #445) — render the campaign-selected scorecard_footer creative.
  const footerY = 740;
  if (footerAd && footerAd.creative && footerAd.sponsor) {
    const stripH = 56;
    doc.fillColor("#0f1d12").rect(40, footerY, W, stripH).fill();
    // Sponsor image (left side) if we have raster bytes; otherwise headline-only.
    let textX = 50;
    if (footerImage) {
      try {
        doc.image(footerImage, 48, footerY + 6, { fit: [80, stripH - 12] });
        textX = 140;
      } catch {
        textX = 50;
      }
    }
    const headline = footerAd.creative.headline || footerAd.sponsor.name;
    const subheadline = footerAd.creative.subheadline || footerAd.sponsor.websiteUrl || "";
    doc.fillColor(gold).fontSize(7).font("Helvetica").text("SPONSORED BY", textX, footerY + 8);
    doc.fillColor("white").fontSize(11).font("Helvetica-Bold").text(headline, textX, footerY + 18, { width: W - (textX - 40) - 10, ellipsis: true });
    if (subheadline) {
      doc.fillColor("#cbd5e1").fontSize(8).font("Helvetica").text(subheadline, textX, footerY + 36, { width: W - (textX - 40) - 10, ellipsis: true });
    }
  }

  // Generation credit line below the sponsor strip
  doc.fillColor("#374151").fontSize(8).font("Helvetica").text("Generated by KHARAGOLF · kharagolf.replit.app", 40, footerY + 62, { align: "center", width: W });

  doc.end();
});

// ─── Sponsor Event Tracking (no auth) ────────────────────────────────────────
//
// Ad-campaign slot keys are derived from `DEFAULT_SLOTS` in
// `./ad-campaigns.ts` (the single source of truth) so that adding a slot
// there automatically opts it into both the sponsor-event ingestion
// allow-list and the rate-limit bypass below. The startup assertion at the
// bottom of this block fails loudly if drift is ever reintroduced.
const AD_CAMPAIGN_SOURCES: ReadonlySet<string> = AD_CAMPAIGN_DEFAULT_SLOT_KEYS;
// Legacy non-campaign sources retained for back-compat with passive sponsor
// logos and PDFs. New ad-campaign slots must be added to `DEFAULT_SLOTS` in
// `./ad-campaigns.ts`, not here.
const LEGACY_SPONSOR_SOURCES = [
  "leaderboard", "display", "scorecard", "pocket_card", "public_page", "scorecard_pdf", "mobile",
] as const;
const ALLOWED_SOURCES: ReadonlySet<string> = new Set<string>([
  ...LEGACY_SPONSOR_SOURCES,
  ...AD_CAMPAIGN_SOURCES,
]);

// Startup assertion: every default ad-campaign slot key must be present in
// both sets. With the derivation above this can only fail if someone
// reintroduces a hand-maintained parallel list — in which case we crash on
// boot rather than silently 400'ing every impression in production
// (see `mobile_round_summary` regression that motivated Task #1032).
for (const key of AD_CAMPAIGN_DEFAULT_SLOT_KEYS) {
  if (!ALLOWED_SOURCES.has(key) || !AD_CAMPAIGN_SOURCES.has(key)) {
    throw new Error(
      `[sponsor-events] ad-campaign slot key "${key}" is missing from ` +
      `ALLOWED_SOURCES or AD_CAMPAIGN_SOURCES. Both sets must be derived ` +
      `from DEFAULT_SLOTS in routes/ad-campaigns.ts.`,
    );
  }
}
// In-memory rate-limit:
//   impressions: 1 per session+sponsor+source per hour (legacy passive sponsor logos)
//   clicks:      1 per session+sponsor+source per 5 min (fraud protection)
//
// Ad-campaign slots (Task #371) opt out of the impression rate limit because
// per-session frequency caps and weighted rotation are enforced by the
// campaign delivery engine. Click fraud protection still applies to them.
const _sponsorRateLimit = new Map<string, number>();

function checkSponsorRateLimit(eventType: string, source: string, key: string): boolean {
  // Ad-campaign impressions are not rate-limited here; they're capped by
  // campaign frequencyCapPerSession in /public/ad-slot delivery and need
  // accurate per-render counts for reporting.
  if (eventType === "impression" && AD_CAMPAIGN_SOURCES.has(source)) return true;
  const ttl = eventType === "impression" ? 3_600_000 : 300_000;
  const last = _sponsorRateLimit.get(key) ?? 0;
  if (Date.now() - last < ttl) return false;
  _sponsorRateLimit.set(key, Date.now());
  if (_sponsorRateLimit.size > 50_000) {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, v] of _sponsorRateLimit) {
      if (v < cutoff) _sponsorRateLimit.delete(k);
    }
  }
  return true;
}

router.post("/sponsor-events", async (req: Request, res: Response) => {
  const { sponsorId, eventType, source, sessionId, tournamentId: bodyTournamentId, slotKey, campaignId, creativeId } = req.body as {
    sponsorId?: unknown; eventType?: unknown; source?: unknown; sessionId?: unknown; tournamentId?: unknown;
    slotKey?: unknown; campaignId?: unknown; creativeId?: unknown;
  };

  if (
    typeof sponsorId !== "number" ||
    (eventType !== "impression" && eventType !== "click") ||
    typeof source !== "string" ||
    !ALLOWED_SOURCES.has(source) ||
    typeof sessionId !== "string" ||
    !sessionId.trim()
  ) {
    res.status(400).json({ error: "invalid" });
    return;
  }

  // Optional tournamentId from the client — must be a positive integer when provided
  const resolvedTournamentId: number | undefined =
    typeof bodyTournamentId === "number" && Number.isInteger(bodyTournamentId) && bodyTournamentId > 0
      ? bodyTournamentId
      : undefined;

  const rlKey = `${sessionId}:${sponsorId}:${source}:${eventType}`;
  if (!checkSponsorRateLimit(eventType as string, source as string, rlKey)) {
    res.json({ ok: true, skipped: true });
    return;
  }

  const [sponsor] = await db.select({ id: sponsorsTable.id, organizationId: sponsorsTable.organizationId })
    .from(sponsorsTable).where(eq(sponsorsTable.id, sponsorId as number));
  if (!sponsor) { { res.status(404).json({ error: "not found" }); return; } }

  // If tournamentId was provided, validate the tournament belongs to the sponsor's org
  // and that the sponsor can be shown for that tournament.
  // Three supported sponsor models:
  //   1. New assignment model: sponsor has a row in sponsorshipAssignmentsTable for this tournament
  //   2. Legacy tournament-scoped model: sponsor.tournamentId === resolvedTournamentId
  //   3. Org-level sponsor: sponsor.tournamentId IS NULL (shown on all org events)
  if (resolvedTournamentId !== undefined) {
    // Guard: tournament must belong to sponsor's org
    const [tournament] = await db.select({ organizationId: tournamentsTable.organizationId })
      .from(tournamentsTable).where(eq(tournamentsTable.id, resolvedTournamentId));
    if (!tournament || tournament.organizationId !== sponsor.organizationId) {
      res.status(400).json({ error: "invalid tournament for this sponsor" });
      return;
    }

    const [sponsorRow] = await db.select({ tournamentId: sponsorsTable.tournamentId })
      .from(sponsorsTable).where(eq(sponsorsTable.id, sponsor.id));
    const legacyTournamentId = sponsorRow?.tournamentId ?? null;

    // Org-level or legacy-tournament-match: accepted
    const isOrgLevel = legacyTournamentId === null;
    const isLegacyMatch = legacyTournamentId === resolvedTournamentId;
    if (!isOrgLevel && !isLegacyMatch) {
      // Check new assignment model
      const [assignment] = await db.select({ id: sponsorshipAssignmentsTable.id })
        .from(sponsorshipAssignmentsTable)
        .where(and(
          eq(sponsorshipAssignmentsTable.sponsorId, sponsor.id),
          eq(sponsorshipAssignmentsTable.tournamentId, resolvedTournamentId),
        ));
      if (!assignment) {
        res.status(400).json({ error: "sponsor not assigned to this tournament" });
        return;
      }
    }
  }

  // Validate ad-campaign attribution: when a campaignId/creativeId/slotKey is supplied
  // (or the source is an ad-campaign slot), require that they all reference the same
  // sponsor, organization, and slot. This prevents poisoned billing-grade metrics
  // submitted by a hostile client.
  let validatedSlotKey: string | null = typeof slotKey === "string" && slotKey ? slotKey : null;
  let validatedCampaignId: number | null = typeof campaignId === "number" && Number.isInteger(campaignId) ? campaignId : null;
  let validatedCreativeId: number | null = typeof creativeId === "number" && Number.isInteger(creativeId) ? creativeId : null;

  const isAdSource = AD_CAMPAIGN_SOURCES.has(source as string);
  if (isAdSource || validatedCampaignId !== null || validatedCreativeId !== null) {
    if (validatedCampaignId === null || validatedCreativeId === null || !validatedSlotKey) {
      res.status(400).json({ error: "ad events require slotKey, campaignId, and creativeId" });
      return;
    }
    const [row] = await db.select({
      campaignSponsorId: adCampaignsTable.sponsorId,
      campaignOrgId: adCampaignsTable.organizationId,
      campaignCreativeId: adCampaignsTable.creativeId,
      slotKeyDb: adSlotsTable.slotKey,
    })
      .from(adCampaignsTable)
      .innerJoin(adSlotsTable, eq(adCampaignsTable.slotId, adSlotsTable.id))
      .where(eq(adCampaignsTable.id, validatedCampaignId));
    if (!row
      || row.campaignSponsorId !== sponsor.id
      || row.campaignOrgId !== sponsor.organizationId
      || row.campaignCreativeId !== validatedCreativeId
      || row.slotKeyDb !== validatedSlotKey
      || row.slotKeyDb !== source
    ) {
      res.status(400).json({ error: "ad event attribution mismatch" });
      return;
    }
  }

  await db.insert(sponsorEventsTable).values({
    sponsorId: sponsor.id,
    organizationId: sponsor.organizationId,
    tournamentId: resolvedTournamentId,
    eventType: eventType as string,
    source: source as string,
    sessionId: (sessionId as string).trim(),
    slotKey: validatedSlotKey,
    campaignId: validatedCampaignId,
    creativeId: validatedCreativeId,
  });

  res.json({ ok: true });
});

// ── Public per-club branding (Task #1756) ────────────────────────────────────
//
// Returns just enough of the club's saved branding (logo, name, colours,
// favicon) for the pre-auth pages — login, register and forgot-password —
// to render the active club's mark instead of the default KHARAGOLF
// wordmark when the player arrived from a club-branded email or the
// club's vanity domain.
//
// No auth required — only public-facing brand assets are exposed
// (deliberately matching the fields already returned by the
// marketplace-by-slug endpoint above), and the existing
// `/api/organizations/:orgId/theming` endpoint is similarly public.
// Returns 200 with `branding: null` when no club matches the slug or
// the club hasn't customized its theme, so callers can fall back to
// the KHARAGOLF defaults without special-casing 404s.
// Internal helper so the by-slug and by-id routes always return the
// same shape and use identical precedence (theme row → legacy org
// columns), matching `resolveOrgBranding()` used by emails and portal
// nav. Returns the JSON body to send back; never throws.
async function buildPublicOrgBranding(
  org: { id: number; name: string; slug: string; logoUrl: string | null; primaryColor: string | null },
): Promise<{ branding: { organizationId: number; slug: string; name: string; logoUrl: string | null; faviconUrl: string | null; primaryColor: string | null } | null }> {
  const theme = await getClubTheme(org.id).catch(() => null);
  const customized = theme?.customized === true;
  const logoUrl = (customized ? theme?.logoUrl : null) ?? org.logoUrl ?? null;
  const faviconUrl = (customized ? theme?.faviconUrl : null) ?? null;
  const primaryColor = (customized ? theme?.primaryColor : null) ?? org.primaryColor ?? null;
  return {
    branding: {
      organizationId: org.id,
      slug: org.slug,
      name: org.name,
      logoUrl,
      faviconUrl,
      primaryColor,
    },
  };
}

router.get("/orgs/by-slug/:slug/branding", async (req: Request, res: Response) => {
  const slug = String((req.params as Record<string, string>).slug ?? "").trim().toLowerCase();
  if (!slug) { { res.json({ branding: null }); return; } }
  try {
    const [org] = await db
      .select({
        id: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, slug));
    if (!org) { { res.json({ branding: null }); return; } }
    res.json(await buildPublicOrgBranding(org));
  } catch {
    // Fall back silently to the default brand on any error so a flaky
    // DB never breaks the login screen.
    res.json({ branding: null });
  }
});

// Same shape as the by-slug branding endpoint, but keyed by org id —
// used by `/register/:orgId/:tournamentId` once the tournament has
// loaded so the brand mark switches in even when the URL has no slug.
// Critically, this also applies the legacy `organizations.logoUrl`
// fallback, so clubs that uploaded a logo before the customised
// `club_theming` row was introduced still render their mark on the
// register page.
router.get("/orgs/by-id/:orgId/branding", async (req: Request, res: Response) => {
  const orgId = Number((req.params as Record<string, string>).orgId);
  if (!Number.isFinite(orgId) || orgId <= 0) { { res.json({ branding: null }); return; } }
  try {
    const [org] = await db
      .select({
        id: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    if (!org) { { res.json({ branding: null }); return; } }
    res.json(await buildPublicOrgBranding(org));
  } catch {
    res.json({ branding: null });
  }
});

// ── Public Tee Time Marketplace ──────────────────────────────────────────────

// Marketplace entitlement gate — applied to all /orgs/by-slug/:slug/marketplace* routes.
// Checks that the org identified by slug has the marketplace feature enabled on their plan.
// Returns 402 featureGate if not enabled (fail-closed on DB errors).
async function checkMarketplaceEntitlement(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { slug } = (req.params as Record<string, string>);
  try {
    const [org] = await db
      .select({ id: organizationsTable.id, subscriptionTier: organizationsTable.subscriptionTier, subscriptionStatus: organizationsTable.subscriptionStatus })
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, slug));

    if (!org) { next(); return; } // Org not found — let the route handler return 404

    const tier = org.subscriptionTier as SubscriptionTier;
    const lapsed = tier !== "free" && (org.subscriptionStatus === "past_due" || org.subscriptionStatus === "cancelled");
    const effectiveTier: SubscriptionTier = lapsed ? "free" : tier;
    const { config } = await getEffectivePlanConfig(effectiveTier, org.id);

    if (!config.marketplace) {
      res.status(402).json({
        error: `Tee Time Marketplace is not available on this club's ${TIER_DISPLAY[effectiveTier].label} plan.`,
        featureGate: {
          type: "feature_gate",
          feature: "marketplace",
          currentTier: tier,
          requiredTier: "starter",
          message: `This club needs to upgrade to ${TIER_DISPLAY["starter"].label} to use the Tee Time Marketplace.`,
        },
      });
      return;
    }
  } catch {
    // Entitlement lookup failed — deny (fail-closed)
    res.status(402).json({
      error: "Unable to verify Tee Time Marketplace entitlement. Please try again later.",
      featureGate: { type: "feature_gate", feature: "marketplace" },
    });
    return;
  }
  next();
}
router.use("/orgs/by-slug/:slug/marketplace", checkMarketplaceEntitlement);

// GET /api/public/orgs/by-slug/:slug/marketplace — fetch org info + open slots (no auth)
router.get("/orgs/by-slug/:slug/marketplace", async (req: Request, res: Response) => {
  const { slug } = (req.params as Record<string, string>);
  const [org] = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor, slug: organizationsTable.slug })
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, slug));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const from = typeof req.query.from === "string" ? new Date(req.query.from) : new Date();
  const slots = await db
    .select({ slot: marketplaceSlotsTable, courseName: coursesTable.name })
    .from(marketplaceSlotsTable)
    .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
    .where(and(
      eq(marketplaceSlotsTable.organizationId, org.id),
      eq(marketplaceSlotsTable.status, "open"),
      gt(marketplaceSlotsTable.slotDate, from),
    ))
    .orderBy(asc(marketplaceSlotsTable.slotDate));

  res.json({
    organization: { id: org.id, name: org.name, logoUrl: org.logoUrl, primaryColor: org.primaryColor, slug: org.slug },
    slots: slots.map(r => ({
      id: r.slot.id,
      slotDate: r.slot.slotDate.toISOString(),
      startingHole: r.slot.startingHole,
      maxPlayers: r.slot.maxPlayers,
      bookedPlayers: r.slot.bookedPlayers,
      spotsLeft: r.slot.maxPlayers - r.slot.bookedPlayers,
      pricePaise: r.slot.pricePaise,
      priceDisplay: r.slot.pricePaise > 0 ? `₹${(r.slot.pricePaise / 100).toFixed(0)}` : "Free",
      notes: r.slot.notes,
      status: r.slot.status,
      courseName: r.courseName ?? null,
    })),
  });
});

// GET /api/public/orgs/by-slug/:slug/marketplace/stream — SSE live availability (no auth)
// Clients are registered in the SAME shared marketplace SSE map so they receive
// broadcastSlotUpdate() events triggered by bookings and cancellations.
router.get("/orgs/by-slug/:slug/marketplace/stream", async (req: Request, res: Response) => {
  const { slug } = (req.params as Record<string, string>);
  const [org] = await db
    .select({ id: organizationsTable.id })
    .from(organizationsTable)
    .where(eq(organizationsTable.slug, slug));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  // Register in the shared map so broadcastSlotUpdate() reaches public clients too
  addMarketplaceSSEClient(org.id, res);

  // Send full slot list on connect for immediate initial state
  const slots = await db
    .select({ slot: marketplaceSlotsTable, courseName: coursesTable.name })
    .from(marketplaceSlotsTable)
    .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
    .where(and(eq(marketplaceSlotsTable.organizationId, org.id), eq(marketplaceSlotsTable.status, "open")))
    .orderBy(asc(marketplaceSlotsTable.slotDate));

  res.write(`data: ${JSON.stringify({ type: "init", slots: slots.map(r => ({ id: r.slot.id, bookedPlayers: r.slot.bookedPlayers, spotsLeft: r.slot.maxPlayers - r.slot.bookedPlayers, status: r.slot.status })) })}\n\n`);

  const hb = setInterval(() => { try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); } }, 30000);
  req.on("close", () => {
    clearInterval(hb);
    removeMarketplaceSSEClient(org.id, res);
  });
});

// POST /api/public/orgs/by-slug/:slug/marketplace/:slotId/book — authenticated portal user books
// (delegates auth check + Razorpay to the scoped marketplace router via internal redirect)
// This is a convenience endpoint for the public page. It requires auth.
router.post("/orgs/by-slug/:slug/marketplace/:slotId/book", async (req: Request, res: Response) => {
  const { slug, slotId } = (req.params as Record<string, string>);
  const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.slug, slug));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number; displayName?: string; email?: string };

  const sid = parseInt(slotId);
  const [slot] = await db.select().from(marketplaceSlotsTable)
    .where(and(eq(marketplaceSlotsTable.id, sid), eq(marketplaceSlotsTable.organizationId, org.id)));
  if (!slot) { { res.status(404).json({ error: "Slot not found" }); return; } }
  if (slot.status !== "open") { { res.status(400).json({ error: `Slot is ${slot.status}` }); return; } }

  const { players, notes } = req.body as { players?: number; notes?: string };
  const numPlayers = Math.max(1, Math.min(players ?? 1, 4));
  if (slot.bookedPlayers + numPlayers > slot.maxPlayers) {
    res.status(400).json({ error: `Only ${slot.maxPlayers - slot.bookedPlayers} spots remaining` });
    return;
  }

  const totalPaise = slot.pricePaise * numPlayers;
  const isFree = totalPaise === 0;

  // For free bookings, atomically claim capacity before inserting the booking record.
  // This prevents double-bookings when multiple requests arrive simultaneously.
  if (isFree) {
    const claimed = await db.update(marketplaceSlotsTable)
      .set({ bookedPlayers: sql`${marketplaceSlotsTable.bookedPlayers} + ${numPlayers}` })
      .where(and(
        eq(marketplaceSlotsTable.id, sid),
        eq(marketplaceSlotsTable.status, "open"),
        sql`${marketplaceSlotsTable.bookedPlayers} + ${numPlayers} <= ${marketplaceSlotsTable.maxPlayers}`,
      ))
      .returning({ id: marketplaceSlotsTable.id });
    if (claimed.length === 0) {
      res.status(400).json({ error: "No spots remaining — the slot may have just filled up" });
      return;
    }
  }

  const [booking] = await db.insert(marketplaceBookingsTable).values({
    slotId: sid,
    organizationId: org.id,
    userId: user.id,
    playerName: user.displayName ?? "Guest",
    playerEmail: user.email,
    players: numPlayers,
    amountPaise: totalPaise,
    paymentStatus: isFree ? "confirmed" : "pending",
    notes: notes ?? null,
  }).returning();

  if (isFree) {
    const [updatedSlot] = await db.select({ slot: marketplaceSlotsTable, courseName: coursesTable.name })
      .from(marketplaceSlotsTable)
      .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
      .where(eq(marketplaceSlotsTable.id, sid));
    if (updatedSlot && updatedSlot.slot.bookedPlayers >= updatedSlot.slot.maxPlayers) {
      await db.update(marketplaceSlotsTable).set({ status: "full" }).where(eq(marketplaceSlotsTable.id, sid));
      updatedSlot.slot.status = "full";
    }
    if (updatedSlot) broadcastSlotUpdate(org.id, formatSlot(updatedSlot.slot, updatedSlot.courseName ?? undefined));

    const [orgRow] = await db.select({ name: organizationsTable.name, primaryColor: organizationsTable.primaryColor, logoUrl: organizationsTable.logoUrl })
      .from(organizationsTable).where(eq(organizationsTable.id, org.id));
    if (booking.playerEmail && orgRow) {
      sendMarketplaceBookingEmail({
        to: booking.playerEmail,
        name: booking.playerName,
        bookingId: booking.id,
        orgName: orgRow.name,
        slotDate: slot.slotDate,
        players: numPlayers,
        amountPaise: 0,
        branding: { primaryColor: orgRow.primaryColor ?? undefined, logoUrl: orgRow.logoUrl ?? undefined },
      }).catch(e => logger.warn({ e, bookingId: booking.id }, "[marketplace] Booking confirmation email failed"));
    }

    res.json({ booking: { ...booking, bookedAt: booking.bookedAt.toISOString() }, requiresPayment: false });
    return;
  }

  try {
    const { getRazorpayClient: rzpClient, getRazorpayKeyId: rzpKeyId } = await import("../lib/razorpay");
    const rzp = rzpClient();
    const keyId = rzpKeyId();
    const [orgRow] = await db.select({ name: organizationsTable.name }).from(organizationsTable).where(eq(organizationsTable.id, org.id));
    const order = await rzp.orders.create({
      amount: totalPaise,
      currency: "INR",
      receipt: `mkt-booking-${booking.id}`,
      notes: { bookingId: String(booking.id), slotId: String(sid), orgName: orgRow?.name ?? "" },
    });
    await db.update(marketplaceBookingsTable).set({ razorpayOrderId: order.id }).where(eq(marketplaceBookingsTable.id, booking.id));
    res.json({
      booking: { ...booking, razorpayOrderId: order.id, bookedAt: booking.bookedAt.toISOString() },
      requiresPayment: true,
      razorpayOrder: { orderId: order.id, amount: totalPaise, currency: "INR", keyId },
    });
  } catch (e) {
    await db.delete(marketplaceBookingsTable).where(eq(marketplaceBookingsTable.id, booking.id));
    res.status(500).json({ error: "Payment gateway error. Please try again." });
  }
});

// POST /api/public/orgs/by-slug/:slug/marketplace/:slotId/payment/verify
router.post("/orgs/by-slug/:slug/marketplace/:slotId/payment/verify", async (req: Request, res: Response) => {
  const { slug, slotId } = (req.params as Record<string, string>);
  const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.slug, slug));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number };

  const { bookingId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body as {
    bookingId: number; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string;
  };

  const [booking] = await db.select().from(marketplaceBookingsTable)
    .where(and(eq(marketplaceBookingsTable.id, bookingId), eq(marketplaceBookingsTable.slotId, parseInt(slotId)), eq(marketplaceBookingsTable.organizationId, org.id)));
  if (!booking) { { res.status(404).json({ error: "Booking not found" }); return; } }
  if (booking.userId !== user.id) { { res.status(403).json({ error: "You do not own this booking" }); return; } }
  if (!booking.razorpayOrderId || booking.razorpayOrderId !== razorpayOrderId) { { res.status(400).json({ error: "Order ID mismatch" }); return; } }
  if (booking.paymentStatus === "confirmed") { { res.json({ success: true, alreadyConfirmed: true }); return; } }
  if (booking.paymentStatus === "cancelled") { { res.status(400).json({ error: "Booking cancelled" }); return; } }

  const { createHmac } = await import("crypto");
  const secret = process.env.RAZORPAY_KEY_SECRET ?? "";
  const expected = createHmac("sha256", secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
  if (expected !== razorpaySignature) { { res.status(400).json({ error: "Invalid payment signature" }); return; } }

  // Atomically claim capacity at payment verification — prevents overbooking
  // if multiple payments are verified concurrently.
  const claimedAtVerify = await db.update(marketplaceSlotsTable)
    .set({ bookedPlayers: sql`${marketplaceSlotsTable.bookedPlayers} + ${booking.players}` })
    .where(and(
      eq(marketplaceSlotsTable.id, parseInt(slotId)),
      sql`${marketplaceSlotsTable.bookedPlayers} + ${booking.players} <= ${marketplaceSlotsTable.maxPlayers}`,
    ))
    .returning({ id: marketplaceSlotsTable.id });

  if (claimedAtVerify.length === 0) {
    // Slot is now over capacity — refund the payment automatically.
    try {
      const { getRazorpayClient: rzpClient2 } = await import("../lib/razorpay");
      await rzpClient2().payments.refund(razorpayPaymentId, { amount: booking.amountPaise, notes: { reason: "Slot full at payment verification" } });
    } catch (refundErr) {
      logger.error({ refundErr, bookingId }, "[marketplace/verify] Auto-refund failed for overbooked slot");
    }
    await db.update(marketplaceBookingsTable).set({ paymentStatus: "cancelled", cancelledAt: new Date() })
      .where(eq(marketplaceBookingsTable.id, bookingId));
    res.status(409).json({ error: "Slot is now full. Your payment will be refunded." });
    return;
  }

  await db.update(marketplaceBookingsTable).set({ paymentStatus: "confirmed", razorpayPaymentId })
    .where(eq(marketplaceBookingsTable.id, bookingId));

  const [updatedSlotRow] = await db.select({ slot: marketplaceSlotsTable, courseName: coursesTable.name })
    .from(marketplaceSlotsTable)
    .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
    .where(eq(marketplaceSlotsTable.id, parseInt(slotId)));
  if (updatedSlotRow && updatedSlotRow.slot.bookedPlayers >= updatedSlotRow.slot.maxPlayers) {
    await db.update(marketplaceSlotsTable).set({ status: "full" }).where(eq(marketplaceSlotsTable.id, parseInt(slotId)));
    updatedSlotRow.slot.status = "full";
  }
  if (updatedSlotRow) broadcastSlotUpdate(org.id, formatSlot(updatedSlotRow.slot, updatedSlotRow.courseName ?? undefined));

  const [orgRow] = await db.select({ name: organizationsTable.name, primaryColor: organizationsTable.primaryColor, logoUrl: organizationsTable.logoUrl })
    .from(organizationsTable).where(eq(organizationsTable.id, org.id));
  if (booking.playerEmail && orgRow && updatedSlotRow) {
    sendMarketplaceBookingEmail({
      to: booking.playerEmail,
      name: booking.playerName,
      bookingId: booking.id,
      orgName: orgRow.name,
      slotDate: updatedSlotRow.slot.slotDate,
      players: booking.players,
      amountPaise: booking.amountPaise,
      branding: { primaryColor: orgRow.primaryColor ?? undefined, logoUrl: orgRow.logoUrl ?? undefined },
    }).catch(e => logger.warn({ e, bookingId: booking.id }, "[marketplace] Booking confirmation email failed"));
  }

  res.json({ success: true });
});

// GET /api/public/qr?data=... — First-party server-side QR code generation (PNG)
// No external service used; booking IDs never leave the platform.
router.get("/qr", async (req: Request, res: Response) => {
  const { data, size = "220", color = "C9A84C", bg = "0b1512" } = req.query as Record<string, string>;
  if (!data) { { res.status(400).json({ error: "data query param required" }); return; } }
  if (data.length > 1024) { { res.status(400).json({ error: "data too long" }); return; } }
  const sz = Math.max(80, Math.min(500, parseInt(size) || 220));
  const toHex = (c: string) => (/^[0-9a-fA-F]{3,6}$/.test(c) ? `#${c}` : "#C9A84C");
  const png = await QRCode.toBuffer(data, {
    type: "png",
    width: sz,
    color: { dark: toHex(color), light: toHex(bg) },
    margin: 1,
  });
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(png);
});

// POST /api/public/orgs/by-slug/:slug/marketplace/bookings/:bookingId/cancel
// Players cancel their own bookings. Refund processed before cancellation.
// Cancellation window is configurable per-org (defaults to 24h).
router.post("/orgs/by-slug/:slug/marketplace/bookings/:bookingId/cancel", async (req: Request, res: Response) => {
  const { slug, bookingId: bookingIdStr } = (req.params as Record<string, string>);
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number };
  const bookingId = parseInt(bookingIdStr);

  const [org] = await db.select({ id: organizationsTable.id, cancelWindowHours: organizationsTable.marketplaceCancelWindowHours })
    .from(organizationsTable).where(eq(organizationsTable.slug, slug));
  if (!org) { { res.status(404).json({ error: "Organization not found" }); return; } }

  const [bookingRow] = await db.select({ booking: marketplaceBookingsTable, slotDate: marketplaceSlotsTable.slotDate })
    .from(marketplaceBookingsTable)
    .innerJoin(marketplaceSlotsTable, eq(marketplaceSlotsTable.id, marketplaceBookingsTable.slotId))
    .where(and(eq(marketplaceBookingsTable.id, bookingId), eq(marketplaceBookingsTable.organizationId, org.id)));
  if (!bookingRow) { { res.status(404).json({ error: "Booking not found" }); return; } }
  const { booking } = bookingRow;
  if (booking.userId !== user.id) { { res.status(403).json({ error: "You can only cancel your own bookings" }); return; } }
  if (booking.cancelledAt) { { res.status(400).json({ error: "Booking already cancelled" }); return; } }
  if (booking.paymentStatus === "pending") { { res.status(400).json({ error: "Cannot cancel an unpaid booking. Please complete or abandon the payment." }); return; } }

  const cancelWindowHours = org.cancelWindowHours ?? 24;
  if (cancelWindowHours === 0) {
    res.status(400).json({ error: "Player self-cancellation is not allowed for this club. Please contact the club directly." });
    return;
  }
  const hoursToSlot = bookingRow.slotDate ? (bookingRow.slotDate.getTime() - Date.now()) / 3_600_000 : Infinity;
  if (hoursToSlot < cancelWindowHours) {
    res.status(400).json({ error: `Cancellation is not allowed within ${cancelWindowHours} hour${cancelWindowHours !== 1 ? "s" : ""} of the tee time.` });
    return;
  }

  let refundId: string | null = null;
  if (booking.paymentStatus === "confirmed" && booking.razorpayPaymentId && booking.amountPaise > 0) {
    try {
      const { getRazorpayClient } = await import("../lib/razorpay");
      const rzp = getRazorpayClient();
      const refund = await rzp.payments.refund(booking.razorpayPaymentId, {
        amount: booking.amountPaise,
        notes: { reason: "Booking cancelled by player", bookingId: String(bookingId) },
      });
      refundId = refund.id as string;
      logger.info({ bookingId, refundId }, "[marketplace/public] Refund issued on cancel");
    } catch (e) {
      logger.error({ e, bookingId }, "[marketplace/public] Razorpay refund failed — cancellation aborted");
      res.status(500).json({ error: "Refund could not be processed. Please contact the club to cancel." });
      return;
    }
  }

  await db.update(marketplaceBookingsTable)
    .set({ cancelledAt: new Date(), paymentStatus: "cancelled" })
    .where(eq(marketplaceBookingsTable.id, bookingId));

  if (booking.paymentStatus === "confirmed") {
    await db.update(marketplaceSlotsTable)
      .set({ bookedPlayers: sql`GREATEST(0, ${marketplaceSlotsTable.bookedPlayers} - ${booking.players})`, status: "open" })
      .where(eq(marketplaceSlotsTable.id, booking.slotId));
    const [updatedSlot] = await db.select({ slot: marketplaceSlotsTable, courseName: coursesTable.name })
      .from(marketplaceSlotsTable)
      .leftJoin(coursesTable, eq(marketplaceSlotsTable.courseId, coursesTable.id))
      .where(eq(marketplaceSlotsTable.id, booking.slotId));
    if (updatedSlot) broadcastSlotUpdate(org.id, formatSlot(updatedSlot.slot, updatedSlot.courseName ?? undefined));
  }

  res.json({ success: true, refundId });
});

// ─── PUBLIC HONOURS BOARD ──────────────────────────────────────────────────────
// GET /public/orgs/:orgId/honours-board
// Returns all published club championships with winners, no auth required
router.get("/orgs/:orgId/honours-board", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));

  const [org] = await db
    .select({ id: organizationsTable.id, name: organizationsTable.name, logoUrl: organizationsTable.logoUrl, primaryColor: organizationsTable.primaryColor })
    .from(organizationsTable)
    .where(eq(organizationsTable.id, orgId));

  if (!org) {
    res.status(404).json({ error: "Organisation not found" });
    return;
  }

  const championships = await db
    .select({
      id: clubChampionshipTable.id,
      year: clubChampionshipTable.year,
      title: clubChampionshipTable.title,
      notes: clubChampionshipTable.notes,
      tournamentId: clubChampionshipTable.tournamentId,
      tournamentName: tournamentsTable.name,
    })
    .from(clubChampionshipTable)
    .leftJoin(tournamentsTable, eq(tournamentsTable.id, clubChampionshipTable.tournamentId))
    .where(and(
      eq(clubChampionshipTable.organizationId, orgId),
      eq(clubChampionshipTable.isPublished, true),
    ))
    .orderBy(desc(clubChampionshipTable.year));

  const result = await Promise.all(championships.map(async (ch) => {
    const flights = await db
      .select({
        id: championshipFlightTable.id,
        name: championshipFlightTable.name,
        scoreType: championshipFlightTable.scoreType,
        displayOrder: championshipFlightTable.displayOrder,
      })
      .from(championshipFlightTable)
      .where(eq(championshipFlightTable.championshipId, ch.id))
      .orderBy(asc(championshipFlightTable.displayOrder));

    const winners = await db
      .select({
        id: championshipWinnerTable.id,
        flightId: championshipWinnerTable.flightId,
        playerName: championshipWinnerTable.playerName,
        score: championshipWinnerTable.score,
        notes: championshipWinnerTable.notes,
        position: championshipWinnerTable.position,
      })
      .from(championshipWinnerTable)
      .where(eq(championshipWinnerTable.championshipId, ch.id))
      .orderBy(asc(championshipWinnerTable.position));

    return { ...ch, flights, winners };
  }));

  res.json({ org, championships: result });
});

// ─── Tournament-scoped GHIN Player Lookup (public registration flow) ──────────
// GET /api/public/orgs/:orgId/tournaments/:tournamentId/ghin/player/:ghinNumber
//
// No session auth required, but the request MUST reference a real tournament that:
//   (a) belongs to the org, and
//   (b) is currently open for registration (not completed or cancelled).
//
// This ties GHIN credential usage to an active registration context and prevents
// unauthenticated scraping of arbitrary org-scoped GHIN credentials.

router.get("/orgs/:orgId/tournaments/:tournamentId/ghin/player/:ghinNumber", async (req: Request, res: Response) => {
  const orgId = parseInt(String((req.params as Record<string, string>).orgId));
  const tournamentId = parseInt(String((req.params as Record<string, string>).tournamentId));
  const { ghinNumber } = (req.params as Record<string, string>);

  if (!ghinNumber) { { res.status(400).json({ error: "ghinNumber is required" }); return; } }

  // Guard: validate the tournament belongs to this org and is open for registration.
  const [tournament] = await db
    .select({ id: tournamentsTable.id, status: tournamentsTable.status })
    .from(tournamentsTable)
    .where(and(eq(tournamentsTable.id, tournamentId), eq(tournamentsTable.organizationId, orgId)));

  if (!tournament) {
    res.status(404).json({ error: "Tournament not found" });
    return;
  }
  if (tournament.status === "completed" || tournament.status === "cancelled") {
    res.status(400).json({ error: "Registration is closed for this tournament" });
    return;
  }

  const [row] = await db
    .select({ apiKey: orgGhinCredentialsTable.ghinApiKey, username: orgGhinCredentialsTable.ghinApiUsername, password: orgGhinCredentialsTable.ghinApiPassword })
    .from(orgGhinCredentialsTable)
    .where(eq(orgGhinCredentialsTable.organizationId, orgId));

  const orgCreds = row ? resolveGhinCredentials({ apiKey: row.apiKey, username: row.username, password: row.password }) : null;
  const result = await lookupGolferByGhinNumber(ghinNumber, orgCreds);

  if (!result.success) {
    const status = result.code === "NO_CREDENTIALS" ? 503 : result.code === "NOT_FOUND" ? 404 : 502;
    res.status(status).json({ error: result.error, code: result.code });
    return;
  }
  res.json(result.golfer);
});

// POST /api/public/demo-request
// Public: no auth required — demo/contact form from marketing website
router.post("/demo-request", async (req: Request, res: Response) => {
  const { name, email, clubName, phone, message, interest, preferredDemoTime } = req.body as {
    name?: string;
    email?: string;
    clubName?: string;
    phone?: string;
    message?: string;
    interest?: string;
    preferredDemoTime?: string;
  };

  if (!name || !email) {
    res.status(400).json({ error: "Name and email are required" });
    return;
  }

  const GMAIL_USER = process.env.GMAIL_USER ?? "";
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD ?? "";
  const TO = GMAIL_USER || "noreply@kharagolf.com";

  // Sanitize values before embedding in HTML to prevent XSS
  const esc = (v: string | undefined) =>
    (v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const safeName = esc(name);
  const safeEmail = esc(email);
  const safeClub = esc(clubName);
  const safePhone = esc(phone);
  const safeInterest = esc(interest);
  const safeDemoTime = esc(preferredDemoTime);
  const safeMessage = esc(message);

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#1e4d2b;padding:28px 32px;">
        <h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:3px;font-weight:900;"><span style="color:#fff;">KHARA</span><span style="color:#C9A84C;">GOLF</span></h1>
        <p style="color:#C9A84C;margin:6px 0 0;font-size:11px;letter-spacing:3px;text-transform:uppercase;">New Demo Request</p>
      </div>
      <div style="padding:32px;background:#f9fafb;border:1px solid #e5e7eb;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:120px;">Name</td><td style="padding:8px 0;font-weight:600;">${safeName}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Email</td><td style="padding:8px 0;">${safeEmail}</td></tr>
          ${safeClub ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Club / Org</td><td style="padding:8px 0;">${safeClub}</td></tr>` : ""}
          ${safePhone ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Phone</td><td style="padding:8px 0;">${safePhone}</td></tr>` : ""}
          ${safeInterest ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Interest</td><td style="padding:8px 0;">${safeInterest}</td></tr>` : ""}
          ${safeDemoTime ? `<tr><td style="padding:8px 0;color:#6b7280;font-size:13px;">Demo Time</td><td style="padding:8px 0;">${safeDemoTime}</td></tr>` : ""}
        </table>
        ${safeMessage ? `<div style="margin-top:20px;padding:16px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;"><p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${safeMessage}</p></div>` : ""}
      </div>
      <div style="padding:16px 32px;background:#f3f4f6;text-align:center;">
        <p style="margin:0;font-size:12px;color:#9ca3af;">KHARAGOLF — Golf Tournament SaaS</p>
      </div>
    </div>
  `;

  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
      });
      await transporter.sendMail({
        from: `"KHARAGOLF Website" <${GMAIL_USER}>`,
        to: TO,
        replyTo: email,
        subject: `Demo Request: ${name}${clubName ? ` — ${clubName}` : ""}`,
        html,
      });
    } catch (err) {
      logger.warn({ err }, "[DEMO-REQUEST] Email send failed");
    }
  }

  res.json({ ok: true });
});

// ── COURSE HOLE GPS DATA ─────────────────────────────────────────────
// GET /api/public/courses/:courseId/holes-gps
router.get("/courses/:courseId/holes-gps", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (isNaN(courseId)) { { res.status(400).json({ error: "Invalid courseId" }); return; } }
  const holes = await db.select({
    holeNumber: holeDetailsTable.holeNumber,
    par: holeDetailsTable.par,
    yardageWhite: holeDetailsTable.yardageWhite,
    greenCentreLat: holeDetailsTable.greenCentreLat,
    greenCentreLng: holeDetailsTable.greenCentreLng,
    greenFrontLat: holeDetailsTable.greenFrontLat,
    greenFrontLng: holeDetailsTable.greenFrontLng,
    greenBackLat: holeDetailsTable.greenBackLat,
    greenBackLng: holeDetailsTable.greenBackLng,
  }).from(holeDetailsTable)
    .where(eq(holeDetailsTable.courseId, courseId))
    .orderBy(asc(holeDetailsTable.holeNumber));
  res.json(holes);
});

// GET /api/public/courses/:courseId/holes-hazards
// Returns all hazard overlays (water, bunkers, OB, tree lines) for a course.
// Used by Course Map panel to show hazard markers on satellite imagery.
router.get("/courses/:courseId/holes-hazards", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (isNaN(courseId)) { { res.status(400).json({ error: "Invalid courseId" }); return; } }
  const hazards = await db.select({
    holeNumber: holeHazardsTable.holeNumber,
    hazardType: holeHazardsTable.hazardType,
    lat: holeHazardsTable.lat,
    lng: holeHazardsTable.lng,
    radiusMeters: holeHazardsTable.radiusMeters,
    name: holeHazardsTable.name,
  }).from(holeHazardsTable)
    .where(eq(holeHazardsTable.courseId, courseId))
    .orderBy(asc(holeHazardsTable.holeNumber));
  res.json(hazards);
});

// GET /api/public/courses/:courseId/holes-fairways
// Returns fairway polygons / centrelines per hole, sourced from the unified
// course_hole_geometry table (Wave 0 / Task #935). Used by the Course Map
// shot-marker drag to snap dropped shots onto the fairway and pre-fill
// lieType="Fairway" (Task #999, extending Task #858's green/hazard snap).
router.get("/courses/:courseId/holes-fairways", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  if (isNaN(courseId)) { { res.status(400).json({ error: "Invalid courseId" }); return; } }
  const rows = await db.select({
    holeNumber: courseHoleGeometryTable.holeNumber,
    geometry: courseHoleGeometryTable.geometry,
    label: courseHoleGeometryTable.label,
  }).from(courseHoleGeometryTable)
    .where(and(
      eq(courseHoleGeometryTable.courseId, courseId),
      eq(courseHoleGeometryTable.featureType, "fairway"),
    ))
    .orderBy(asc(courseHoleGeometryTable.holeNumber));
  res.json(rows);
});

// ── GREEN CONTOUR (Task #358) ──────────────────────────────────────
// GET /api/public/courses/:courseId/holes/:holeNumber/contour
// Public read endpoint used by the mobile 3D green renderer.
// Returns 404 if no contour data is available so the client can degrade to 2D.
router.get("/courses/:courseId/holes/:holeNumber/contour", async (req: Request, res: Response) => {
  const courseId = parseInt(String((req.params as Record<string, string>).courseId));
  const holeNumber = parseInt(String((req.params as Record<string, string>).holeNumber));
  if (isNaN(courseId) || isNaN(holeNumber)) { { res.status(400).json({ error: "Invalid params" }); return; } }
  const [contour] = await db.select().from(holeGreenContoursTable).where(
    and(eq(holeGreenContoursTable.courseId, courseId), eq(holeGreenContoursTable.holeNumber, holeNumber)),
  );
  if (!contour) { { res.status(404).json({ error: "no_contour" }); return; } }
  res.json(contour);
});

// ── PLAYS-LIKE DISTANCE (Task #358) ────────────────────────────────
// GET /api/public/playslike?lat=&lng=&targetLat=&targetLng=&rawYards=
// Optional: temperatureC, windSpeedKmh, windDirDeg, elevDiffMeters, altitudeMeters
// If weather/elevation params are absent and lat/lng are supplied, the server
// fetches them server-side via getWeather + Open-Meteo elevation.
router.get("/playslike", async (req: Request, res: Response) => {
  const lat = req.query.lat ? parseFloat(String(req.query.lat)) : null;
  const lng = req.query.lng ? parseFloat(String(req.query.lng)) : null;
  const targetLat = req.query.targetLat ? parseFloat(String(req.query.targetLat)) : null;
  const targetLng = req.query.targetLng ? parseFloat(String(req.query.targetLng)) : null;
  const rawYards = req.query.rawYards ? parseFloat(String(req.query.rawYards)) : NaN;
  if (!isFinite(rawYards) || rawYards <= 0) { { res.status(400).json({ error: "rawYards required" }); return; } }

  let temperatureC = req.query.temperatureC ? parseFloat(String(req.query.temperatureC)) : null;
  let windSpeedKmh = req.query.windSpeedKmh ? parseFloat(String(req.query.windSpeedKmh)) : null;
  let windDirDeg = req.query.windDirDeg ? parseFloat(String(req.query.windDirDeg)) : null;
  let elevDiffMeters = req.query.elevDiffMeters ? parseFloat(String(req.query.elevDiffMeters)) : null;
  let altitudeMeters = req.query.altitudeMeters ? parseFloat(String(req.query.altitudeMeters)) : null;

  // Auto-fill weather if missing & we have a location
  if (lat != null && lng != null && (temperatureC == null || windSpeedKmh == null || windDirDeg == null)) {
    try {
      const w = await getWeather(lat, lng);
      if (temperatureC == null) temperatureC = w.temperature;
      if (windSpeedKmh == null) windSpeedKmh = w.windSpeed;
      if (windDirDeg == null) windDirDeg = w.windDirection;
    } catch { /* graceful degrade */ }
  }

  // Auto-fill elevation diff + altitude if missing
  if (lat != null && lng != null && targetLat != null && targetLng != null && (elevDiffMeters == null || altitudeMeters == null)) {
    const els = await fetchElevations([{ lat, lng }, { lat: targetLat, lng: targetLng }]);
    if (els && els.length === 2) {
      if (elevDiffMeters == null) elevDiffMeters = els[1] - els[0];
      if (altitudeMeters == null) altitudeMeters = els[0];
    }
  }

  const bearing = (lat != null && lng != null && targetLat != null && targetLng != null)
    ? bearingDeg(lat, lng, targetLat, targetLng) : null;

  const breakdown = computePlaysLike({
    rawYards,
    bearingDeg: bearing,
    windSpeedKmh, windDirDeg,
    elevDiffMeters, temperatureC, altitudeMeters,
  });
  res.json(breakdown);
});

// ── MAP CONFIG ──────────────────────────────────────────────────────
// GET /api/public/map-config
// Returns Mapbox public access token (token is scoped for static image URLs only).
// It is safe to expose in the browser — restrict via URL referrer in Mapbox dashboard.
router.get("/map-config", (_req: Request, res: Response) => {
  const token = process.env.MAPBOX_ACCESS_TOKEN ?? null;
  res.json({ token });
});

// ── TASK #378: ODDS & PREDICTIONS (read-only, entertainment-only) ───
// Geo / club-policy gating: respects per-tournament `oddsWidgetsEnabled`
// and `predictionsEnabled` flags. Optional Cloudflare-style country header
// (`cf-ipcountry`) can be used by infra to short-circuit; we additionally
// honour an env-driven blocklist.
const ODDS_GEO_BLOCKLIST = (process.env.ODDS_GEO_BLOCKLIST ?? "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

function isOddsBlockedForRequest(req: Request): boolean {
  const country = String(req.headers["cf-ipcountry"] ?? req.headers["x-country-code"] ?? "").toUpperCase();
  if (country && ODDS_GEO_BLOCKLIST.includes(country)) return true;
  return false;
}

router.get("/tournaments/:tournamentId/odds", async (req: Request, res: Response) => {
  const tournamentId = Number((req.params as Record<string, string>).tournamentId);
  if (!Number.isFinite(tournamentId)) { res.status(400).json({ error: "invalid_tournament_id" }); return; }

  const [t] = await db
    .select({
      id: tournamentsTable.id,
      oddsWidgetsEnabled: tournamentsTable.oddsWidgetsEnabled,
      allowSpectators: tournamentsTable.allowSpectators,
      status: tournamentsTable.status,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!t) { res.status(404).json({ error: "not_found" }); return; }

  if (!t.allowSpectators || !t.oddsWidgetsEnabled || isOddsBlockedForRequest(req)) {
    res.status(403).json({
      error: "odds_disabled",
      reason: "Live insight widgets are disabled for this event or your region.",
    }); return;
  }

  const { buildOddsPayload } = await import("../lib/odds");
  const payload = await buildOddsPayload(tournamentId);
  if (!payload) { res.status(404).json({ error: "no_data" }); return; }
  res.json(payload);
});

// SSE: GET /api/public/tournaments/:tournamentId/odds/stream
// Task #454 — pushes the same payload as buildOddsPayload whenever the
// leaderboard updates. Replaces the 30s polling on web/mobile widgets.
router.get("/tournaments/:tournamentId/odds/stream", async (req: Request, res: Response) => {
  const tournamentId = Number((req.params as Record<string, string>).tournamentId);
  if (!Number.isFinite(tournamentId)) { res.status(400).json({ error: "invalid_tournament_id" }); return; }

  const [t] = await db
    .select({
      id: tournamentsTable.id,
      oddsWidgetsEnabled: tournamentsTable.oddsWidgetsEnabled,
      allowSpectators: tournamentsTable.allowSpectators,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!t) { res.status(404).json({ error: "not_found" }); return; }
  if (!t.allowSpectators || !t.oddsWidgetsEnabled || isOddsBlockedForRequest(req)) {
    res.status(403).json({ error: "odds_disabled" }); return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });

  // Send the current snapshot immediately so the widget renders on connect.
  try {
    const { buildOddsPayload } = await import("../lib/odds");
    const initial = await buildOddsPayload(tournamentId);
    if (initial) {
      res.write(`data: ${JSON.stringify({ type: "odds_update", data: initial })}\n\n`);
    }
  } catch {
    /* ignore — keep stream open even if initial snapshot fails */
  }

  addOddsClient(tournamentId, res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);

  req.on("close", () => {
    clearInterval(heartbeat);
    removeOddsClient(tournamentId, res);
  });
});

router.get("/tournaments/:tournamentId/predictions/leaderboard", async (req: Request, res: Response) => {
  const tournamentId = Number((req.params as Record<string, string>).tournamentId);
  if (!Number.isFinite(tournamentId)) { res.status(400).json({ error: "invalid_tournament_id" }); return; }

  const [t] = await db
    .select({
      id: tournamentsTable.id,
      predictionsEnabled: tournamentsTable.predictionsEnabled,
      allowSpectators: tournamentsTable.allowSpectators,
    })
    .from(tournamentsTable)
    .where(eq(tournamentsTable.id, tournamentId));
  if (!t) { res.status(404).json({ error: "not_found" }); return; }
  if (!t.allowSpectators || !t.predictionsEnabled) {
    res.status(403).json({ error: "predictions_disabled" }); return;
  }

  const { tournamentPredictionsTable } = await import("@workspace/db");
  const rows = await db
    .select({
      id: tournamentPredictionsTable.id,
      displayName: tournamentPredictionsTable.displayName,
      score: tournamentPredictionsTable.score,
      submittedAt: tournamentPredictionsTable.submittedAt,
    })
    .from(tournamentPredictionsTable)
    .where(eq(tournamentPredictionsTable.tournamentId, tournamentId));

  const sorted = rows
    .map(r => ({
      id: r.id,
      displayName: r.displayName ?? "Anonymous",
      score: r.score ?? null,
      submittedAt: r.submittedAt,
    }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    .slice(0, 50);

  res.json({
    tournamentId,
    entries: sorted,
    totalEntries: rows.length,
    disclosure:
      "Predictions are a free-to-play game for fans. No entry fee, no prizes of monetary value, and no wagering.",
  });
});

router.post("/tournaments/:tournamentId/odds/telemetry", async (req: Request, res: Response) => {
  const tournamentId = Number((req.params as Record<string, string>).tournamentId);
  if (!Number.isFinite(tournamentId)) { res.status(400).json({ error: "invalid_tournament_id" }); return; }

  const { eventType, widget, surface } = req.body ?? {};
  const allowedEvents = new Set(["impression", "click", "predict_submit"]);
  const allowedWidgets = new Set(["win_probability", "expected_score", "biggest_swings", "predictions"]);
  if (!allowedEvents.has(eventType) || !allowedWidgets.has(widget)) {
    res.status(400).json({ error: "invalid_payload" }); return;
  }

  const userId = (req.user as { id?: number } | undefined)?.id ?? null;
  const { oddsTelemetryTable } = await import("@workspace/db");
  await db.insert(oddsTelemetryTable).values({
    tournamentId,
    userId,
    eventType: String(eventType),
    widget: String(widget),
    surface: surface ? String(surface) : null,
  });
  res.json({ ok: true });
});

// ── PUBLIC PLAYER PROFILES (Task #383) ──────────────────────────────
// Shared helper: best public display name for a profile
function profileDisplayName(u: { displayName: string | null; username: string; publicHandle: string | null }): string {
  return u.displayName?.trim() || u.username || u.publicHandle || "Golfer";
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" }[c]!));
}

function publicSiteBase(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "kharagolf.com";
  return `${proto}://${host}`;
}

// GET /api/public/users/:userId/handle — userId → publicHandle resolver (Task #1457)
//
// Mobile screens (leaderboards, league member tabs, the existing
// app/member/[userId].tsx stub, etc.) only know the integer appUsersTable.id
// for a player. To send them on to the public profile viewer at
// app/profile/[handle].tsx (Task #1243) — and ultimately mirror to
// kharagolf.com/p/<handle> — we need to ask the server whether that user
// has reserved a public handle and opted in to publishing it.
//
// Returns:
//   { handle: string | null }
//
// `null` means "no public handle reserved" or "publicProfileEnabled=false".
// The caller should fall back to the existing private member view in that
// case rather than 404'ing the user. We deliberately do not return any
// other profile fields here — full data is served by GET /api/public/p/:handle.
router.get("/users/:userId/handle", async (req: Request, res: Response) => {
  const raw = (req.params as Record<string, string>).userId ?? "";
  // Strict integer-only — reject inputs like "123abc" that parseInt would
  // silently coerce to 123 and resolve someone else's handle.
  if (!/^\d+$/.test(raw)) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }
  const userId = parseInt(raw, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }
  const [u] = await db
    .select({
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.id, userId));
  if (!u || !u.publicProfileEnabled || !u.publicHandle) {
    res.json({ handle: null });
    return;
  }
  res.json({ handle: u.publicHandle });
});

// POST /api/public/users/handles — batch userId → publicHandle resolver (Task #2234)
//
// The singular GET /api/public/users/:userId/handle resolver above is fine
// for ad-hoc lookups, but a fresh leaderboard or a leagues members tab
// renders ~50 rows where every visible row is a "first tap" target. Pre-
// warming the React Query cache one row at a time would mean ~50 parallel
// HTTP round-trips (the screen mounts before any tap can land), so we
// expose a small batch variant that resolves them all in a single query.
//
// Request body:  { userIds: number[] }   (caller-supplied, deduped server-side)
// Response:      { handles: { [userId: string]: string | null } }
//
// Same `null` semantics as the singular endpoint: a userId resolves to
// `null` when the user does not exist, has no reserved handle, or has
// `publicProfileEnabled === false`. We cap the request at 200 ids so a
// runaway caller cannot scan the table; that's well above the largest
// realistic viewport (a paginated leaderboard or members tab tops out
// well below 100 visible rows on a phone).
router.post("/users/handles", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { userIds?: unknown };
  const raw = body.userIds;
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: "userIds must be an array of positive integers" });
    return;
  }
  if (raw.length === 0) {
    res.json({ handles: {} });
    return;
  }
  if (raw.length > 200) {
    res.status(400).json({ error: "Too many userIds (max 200)" });
    return;
  }
  // Coerce + validate strictly: anything that isn't a positive finite
  // integer is dropped silently rather than failing the whole batch, so
  // a single bad row in a leaderboard payload doesn't stall pre-warming
  // for everyone else on screen.
  const ids = new Set<number>();
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v) || v <= 0) continue;
    ids.add(v);
  }
  if (ids.size === 0) {
    res.json({ handles: {} });
    return;
  }
  const idArr = Array.from(ids);
  const rows = await db
    .select({
      id: appUsersTable.id,
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
    })
    .from(appUsersTable)
    .where(inArray(appUsersTable.id, idArr));
  const byId = new Map<number, { publicHandle: string | null; publicProfileEnabled: boolean | null }>();
  for (const r of rows) {
    byId.set(r.id, { publicHandle: r.publicHandle, publicProfileEnabled: r.publicProfileEnabled });
  }
  // Always return an entry for every requested id (even unknowns) so the
  // client can write `null` into its cache and avoid re-asking on the
  // next mount — that's the whole reason the resolver exists.
  const handles: Record<string, string | null> = {};
  for (const id of idArr) {
    const u = byId.get(id);
    if (u && u.publicProfileEnabled && u.publicHandle) {
      handles[String(id)] = u.publicHandle;
    } else {
      handles[String(id)] = null;
    }
  }
  res.json({ handles });
});

// GET /api/public/p/:handle — JSON for the public profile page
router.get("/p/:handle", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  if (!handle) { { res.status(400).json({ error: "Missing handle" }); return; } }

  const [user] = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      publicHandle: appUsersTable.publicHandle,
      profileImage: appUsersTable.profileImage,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicShowHandicap: appUsersTable.publicShowHandicap,
      publicShowRecentRounds: appUsersTable.publicShowRecentRounds,
      publicShowAchievements: appUsersTable.publicShowAchievements,
      publicShowFavoriteCourses: appUsersTable.publicShowFavoriteCourses,
      publicBio: appUsersTable.publicBio,
      publicLocation: appUsersTable.publicLocation,
      organizationId: appUsersTable.organizationId,
      createdAt: appUsersTable.createdAt,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));

  if (!user || !user.publicProfileEnabled) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  let homeClub: { name: string; slug: string } | null = null;
  if (user.organizationId) {
    const [org] = await db
      .select({ name: organizationsTable.name, slug: organizationsTable.slug })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, user.organizationId));
    if (org) homeClub = { name: org.name, slug: org.slug };
  }

  // Recent rounds (only non-hidden public scorecards) — last 5
  let recentRounds: Array<{
    shareToken: string;
    tournamentName: string;
    courseName: string | null;
    startDate: string | null;
    gross: number;
    toPar: number | null;
  }> = [];
  if (user.publicShowRecentRounds) {
    const rows = await db
      .select({
        playerId: playersTable.id,
        shareToken: playersTable.shareToken,
        tournamentId: playersTable.tournamentId,
        tournamentName: tournamentsTable.name,
        courseId: tournamentsTable.courseId,
        startDate: tournamentsTable.startDate,
      })
      .from(playersTable)
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .where(and(
        eq(playersTable.userId, user.id),
        eq(playersTable.publicHidden, false),
      ))
      .orderBy(desc(tournamentsTable.startDate))
      .limit(5);

    for (const r of rows) {
      if (!r.shareToken) continue;
      const playerScores = await db.select().from(scoresTable).where(eq(scoresTable.playerId, r.playerId));
      if (playerScores.length === 0) continue;
      const gross = playerScores.reduce((a, s) => a + s.strokes, 0);
      let toPar: number | null = null;
      let courseName: string | null = null;
      if (r.courseId) {
        const [course] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, r.courseId));
        courseName = course?.name ?? null;
        const holes = await db.select({ holeNumber: holeDetailsTable.holeNumber, par: holeDetailsTable.par }).from(holeDetailsTable).where(eq(holeDetailsTable.courseId, r.courseId));
        const parMap = new Map(holes.map(h => [h.holeNumber, h.par]));
        const par = playerScores.reduce((a, s) => a + (parMap.get(s.holeNumber) ?? 4), 0);
        toPar = gross - par;
      }
      recentRounds.push({
        shareToken: r.shareToken,
        tournamentName: r.tournamentName,
        courseName,
        startDate: r.startDate ? new Date(r.startDate).toISOString() : null,
        gross,
        toPar,
      });
    }
  }

  // Handicap journey (last ~25 entries)
  let handicapJourney: Array<{ recordedAt: string; handicapIndex: number }> = [];
  let currentHandicap: number | null = null;
  if (user.publicShowHandicap) {
    const rows = await db
      .select({ recordedAt: handicapHistoryTable.recordedAt, handicapIndex: handicapHistoryTable.handicapIndex })
      .from(handicapHistoryTable)
      .where(eq(handicapHistoryTable.userId, user.id))
      .orderBy(desc(handicapHistoryTable.recordedAt))
      .limit(25);
    handicapJourney = rows.reverse().map(r => ({
      recordedAt: new Date(r.recordedAt).toISOString(),
      handicapIndex: Number(r.handicapIndex),
    }));
    if (handicapJourney.length) currentHandicap = handicapJourney[handicapJourney.length - 1]!.handicapIndex;
  }

  // Achievements — earned badges with metadata (icon/label/category/earnedAt
  // come straight from the achievements table; description is sourced from
  // the BADGE_MAP catalog so the public profile can show what the badge means).
  let achievements: Array<{
    badgeType: string;
    badgeLabel: string;
    badgeIcon: string;
    badgeCategory: string;
    badgeDescription: string | null;
    earnedAt: string;
    metadata: Record<string, unknown> | null;
  }> = [];
  // Task #1752 — translate badge label/description into the viewer's locale
  // so both the achievement list AND the static catalog returned alongside it
  // render in the player's selected language. The mobile share button and the
  // public-badge web page both append `?lang=<viewer>` so the destination
  // matches the share message; falls back to Accept-Language otherwise.
  const badgeLang = resolveBadgeI18nLangFromReq(req);
  if (user.publicShowAchievements) {
    const rows = await db
      .select({
        badgeType: achievementsTable.badgeType,
        badgeLabel: achievementsTable.badgeLabel,
        badgeIcon: achievementsTable.badgeIcon,
        badgeCategory: achievementsTable.badgeCategory,
        earnedAt: achievementsTable.earnedAt,
        metadata: achievementsTable.metadata,
      })
      .from(achievementsTable)
      .where(eq(achievementsTable.userId, user.id))
      .orderBy(desc(achievementsTable.earnedAt))
      .limit(20);
    achievements = rows.map(r => {
      const def = getBadgeDef(r.badgeType);
      const localized = def ? localizeBadge(def, badgeLang) : null;
      return {
        badgeType: r.badgeType,
        // The achievements table snapshot stored an English label at award
        // time; prefer the live translation so renaming/translation changes
        // propagate to viewers.
        badgeLabel: localized?.label ?? r.badgeLabel,
        badgeIcon: r.badgeIcon,
        badgeCategory: r.badgeCategory,
        badgeDescription: localized?.description ?? def?.description ?? null,
        earnedAt: new Date(r.earnedAt).toISOString(),
        metadata: r.metadata ?? null,
      };
    });
  }

  // Task #1738 — surface social-graph counts on the public profile so
  // visitors can see how popular the player is and validate the value of
  // following them. Counts are unconditional (no privacy toggle) because
  // the per-user follow lists themselves are already exposed elsewhere
  // (followers_only post fan-out, etc.) and the counts are aggregate
  // numbers rather than identifying data. Both columns default to 0 if
  // the user has no follows in either direction.
  const [followerCountRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .where(eq(userFollowsTable.followeeId, user.id));
  const [followingCountRow] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .where(eq(userFollowsTable.followerId, user.id));
  const followerCount = Number(followerCountRow?.count) || 0;
  const followingCount = Number(followingCountRow?.count) || 0;

  // Favourite courses (most-played, by # of registered tournaments at each course)
  let favoriteCourses: Array<{ courseId: number; name: string; rounds: number }> = [];
  if (user.publicShowFavoriteCourses) {
    const favRows = await db
      .select({
        courseId: tournamentsTable.courseId,
        name: coursesTable.name,
        rounds: sql<number>`count(*)::int`,
      })
      .from(playersTable)
      .innerJoin(tournamentsTable, eq(playersTable.tournamentId, tournamentsTable.id))
      .innerJoin(coursesTable, eq(tournamentsTable.courseId, coursesTable.id))
      .where(and(
        eq(playersTable.userId, user.id),
        eq(playersTable.publicHidden, false),
      ))
      .groupBy(tournamentsTable.courseId, coursesTable.name)
      .orderBy(desc(sql`count(*)`))
      .limit(5);
    favoriteCourses = favRows
      .filter(r => r.courseId !== null)
      .map(r => ({ courseId: r.courseId as number, name: r.name, rounds: r.rounds }));
  }

  res.json({
    handle: user.publicHandle,
    displayName: profileDisplayName(user),
    profileImage: user.profileImage,
    bio: user.publicBio ?? null,
    location: user.publicLocation ?? null,
    homeClub,
    memberSince: new Date(user.createdAt).toISOString(),
    privacy: {
      showHandicap: user.publicShowHandicap,
      showRecentRounds: user.publicShowRecentRounds,
      showAchievements: user.publicShowAchievements,
      showFavoriteCourses: user.publicShowFavoriteCourses,
    },
    currentHandicap,
    handicapJourney,
    recentRounds,
    achievements,
    // Task #1752 — translate the catalog so the public badge page (which
    // looks up `cat?.label/description` for locked badges or when the
    // achievements list is empty) shows the viewer's locale too.
    badgeCatalog: ALL_BADGES.map(b => {
      const localized = localizeBadge(b, badgeLang);
      return { ...b, label: localized.label, description: localized.description };
    }),
    badgeProgress: user.publicShowAchievements ? await computeBadgeProgress(user.id) : {},
    favoriteCourses,
    // Task #1738 — social-graph counts shown next to the Follow button on
    // the public profile page. Aggregate-only; no per-user list is exposed
    // here so privacy toggles aren't required.
    followerCount,
    followingCount,
    deepLinks: {
      web: `${publicSiteBase(req)}/login`,
      mobile: `kharagolf://profile/${user.publicHandle}`,
    },
  });
});

// Task #2152 — Public follower / following lists for the profile page.
//
// The hero on /p/:handle (Task #1738) shows aggregate follower / following
// counts. Visitors who want to see *who* follows a popular player or who
// they follow had no way to do so. These two endpoints back the new
// clickable stats on the website + mobile public profile by mirroring
// the auth'd /portal/follows/list shape (items + total + limit + offset).
//
// Privacy:
//   - The profile owner (resolved from `:handle`) must have
//     publicProfileEnabled = true; otherwise 404, just like /p/:handle.
//   - Each row exposes the followee/follower's identity ONLY when that
//     user has also opted in (publicProfileEnabled = true). Members who
//     have not opted in are shown as redacted "Private member" rows
//     (`isPrivate: true`, no displayName/avatar/handle) so visitors can
//     still see the social graph density without leaking a non-public
//     member's identity.
//   - Tombstoned users (`erased_at`) are filtered from the items list
//     entirely (mirrors /portal/follows/list).
//
// Pagination & rate limit follow the other public.ts conventions:
//   limit/offset query params, default 50, cap 200; per-IP, per-handle,
//   and per-(IP+handle) token buckets via publicFollowsListScopes.
async function resolvePublicProfileOwner(
  handle: string,
): Promise<{ id: number } | null> {
  const [u] = await db
    .select({
      id: appUsersTable.id,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));
  if (!u || !u.publicProfileEnabled) return null;
  return { id: u.id };
}

function clampPublicListLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}
function clampPublicListOffset(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

interface PublicFollowRow {
  userId: number;
  displayName: string | null;
  profileImage: string | null;
  publicHandle: string | null;
  // True when the row is redacted because the user has not opted into a
  // public profile. Clients render these as "Private member" with no
  // link or avatar, never as a tappable row.
  isPrivate: boolean;
  followedAt: string;
}

function projectPublicFollowRow(r: {
  userId: number;
  username: string;
  displayName: string | null;
  profileImage: string | null;
  publicHandle: string | null;
  publicProfileEnabled: boolean;
  followedAt: Date;
}): PublicFollowRow {
  if (!r.publicProfileEnabled) {
    return {
      userId: r.userId,
      displayName: null,
      profileImage: null,
      publicHandle: null,
      isPrivate: true,
      followedAt: new Date(r.followedAt).toISOString(),
    };
  }
  return {
    userId: r.userId,
    displayName: profileDisplayName({
      displayName: r.displayName,
      username: r.username,
      publicHandle: r.publicHandle,
    }),
    profileImage: r.profileImage,
    publicHandle: r.publicHandle,
    isPrivate: false,
    followedAt: new Date(r.followedAt).toISOString(),
  };
}

// GET /api/public/p/:handle/followers — users who follow this profile.
// Newest follow first (matches /portal/followers).
router.get("/p/:handle/followers", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  if (!handle) { res.status(400).json({ error: "Missing handle" }); return; }
  const ip = getClientIp(req);
  if (!(await enforceRateLimit(res, publicFollowsListScopes(ip, handle)))) return;
  const owner = await resolvePublicProfileOwner(handle);
  if (!owner) { res.status(404).json({ error: "Profile not found" }); return; }

  const limit = clampPublicListLimit(req.query.limit);
  const offset = clampPublicListOffset(req.query.offset);

  // `total` MUST count only the same rows that can appear in `items`.
  // If we counted every raw row including tombstoned (erased_at) users,
  // the client's "offset < total" pagination guard would loop forever
  // requesting empty pages whenever an erased follower exists.
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followerId))
    .where(and(
      eq(userFollowsTable.followeeId, owner.id),
      sql`${appUsersTable.erasedAt} is null`,
    ));

  const rows = await db
    .select({
      userId: appUsersTable.id,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      profileImage: appUsersTable.profileImage,
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      followedAt: userFollowsTable.createdAt,
    })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followerId))
    .where(and(
      eq(userFollowsTable.followeeId, owner.id),
      sql`${appUsersTable.erasedAt} is null`,
    ))
    .orderBy(desc(userFollowsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    items: rows.map(projectPublicFollowRow),
    total: Number(count) || 0,
    limit,
    offset,
  });
});

// GET /api/public/p/:handle/following — users this profile follows.
// Newest follow first (matches /portal/follows/list).
router.get("/p/:handle/following", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  if (!handle) { res.status(400).json({ error: "Missing handle" }); return; }
  const ip = getClientIp(req);
  if (!(await enforceRateLimit(res, publicFollowsListScopes(ip, handle)))) return;
  const owner = await resolvePublicProfileOwner(handle);
  if (!owner) { res.status(404).json({ error: "Profile not found" }); return; }

  const limit = clampPublicListLimit(req.query.limit);
  const offset = clampPublicListOffset(req.query.offset);

  // See followers-route comment above: count only rows that survive the
  // erased_at filter so paginated clients terminate correctly.
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followeeId))
    .where(and(
      eq(userFollowsTable.followerId, owner.id),
      sql`${appUsersTable.erasedAt} is null`,
    ));

  const rows = await db
    .select({
      userId: appUsersTable.id,
      username: appUsersTable.username,
      displayName: appUsersTable.displayName,
      profileImage: appUsersTable.profileImage,
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      followedAt: userFollowsTable.createdAt,
    })
    .from(userFollowsTable)
    .innerJoin(appUsersTable, eq(appUsersTable.id, userFollowsTable.followeeId))
    .where(and(
      eq(userFollowsTable.followerId, owner.id),
      sql`${appUsersTable.erasedAt} is null`,
    ))
    .orderBy(desc(userFollowsTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    items: rows.map(projectPublicFollowRow),
    total: Number(count) || 0,
    limit,
    offset,
  });
});

// POST /api/public/p/:handle/share-events — Task #1083
// Records a single share-button click triggered from the public profile page
// itself. Visitors aren't authenticated, so we resolve the owning userId
// from the handle and tag the row with the client-supplied `source`
// (defaults to "web"). Task #1243 — accept `source: "mobile"` so taps
// originating from the KHARAGOLF mobile app's public profile viewer are
// distinguishable from website traffic in the social-proof
// "Shared N times" badge and analytics dashboards. Per-IP/per-handle
// token-bucket rate limits keep abusers from inflating the badge.
// Returns 404 for unknown / opted-out handles to avoid leaking handle
// existence.
const PUBLIC_PROFILE_SHARE_METHODS = new Set(["copy", "web_share", "native_share", "qr_open"]);
const PUBLIC_PROFILE_SHARE_SOURCES = new Set(["web", "mobile"]);
router.post("/p/:handle/share-events", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  if (!handle) { { res.status(400).json({ error: "Missing handle" }); return; } }
  const body = req.body ?? {};
  const method = typeof body.method === "string" ? body.method : "";
  if (!PUBLIC_PROFILE_SHARE_METHODS.has(method)) {
    res.status(400).json({ error: "method must be one of copy, web_share, native_share, qr_open" });
    return;
  }
  // Whitelist the client-supplied source — anything outside the known set
  // (e.g. unexpected new clients, junk) is normalised to "web" to keep
  // analytics buckets clean.
  const source = typeof body.source === "string" && PUBLIC_PROFILE_SHARE_SOURCES.has(body.source)
    ? body.source as "web" | "mobile"
    : "web";

  const [user] = await db
    .select({ id: appUsersTable.id, publicProfileEnabled: appUsersTable.publicProfileEnabled })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));
  if (!user || !user.publicProfileEnabled) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const ip = getClientIp(req);
  if (!(await enforceRateLimit(res, profileShareEventScopes(ip, handle)))) return;

  await db.insert(profileShareEventsTable).values({
    userId: user.id,
    handle,
    method: method as "copy" | "web_share" | "native_share" | "qr_open",
    source,
  });
  res.status(201).json({ ok: true });
});

// GET /api/public/p/:handle/share-stats — Task #929
// Public, unauthenticated read-only endpoint that returns the total number of
// times this profile has been shared (across all share methods and sources).
// Powers the social-proof "Shared N times" badge on the public profile page.
// Returns 404 if the handle has no public profile so we don't leak whether a
// handle exists for users that opted out of being public.
router.get("/p/:handle/share-stats", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  if (!handle) { { res.status(400).json({ error: "Missing handle" }); return; } }
  const [user] = await db
    .select({ id: appUsersTable.id, publicProfileEnabled: appUsersTable.publicProfileEnabled })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));
  if (!user || !user.publicProfileEnabled) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }
  // Task #1259 — Union the raw events table with the daily-aggregate
  // rollup so totals stay accurate after old rows have been pruned out
  // of `profile_share_events` into `profile_share_daily_aggregates`.
  const [rawRow, aggRow] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(profileShareEventsTable)
      .where(eq(profileShareEventsTable.userId, user.id))
      .then((rows) => rows[0]),
    db
      .select({ n: sql<number>`COALESCE(SUM(${profileShareDailyAggregatesTable.count}), 0)::int` })
      .from(profileShareDailyAggregatesTable)
      .where(eq(profileShareDailyAggregatesTable.userId, user.id))
      .then((rows) => rows[0]),
  ]);
  const total = Number(rawRow?.n ?? 0) + Number(aggRow?.n ?? 0);
  res.json({ handle, total });
});

// GET /api/public/p/:handle/og — server-rendered HTML with Open Graph + schema.org
// Use this URL for sharing — it returns proper meta tags and redirects bots/non-bots
// to the SPA. Crawlers see meta; humans get the live profile page.
router.get("/p/:handle/og", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  const [user] = await db
    .select({
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      publicHandle: appUsersTable.publicHandle,
      profileImage: appUsersTable.profileImage,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicBio: appUsersTable.publicBio,
      publicLocation: appUsersTable.publicLocation,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));

  if (!user || !user.publicProfileEnabled) {
    res.status(404).type("html").send("<!doctype html><html><body><h1>Profile not found</h1></body></html>");
    return;
  }

  const base = publicSiteBase(req);
  const url = `${base}/p/${handle}`;
  const name = profileDisplayName(user);
  const title = `${name} — KHARAGOLF`;
  const description = user.publicBio?.trim() || `${name}'s public golf profile on KHARAGOLF — recent rounds, handicap journey & achievements.`;
  const image = user.profileImage && user.profileImage.startsWith("http") ? user.profileImage : `${base}/favicon.svg`;

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "Person",
    name,
    url,
    description,
    image,
    identifier: handle,
    address: user.publicLocation ? { "@type": "PostalAddress", addressLocality: user.publicLocation } : undefined,
  };

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(url)}" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(url)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta property="profile:username" content="${escapeHtml(handle)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<meta http-equiv="refresh" content="0; url=${escapeHtml(url)}" />
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(url)}">${escapeHtml(name)}'s profile</a>…</p>
</body>
</html>`);
});

// POST /api/public/p/:handle/badge/:type/share-event — Task #926
// Records a single badge-share click. Public (no auth) so the share buttons
// on the public-profile page, the public-badge page, and the mobile owner
// badges screen can all funnel into one analytics stream. Validates that
// the handle resolves to a public profile that shares achievements (so we
// don't accumulate noise rows for hidden/disabled profiles) and that the
// badge type is a known catalog entry. Counts are derived with COUNT(*)
// GROUP BY badge_type at read time and exposed via the portal stats and
// admin leaderboard endpoints.
const BADGE_SHARE_METHODS = new Set(["copy", "web_share", "native_share"]);
const BADGE_SHARE_SOURCES = new Set(["web", "mobile"]);
router.post("/p/:handle/badge/:type/share-event", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  const badgeType = ((req.params as Record<string, string>).type ?? "").trim();
  const def = getBadgeDef(badgeType);
  if (!handle || !def) { { res.status(404).json({ error: "Badge not found" }); return; } }

  const body = req.body ?? {};
  const method = typeof body.method === "string" ? body.method : "";
  if (!BADGE_SHARE_METHODS.has(method)) {
    res.status(400).json({ error: "method must be one of copy, web_share, native_share" });
    return;
  }
  const source = typeof body.source === "string" && BADGE_SHARE_SOURCES.has(body.source)
    ? body.source as "web" | "mobile"
    : null;

  const [user] = await db
    .select({
      id: appUsersTable.id,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicShowAchievements: appUsersTable.publicShowAchievements,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));
  if (!user || !user.publicProfileEnabled || !user.publicShowAchievements) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  // Task #1096 — Throttle per-IP / per-handle / per-badge so a single
  // client cannot inflate badge-share counts beyond the broader handle
  // and IP quotas. Without this the unauthenticated POST below was a
  // free counter increment.
  const ip = getClientIp(req);
  if (!(await enforceRateLimit(res, badgeShareEventScopes(ip, handle, badgeType)))) return;

  await db.insert(badgeShareEventsTable).values({
    handle,
    badgeType,
    method: method as "copy" | "web_share" | "native_share",
    source,
  });
  res.status(201).json({ ok: true });
});

// POST /api/public/p/:handle/badge/:type/visit-event — Task #1798
// Records a single visit to the public-badge web page so the Badge
// Share Leaderboard can compute a real "shares → visits" conversion
// rate. Fired client-side from the public-badge React component on
// mount (best-effort, keepalive). Public (no auth) and unauthenticated
// because shared badge URLs land anywhere — text messages, social
// previews, embedded iframes — and we still want the visit attributed
// to the originating handle/badge.
//
// Validation mirrors `share-event`: the handle must resolve to a public
// profile that publishes achievements, and the badge type must be a
// known catalog entry. We further classify the request into one of:
//   - "web"     — non-bot UA, served the React page
//   - "mobile"  — explicit body source override (in-app webview)
//   - "crawler" — User-Agent matched a known social link previewer
//                 (Facebook, Twitter, Slack, LinkedIn, Discord, …);
//                 these are link-preview renders, not human visits, and
//                 are excluded from the conversion ratio in analytics
//   - "unknown" — anything else (curl, no UA, unknown agents)
// Storing crawlers in-band (rather than dropping them) keeps the table
// honest if a future product change wants to surface preview-fetch
// volume separately.
const BADGE_VISIT_SOURCES = new Set(["web", "mobile"]);
const SOCIAL_CRAWLER_UA_RE = /(facebookexternalhit|facebookcatalog|twitterbot|slackbot|linkedinbot|discordbot|whatsapp|telegrambot|skypeuripreview|pinterest|redditbot|googlebot|bingbot|applebot|embedly|vkshare|tumblr|nuzzel|chatwork|outbrain|quora link preview|developers\.google\.com\/\+\/web\/snippet|line\/|preview)/i;
router.post("/p/:handle/badge/:type/visit-event", async (req: Request, res: Response) => {
  const handle = String(req.params.handle ?? "").toLowerCase().trim();
  const badgeType = String(req.params.type ?? "").trim();
  const def = getBadgeDef(badgeType);
  if (!handle || !def) { res.status(404).json({ error: "Badge not found" }); return; }

  const [user] = await db
    .select({
      id: appUsersTable.id,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicShowAchievements: appUsersTable.publicShowAchievements,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));
  if (!user || !user.publicProfileEnabled || !user.publicShowAchievements) {
    res.status(404).json({ error: "Profile not found" });
    return;
  }

  const ip = getClientIp(req);
  if (!(await enforceRateLimit(res, badgeShareVisitScopes(ip, handle, badgeType)))) return;

  const ua = (req.headers["user-agent"] ?? "").toString();
  const body = req.body ?? {};
  const explicitSource = typeof body.source === "string" && BADGE_VISIT_SOURCES.has(body.source)
    ? (body.source as "web" | "mobile")
    : null;
  let source: "web" | "mobile" | "crawler" | "unknown";
  if (SOCIAL_CRAWLER_UA_RE.test(ua)) {
    source = "crawler";
  } else if (explicitSource) {
    source = explicitSource;
  } else if (ua) {
    source = "web";
  } else {
    source = "unknown";
  }

  await db.insert(badgeShareVisitEventsTable).values({
    handle,
    badgeType,
    source,
  });
  res.status(201).json({ ok: true });
});

// GET /api/public/p/:handle/badge/:type/og — Task #780, Task #924, Task #925
// Renders a PNG Open Graph image for a single badge so players can share
// achievements (or "almost there" progress) to social media. The corresponding
// share URL is `/p/<handle>/badge/<type>` on the website. Returns 404 unless
// the handle resolves to a public profile that shares achievements. If the
// player has unlocked the badge, the card celebrates the unlock; otherwise it
// shows a locked-with-progress card (e.g. "8 of 10") so players can brag about
// being close. Single-round badges with no numeric progress fall back to a
// simple "Locked — keep playing!" hint.
//
// Task #925: the response is image/png (rasterised from SVG via resvg)
// instead of image/svg+xml because social-media link previewers (Facebook,
// Instagram, LinkedIn) frequently refuse SVG og:image. The public URL stays
// identical so existing share buttons and meta tags work unchanged.
router.get("/p/:handle/badge/:type/og", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  const badgeType = ((req.params as Record<string, string>).type ?? "").trim();
  const def = getBadgeDef(badgeType);
  if (!handle || !def) { { res.status(404).type("png").send(Buffer.alloc(0)); return; } }

  // Task #1442 — language-aware OG image. The mobile share button and the
  // website append `?lang=<viewer-lang>`; we localise the chrome strings
  // ("BADGE UNLOCKED" / "ALMOST THERE" / "Earned X · @handle" / "X of Y")
  // and the date.
  //
  // Task #1764 — also localise the badge `label` and `description` themselves
  // using the shared catalog in `badgeI18n.ts` so a Hindi viewer who taps a
  // share link sees the badge name + tagline rendered in Devanagari (or any
  // other supported script) inside the SVG card, instead of the page chrome
  // wrapping a hard-coded English badge name. The two surfaces (catalog
  // endpoint + this OG card) now agree on the same per-locale translation.
  const langParam = typeof req.query.lang === "string" ? req.query.lang : null;
  const lang = normalizeBadgeOgLang(langParam);
  const ogStr = getBadgeOgStrings(lang);
  // `BadgeOgLang` (chrome) and `BadgeI18nLang` (catalog) declare the same
  // 21-locale set today but live in separate modules. Normalise the raw
  // query string a second time through the catalog's own validator instead
  // of casting between the two unions, so any future divergence (e.g. one
  // bundle adding a locale ahead of the other) degrades gracefully to
  // English instead of compile-error or silent misroute.
  const i18nLang = normalizeBadgeI18nLang(langParam);
  const localizedBadge = localizeBadge(def, i18nLang);
  const badgeLabel = localizedBadge.label;
  const badgeDescription = localizedBadge.description;

  const [user] = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
      publicShowAchievements: appUsersTable.publicShowAchievements,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));

  if (!user || !user.publicProfileEnabled || !user.publicShowAchievements) {
    res.status(404).type("png").send(Buffer.alloc(0));
    return;
  }

  const [earned] = await db
    .select({ earnedAt: achievementsTable.earnedAt })
    .from(achievementsTable)
    .where(and(eq(achievementsTable.userId, user.id), eq(achievementsTable.badgeType, badgeType)))
    .limit(1);

  const name = profileDisplayName(user);

  // Branch 1: badge unlocked — celebratory card (unchanged from Task #780).
  if (earned) {
    // Date locale follows the viewer language so e.g. Hindi viewers see the
    // date in Devanagari numerals where the platform supports it. Falls back
    // to en-US format if the runtime ICU data lacks the locale.
    const dateLocale = lang === "en" ? "en-US" : lang;
    let earnedAt: string;
    try {
      earnedAt = new Date(earned.earnedAt).toLocaleDateString(dateLocale, { year: "numeric", month: "long", day: "numeric" });
    } catch {
      earnedAt = new Date(earned.earnedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }
    // Task #2227 — interpolate the localized template, then split it into
    // (a) the date prose row and (b) the bare "@handle" row so each is
    // rendered as its own single-script <text> element. resvg-js doesn't do
    // per-glyph font fallback inside a single text run, so a mixed
    // Devanagari/Arabic prose + Latin handle row would always end up
    // rendering one half as tofu boxes (which was the actual #2227 bug).
    const earnedLine = interpolateBadgeOg(ogStr.earnedOn, { date: earnedAt, handle });
    const { earnedDateLine, handleLine } = splitEarnedLine(earnedLine, handle);
    const svg = buildBadgeOgUnlockedSvg({
      icon: def.icon,
      badgeLabel,
      badgeDescription,
      name,
      earnedDateLine,
      handleLine,
      badgeUnlockedLabel: ogStr.badgeUnlocked,
    });
    let pngBuffer: Buffer;
    try {
      const { Resvg } = await import("@resvg/resvg-js");
      const resvg = new Resvg(svg, {
        fitTo: { mode: "width", value: 1200 },
        // Task #1766 — also point resvg at the bundled Noto font directories
        // so non-Latin chrome strings (Hindi/Arabic/CJK/Thai/…) rasterise as
        // real glyphs instead of tofu boxes on social link previews.
        font: { loadSystemFonts: true, fontDirs: resolveBadgeOgFontDirs(), defaultFontFamily: "Arial" },
      });
      pngBuffer = Buffer.from(resvg.render().asPng());
    } catch (err) {
      logger.warn({ err, handle, badgeType }, "badge og png render failed (unlocked)");
      res.status(500).type("png").send(Buffer.alloc(0));
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(pngBuffer);
    return;
  }

  // Branch 2: badge locked — show progress hint when available. We pull
  // numeric progress from computeBadgeProgress; single-round badges that
  // aren't tracked there get a generic locked card.
  const progressMap = await computeBadgeProgress(user.id);
  const progress: BadgeProgress | undefined = progressMap[badgeType];
  const current = progress ? Math.min(progress.current, progress.target) : 0;
  const target = progress?.target ?? 0;
  const pct = progress && progress.target > 0 ? Math.max(0, Math.min(1, progress.current / progress.target)) : 0;
  const hasProgress = !!progress;
  const progressLabel = hasProgress
    ? interpolateBadgeOg(ogStr.xOfY, { current, target })
    : ogStr.keepPlaying;
  const svg = buildBadgeOgLockedSvg({
    icon: def.icon,
    badgeLabel,
    badgeDescription,
    name,
    handle,
    almostThereLabel: ogStr.almostThere,
    progressLabel,
    progressFraction: pct,
  });

  // Rasterise the SVG to PNG. Loading system fonts gives resvg the best
  // chance of rendering the player name and any available emoji glyphs;
  // failing that, the badge label, gradients and layout still composite
  // correctly so the share preview remains visually rich.
  let pngBuffer: Buffer;
  try {
    const { Resvg } = await import("@resvg/resvg-js");
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: 1200 },
      // Task #1766 — see resolveBadgeOgFontDirs() docs; loads Noto so
      // Devanagari / Arabic / CJK / Thai chrome strings render properly.
      font: { loadSystemFonts: true, fontDirs: resolveBadgeOgFontDirs(), defaultFontFamily: "Arial" },
    });
    pngBuffer = Buffer.from(resvg.render().asPng());
  } catch (err) {
    logger.warn({ err, handle, badgeType }, "badge og png render failed");
    res.status(500).type("png").send(Buffer.alloc(0));
    return;
  }

  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(pngBuffer);
});

// GET /api/public/scorecard/:shareToken/og — Open Graph wrapper for shared scorecards
router.get("/scorecard/:shareToken/og", async (req: Request, res: Response) => {
  const { shareToken } = (req.params as Record<string, string>);
  if (!shareToken) { { res.status(400).type("html").send("<h1>Bad request</h1>"); return; } }

  const [player] = await db
    .select({
      id: playersTable.id,
      firstName: playersTable.firstName,
      lastName: playersTable.lastName,
      tournamentId: playersTable.tournamentId,
      publicHidden: playersTable.publicHidden,
      userId: playersTable.userId,
    })
    .from(playersTable)
    .where(eq(playersTable.shareToken, shareToken));

  if (!player || player.publicHidden) {
    res.status(404).type("html").send("<!doctype html><html><body><h1>Scorecard not found</h1></body></html>");
    return;
  }

  const [tournament] = await db
    .select({ name: tournamentsTable.name, organizationId: tournamentsTable.organizationId, startDate: tournamentsTable.startDate, courseId: tournamentsTable.courseId })
    .from(tournamentsTable).where(eq(tournamentsTable.id, player.tournamentId));
  const [org] = tournament
    ? await db.select({ name: organizationsTable.name, logoUrl: organizationsTable.logoUrl }).from(organizationsTable).where(eq(organizationsTable.id, tournament.organizationId))
    : [null];

  const playerName = `${player.firstName} ${player.lastName}`.trim();
  const base = publicSiteBase(req);
  const url = `${base}/scorecard/${shareToken}`;
  const title = `${playerName} — ${tournament?.name ?? "Scorecard"} | KHARAGOLF`;
  const description = `${playerName}'s scorecard at ${tournament?.name ?? "tournament"}${org?.name ? ` (${org.name})` : ""}. Powered by KHARAGOLF.`;
  const image = (org?.logoUrl && org.logoUrl.startsWith("http")) ? org.logoUrl : `${base}/favicon.svg`;

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: tournament?.name,
    sport: "Golf",
    startDate: tournament?.startDate ? new Date(tournament.startDate).toISOString() : undefined,
    location: org?.name ? { "@type": "Place", name: org.name } : undefined,
    organizer: org?.name ? { "@type": "Organization", name: org.name } : undefined,
    competitor: { "@type": "Person", name: playerName },
    url,
  };

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(url)}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(url)}" />
<meta property="og:image" content="${escapeHtml(image)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(image)}" />
<script type="application/ld+json">${JSON.stringify(jsonld)}</script>
<meta http-equiv="refresh" content="0; url=${escapeHtml(url)}" />
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(url)}">${escapeHtml(playerName)}'s scorecard</a>…</p>
</body>
</html>`);
});

// ── PUBLIC YEAR-IN-GOLF RECAP SHARING (Task #451) ───────────────────
// Server-rendered share assets for the player's recap. The card.png
// endpoint produces a 1080×1920 PNG suitable for og:image / Twitter
// summary_large_image previews and as a save-to-camera-roll fallback
// when on-device react-native-view-shot is unavailable. The og endpoint
// serves an HTML stub with Open Graph + Twitter meta and redirects
// human visitors to the player's public profile, so social crawlers
// see a rich preview while clickers land somewhere meaningful.
//
// Both endpoints require the target user to have a reserved
// publicHandle AND publicProfileEnabled = true — otherwise the recap
// stays private.
async function resolvePublicRecapUser(handle: string) {
  const [user] = await db
    .select({
      id: appUsersTable.id,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
      publicHandle: appUsersTable.publicHandle,
      publicProfileEnabled: appUsersTable.publicProfileEnabled,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.publicHandle, handle));
  if (!user || !user.publicProfileEnabled) return null;
  return user;
}

function parseRecapYear(value: unknown): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(n) && n >= 2000 && n <= 2100) return n;
  return new Date().getUTCFullYear();
}

// Task #1281 — Recognised values for the `?via=` query parameter that
// our own share UI tags onto recap links so we can attribute hits back
// to the share button that produced them.
const RECAP_SHARE_SOURCES = new Set([
  "copy", "web_share", "native_share", "qr_open",
]);

// Task #1281 — Best-effort User-Agent sniff for known social-media
// crawlers that fetch og:image / og:url to render link previews. We
// keep this list intentionally short and pattern-based; the goal isn't
// perfect bot/human classification (the dedicated rate-limit task
// covers that) but distinguishing "a human shared this and the link
// preview was rendered" from "a human actually opened the link", so
// the recap-share-stats panel doesn't conflate the two.
const RECAP_CRAWLER_UA_RE = /facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|whatsapp|telegrambot|discordbot|skypeuripreview|pinterest|redditbot|googlebot|bingbot|applebot|embedly|quora\s*link\s*preview|chatgpt|gptbot|perplexity/i;

function classifyRecapShareSource(req: Request): string {
  const via = String(req.query.via ?? "").toLowerCase().trim();
  if (RECAP_SHARE_SOURCES.has(via)) return via;
  const ua = String(req.headers["user-agent"] ?? "");
  if (ua && RECAP_CRAWLER_UA_RE.test(ua)) return "crawler";
  return "unknown";
}

// Fire-and-forget insert into recap_share_events. We never block the
// response on this — analytics outages must not break the share assets
// themselves. Errors are logged at warn level only. The handle is
// snapshotted at request time so renames don't retroactively rewrite
// past events; userId is also stored so org-scoped reads keep working
// after a rename.
function recordRecapShareHit(args: {
  userId: number;
  handle: string;
  asset: "card_png" | "og";
  period: "year" | "q1" | "q2" | "q3" | "q4";
  year: number;
  source: string;
}): void {
  db.insert(recapShareEventsTable).values({
    userId: args.userId,
    handle: args.handle,
    asset: args.asset,
    period: args.period,
    year: args.year,
    source: args.source,
  }).then(() => undefined).catch((err: unknown) => {
    logger.warn({ err, ...args }, "[public-recap] failed to record share hit");
  });
}

// Task #1282 — Short TTL cache of rendered recap PNGs keyed by
// (handle, year, period, chapter). Bursts of identical requests from
// social-media crawlers, scraper retries, or a viral share all reuse the
// same buffer so the expensive `computeYearInGolf` aggregation runs at
// most once per key per `RECAP_PNG_CACHE_TTL_MS` window. An in-flight
// promise map coalesces concurrent misses for the same key so even the
// first thundering herd only triggers one render. The cache is bounded
// by an LRU cap to keep memory use predictable across many handles.
type RecapPngCacheEntry = { buf: Buffer; expiresAt: number };
const RECAP_PNG_CACHE_MAX = 256;
const RECAP_PNG_CACHE_TTL_MS = 60 * 1000;
const _recapPngCache = new Map<string, RecapPngCacheEntry>();
const _recapPngInflight = new Map<string, Promise<Buffer>>();

function _recapPngCacheGet(key: string): Buffer | undefined {
  const entry = _recapPngCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    _recapPngCache.delete(key);
    return undefined;
  }
  // Refresh LRU recency.
  _recapPngCache.delete(key);
  _recapPngCache.set(key, entry);
  return entry.buf;
}

function _recapPngCacheSet(key: string, buf: Buffer): void {
  _recapPngCache.set(key, { buf, expiresAt: Date.now() + RECAP_PNG_CACHE_TTL_MS });
  while (_recapPngCache.size > RECAP_PNG_CACHE_MAX) {
    const oldest = _recapPngCache.keys().next().value;
    if (oldest === undefined) break;
    _recapPngCache.delete(oldest);
  }
}

router.get("/recap/:handle/card.png", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  if (!handle) { { res.status(404).type("png").send(Buffer.alloc(0)); return; } }

  const ip = getClientIp(req);
  if (!(await enforceRateLimit(res, recapShareScopes(ip, handle)))) return;

  const user = await resolvePublicRecapUser(handle);
  if (!user) { { res.status(404).type("png").send(Buffer.alloc(0)); return; } }

  const { getCachedYearInGolf, parseRecapPeriod } = await import("../lib/year-in-golf");
  const { renderCardPng } = await import("../lib/year-in-golf-render");
  const year = parseRecapYear(req.query.year);
  const period = parseRecapPeriod(req.query.period);
  const chapter = Math.max(0, Number.parseInt(String(req.query.chapter ?? "0"), 10) || 0);
  // Task #1281 — Record the hit before rendering so we still capture
  // crawler/preview traffic even if the render path fails. We never
  // block the response on this and we only count successful 200 hits
  // (resolved handle, public profile enabled).
  recordRecapShareHit({
    userId: user.id,
    handle: user.publicHandle ?? handle,
    asset: "card_png",
    period,
    year,
    source: classifyRecapShareSource(req),
  });
  const cacheKey = `${user.id}|${handle}|${year}|${period}|${chapter}`;

  try {
    let png = _recapPngCacheGet(cacheKey);
    if (!png) {
      let inflight = _recapPngInflight.get(cacheKey);
      if (!inflight) {
        inflight = (async () => {
          try {
            const recap = await getCachedYearInGolf(user.id, year, period);
            const buf = renderCardPng(recap, chapter);
            _recapPngCacheSet(cacheKey, buf);
            return buf;
          } finally {
            _recapPngInflight.delete(cacheKey);
          }
        })();
        _recapPngInflight.set(cacheKey, inflight);
      }
      png = await inflight;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600");
    res.send(png);
  } catch (err) {
    logger.warn({ err, handle, year, period, chapter }, "[public-recap] card render failed");
    res.status(500).type("png").send(Buffer.alloc(0));
  }
});

router.get("/recap/:handle/og", async (req: Request, res: Response) => {
  const handle = ((req.params as Record<string, string>).handle ?? "").toLowerCase().trim();
  if (!handle) { { res.status(404).type("html").send("<!doctype html><html><body><h1>Recap not found</h1></body></html>"); return; } }

  const ip = getClientIp(req);
  if (!(await enforceRateLimit(res, recapShareScopes(ip, handle)))) return;

  const user = await resolvePublicRecapUser(handle);
  if (!user) { { res.status(404).type("html").send("<!doctype html><html><body><h1>Recap not found</h1></body></html>"); return; } }

  const { parseRecapPeriod } = await import("../lib/year-in-golf");
  const year = parseRecapYear(req.query.year);
  const period = parseRecapPeriod(req.query.period);

  // Task #1281 — Record the og hit. og is the URL crawlers fetch first
  // when rendering link previews (and the URL human visitors land on
  // before the meta-refresh redirect to the profile), so it's the
  // single best signal of "someone shared this recap link".
  recordRecapShareHit({
    userId: user.id,
    handle: user.publicHandle ?? handle,
    asset: "og",
    period,
    year,
    source: classifyRecapShareSource(req),
  });

  const base = publicSiteBase(req);
  const profileUrl = `${base}/p/${handle}`;
  const shareUrl = `${base}/api/public/recap/${handle}/og?year=${year}&period=${period}`;
  const imageUrl = `${base}/api/public/recap/${handle}/card.png?year=${year}&period=${period}&chapter=0`;
  const name = profileDisplayName(user);
  const periodLabel = period === "year" ? `${year}` : `${period.toUpperCase()} ${year}`;
  const title = `${name} — ${periodLabel} in Golf`;
  const description = `${name}'s KHARAGOLF ${periodLabel} recap — rounds, courses, achievements & handicap journey.`;

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(shareUrl)}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(shareUrl)}" />
<meta property="og:image" content="${escapeHtml(imageUrl)}" />
<meta property="og:image:width" content="1080" />
<meta property="og:image:height" content="1920" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
<meta http-equiv="refresh" content="0; url=${escapeHtml(profileUrl)}" />
</head>
<body>
<p>Redirecting to <a href="${escapeHtml(profileUrl)}">${escapeHtml(name)}'s profile</a>…</p>
</body>
</html>`);
});

// GET /api/public/sitemap-profiles.xml — sitemap for opted-in public profiles
router.get("/sitemap-profiles.xml", async (req: Request, res: Response) => {
  const rows = await db
    .select({ handle: appUsersTable.publicHandle, updatedAt: appUsersTable.updatedAt })
    .from(appUsersTable)
    .where(and(eq(appUsersTable.publicProfileEnabled, true)))
    .limit(50000);

  const base = publicSiteBase(req);
  const urls = rows
    .filter(r => !!r.handle)
    .map(r => `
    <url>
      <loc>${base}/p/${escapeXml(r.handle as string)}</loc>
      <lastmod>${new Date(r.updatedAt).toISOString()}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.6</priority>
    </url>`).join("");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}
</urlset>`;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(body);
});

// Task #1832 — controller-facing email-digest unsubscribe / re-subscribe routes.
// The three near-identical handler pairs that used to live inline here
// (bounced-digest schedule changes, stuck-erasure cleanup, monthly
// member-prefs digest) now register through a shared helper in
// `lib/digestSubscriptionRegistry.ts`. The token signers stay per-digest
// (so a leaked link can only opt out of the specific digest) and the
// public URLs stay byte-identical for back-compat with email links
// already in the wild. New digest? Append one entry to the registry —
// no new bespoke routes here.
mountPublicDigestRoutes(router);

// GET/POST /api/public/tie-break-email-unsubscribe?token=... — Task #1045
// One-click opt-out from the round-robin tie-break required alert email
// (Task #898). Idempotent: a second click still shows the same confirmation
// page. Token is HMAC-signed by signTieBreakEmailOptOutToken so we can trust
// (userId, orgId) without a session login. Accepting POST as well as GET
// supports RFC 8058 mail-client one-click unsubscribe (Gmail / Apple Mail
// hit the URL with POST + List-Unsubscribe=One-Click body).
async function handleTieBreakEmailUnsubscribe(req: Request, res: Response): Promise<void> {
  const { verifyTieBreakEmailOptOutToken } = await import("../lib/bouncedDigestUnsubscribe");
  const { roundRobinTieBreakEmailOptOutsTable, organizationsTable: orgsT } = await import("@workspace/db");
  const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
  const fromBody = typeof (req.body as { token?: unknown } | undefined)?.token === "string"
    ? (req.body as { token: string }).token : "";
  const token = fromQuery || fromBody;
  const parsed = verifyTieBreakEmailOptOutToken(token);
  function htmlPage(title: string, body: string, status = 200): void {
    res.status(status).type("html").send(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{max-width:480px;text-align:center;padding:40px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{color:#9ca3af;line-height:1.6;margin:0 0 8px;}
  .ok{color:#4ade80;}
  a.resub{display:inline-block;margin-top:16px;color:#60a5fa;text-decoration:underline;}
</style></head><body><div class="box">${body}</div></body></html>`);
  }
  if (!parsed) {
    htmlPage("Invalid link", `<h1>Invalid unsubscribe link</h1><p>This link is malformed or expired. You can manage your email preferences from your KHARAGOLF profile.</p>`, 400);
    return;
  }
  const [org] = await db.select({ id: orgsT.id, name: orgsT.name }).from(orgsT).where(eq(orgsT.id, parsed.orgId));
  if (!org) {
    htmlPage("Unknown organization", `<h1>Unknown organization</h1><p>The organization referenced by this link no longer exists.</p>`, 404);
    return;
  }
  await db.insert(roundRobinTieBreakEmailOptOutsTable).values({
    organizationId: parsed.orgId,
    userId: parsed.userId,
  }).onConflictDoNothing();
  const safeOrg = String(org.name ?? "your club").replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  const resubUrl = `/api/public/tie-break-email-resubscribe?token=${encodeURIComponent(token)}`;
  htmlPage("Unsubscribed", `<h1 class="ok">You're unsubscribed</h1>
    <p>You will no longer receive the "round-robin tie-break required" emails from <strong>${safeOrg}</strong>.</p>
    <p>Push notifications, the in-app inbox, and other ${safeOrg} emails are unaffected.</p>
    <p><a class="resub" href="${resubUrl}">Changed your mind? Re-subscribe</a></p>`);
}
router.get("/tie-break-email-unsubscribe", handleTieBreakEmailUnsubscribe);
router.post("/tie-break-email-unsubscribe", handleTieBreakEmailUnsubscribe);

// GET/POST /api/public/erasure-digest-portal-mute-revert?token=... — Task #1776
// Re-enables the channel(s) that were just muted by a controller via
// the in-portal toggle (PATCH /portal/notification-preferences). The
// link is sent in the one-time confirmation email by
// `sendErasureStorageDigestMutedConfirmationEmail`; clicking it lets a
// controller who muted by accident — or a controller whose shared
// session was used to silence the digest by someone else — restore the
// digest without logging in.
//
// Token (HMAC-signed `emr1:` prefix in `bouncedDigestUnsubscribe.ts`)
// carries (userId, orgId, channels, iat) where `channels` is "e" / "p"
// / "b" — only the channels that were actually muted in the originating
// PATCH are flipped back. We deliberately do NOT touch the other
// channel even if it happens to also be off, because that may have
// been an earlier deliberate mute the controller never intended to
// reverse with this click.
//
// 7-day TTL is enforced by the verifier; an expired link shows the
// same "invalid link" page as a forged one (with a hint pointing back
// to the in-portal preferences). Accepts POST as well as GET to keep
// parity with RFC 8058 one-click unsubscribe headers, which the
// confirmation email also sets.
async function handleErasureDigestPortalMuteRevert(req: Request, res: Response): Promise<void> {
  const { verifyErasureDigestMuteRevertToken } = await import("../lib/bouncedDigestUnsubscribe");
  const { userNotificationPrefsTable, organizationsTable: orgsT } = await import("@workspace/db");
  const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
  const fromBody = typeof (req.body as { token?: unknown } | undefined)?.token === "string"
    ? (req.body as { token: string }).token : "";
  const token = fromQuery || fromBody;
  const parsed = verifyErasureDigestMuteRevertToken(token);
  function htmlPage(title: string, body: string, status = 200): void {
    res.status(status).type("html").send(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{max-width:480px;text-align:center;padding:40px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{color:#9ca3af;line-height:1.6;margin:0 0 8px;}
  .ok{color:#4ade80;}
  a.prefs{display:inline-block;margin-top:16px;color:#60a5fa;text-decoration:underline;}
</style></head><body><div class="box">${body}</div></body></html>`);
  }
  if (!parsed) {
    htmlPage(
      "Invalid link",
      `<h1>Invalid revert link</h1><p>This link is malformed or expired (revert links expire after 7 days). You can re-enable the digest from your KHARAGOLF notification preferences.</p>`,
      400,
    );
    return;
  }
  const [org] = parsed.orgId
    ? await db.select({ id: orgsT.id, name: orgsT.name }).from(orgsT).where(eq(orgsT.id, parsed.orgId))
    : [undefined];
  // Capture the previous flag values so the audit row records a precise
  // from→to. Schema defaults are true so a missing prefs row reads as
  // "both channels were on" — a click in that case still succeeds and
  // simply ensures the row exists with both channels enabled.
  const [existingPrefs] = await db
    .select({
      email: userNotificationPrefsTable.notifyErasureStorageDigest,
      push: userNotificationPrefsTable.notifyErasureStorageDigestPush,
    })
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, parsed.userId));
  const previousEmail = existingPrefs?.email ?? true;
  const previousPush = existingPrefs?.push ?? true;
  const flipEmail = parsed.channels === "e" || parsed.channels === "b";
  const flipPush = parsed.channels === "p" || parsed.channels === "b";
  const setOnInsert: Record<string, unknown> = { userId: parsed.userId };
  const setOnUpdate: Record<string, unknown> = { updatedAt: new Date() };
  if (flipEmail) {
    setOnInsert.notifyErasureStorageDigest = true;
    setOnUpdate.notifyErasureStorageDigest = true;
  }
  if (flipPush) {
    setOnInsert.notifyErasureStorageDigestPush = true;
    setOnUpdate.notifyErasureStorageDigestPush = true;
  }
  await db.insert(userNotificationPrefsTable).values(setOnInsert as never).onConflictDoUpdate({
    target: userNotificationPrefsTable.userId,
    set: setOnUpdate,
  });
  // Audit the revert with the same shape as the unsubscribe / resub
  // handlers so the paper trail for a single controller's stuck-erasure
  // digest preferences reads top-to-bottom in chronological order.
  // Skipped when the org no longer exists or the token carried orgId=0
  // (member_audit_log.organization_id is NOT NULL).
  if (org) {
    const { recordMemberAudit } = await import("../lib/auditMember");
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    if (flipEmail) changes.notifyErasureStorageDigest = { from: previousEmail, to: true };
    if (flipPush) changes.notifyErasureStorageDigestPush = { from: previousPush, to: true };
    await recordMemberAudit({
      req,
      organizationId: parsed.orgId,
      clubMemberId: null,
      entity: "comm_prefs",
      entityId: parsed.userId,
      action: "update",
      changes,
      reason: "Public portal-mute revert link clicked",
      metadata: {
        source: "public_portal_mute_revert_link",
        kind: "erasure_storage_digest",
        direction: "revert_portal_mute",
        channels: parsed.channels,
        targetUserId: parsed.userId,
      },
    });
  }
  const safeOrg = String(org?.name ?? "your club").replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  const channelLabel = parsed.channels === "b"
    ? "email and in-app / push"
    : parsed.channels === "e" ? "email" : "in-app / push";
  htmlPage(
    "Re-enabled",
    `<h1 class="ok">Digest re-enabled</h1>
    <p>The "stuck erasure cleanup" daily digest from <strong>${safeOrg}</strong> will resume on the <strong>${channelLabel}</strong> channel whenever there's something to act on.</p>
    <p><a class="prefs" href="/portal/notification-preferences">Manage other notification preferences</a></p>`,
  );
}
router.get("/erasure-digest-portal-mute-revert", handleErasureDigestPortalMuteRevert);
router.post("/erasure-digest-portal-mute-revert", handleErasureDigestPortalMuteRevert);

// GET/POST /api/public/portal-digest-mute-revert?token=... — Task #2219
// Re-enables a sibling controller digest that was just muted via the
// in-portal toggle (PATCH /portal/notification-preferences). The link
// is sent in the one-time confirmation email by
// `sendPortalDigestMutedConfirmationEmail`; clicking it lets a
// controller who muted by accident — or whose shared session was used
// to silence the digest by someone else — restore the digest without
// logging in.
//
// Token (HMAC-signed `pdr1:` prefix in `bouncedDigestUnsubscribe.ts`)
// carries (userId, orgId, slug, iat) where `slug` is the registry
// opcode from `PORTAL_DIGEST_MUTE_REGISTRY` (e.g. `wrf`, `lld`, `sad`).
// The slug routes to the matching `userNotificationPrefs` boolean
// column, which is flipped back to true. Independent of the
// stuck-erasure revert handler above so a leaked sibling-digest token
// cannot be replayed against the erasure endpoint and vice versa.
//
// 7-day TTL is enforced by the verifier; an expired link shows the
// same "invalid link" page as a forged one (with a hint pointing back
// to the in-portal preferences). Accepts POST as well as GET to keep
// parity with RFC 8058 one-click unsubscribe headers, which the
// confirmation email also sets.
async function handlePortalDigestMuteRevert(req: Request, res: Response): Promise<void> {
  const { verifyPortalDigestMuteRevertToken } = await import("../lib/bouncedDigestUnsubscribe");
  const { getPortalDigestMuteSpec } = await import("../lib/portalDigestMuteRegistry");
  const { userNotificationPrefsTable, organizationsTable: orgsT } = await import("@workspace/db");
  const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
  const fromBody = typeof (req.body as { token?: unknown } | undefined)?.token === "string"
    ? (req.body as { token: string }).token : "";
  const token = fromQuery || fromBody;
  const parsed = verifyPortalDigestMuteRevertToken(token);
  function htmlPage(title: string, body: string, status = 200): void {
    res.status(status).type("html").send(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{max-width:480px;text-align:center;padding:40px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{color:#9ca3af;line-height:1.6;margin:0 0 8px;}
  .ok{color:#4ade80;}
  a.prefs{display:inline-block;margin-top:16px;color:#60a5fa;text-decoration:underline;}
</style></head><body><div class="box">${body}</div></body></html>`);
  }
  if (!parsed) {
    htmlPage(
      "Invalid link",
      `<h1>Invalid revert link</h1><p>This link is malformed or expired (revert links expire after 7 days). You can re-enable the alert from your KHARAGOLF notification preferences.</p>`,
      400,
    );
    return;
  }
  // The slug must resolve to a known registry entry. A token with a
  // structurally valid slug we don't recognise is treated like a forged
  // link — fail closed rather than silently no-op, so a future renamed
  // slug surfaces the mismatch in the public response.
  const spec = getPortalDigestMuteSpec(parsed.slug);
  if (!spec) {
    htmlPage(
      "Invalid link",
      `<h1>Invalid revert link</h1><p>This link references an unknown alert. You can re-enable the alert from your KHARAGOLF notification preferences.</p>`,
      400,
    );
    return;
  }
  const [org] = parsed.orgId
    ? await db.select({ id: orgsT.id, name: orgsT.name }).from(orgsT).where(eq(orgsT.id, parsed.orgId))
    : [undefined];
  // Capture the previous flag value so the audit row records a precise
  // from→to. Schema default for every covered pref column is true so a
  // missing prefs row reads as "was on before this click" — the click
  // in that case still succeeds and ensures the row exists with the
  // flag enabled.
  const [existingPrefs] = await db
    .select({ flag: spec.prefColumn })
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, parsed.userId));
  const previousFlag = existingPrefs?.flag ?? true;
  const setOnInsert: Record<string, unknown> = { userId: parsed.userId, [spec.prefField]: true };
  const setOnUpdate: Record<string, unknown> = { updatedAt: new Date(), [spec.prefField]: true };
  await db.insert(userNotificationPrefsTable).values(setOnInsert as never).onConflictDoUpdate({
    target: userNotificationPrefsTable.userId,
    set: setOnUpdate,
  });
  // Audit the revert with the same shape as the stuck-erasure revert
  // handler above so the paper trail for a controller's per-digest
  // preferences reads top-to-bottom in chronological order. Skipped
  // when the org no longer exists or the token carried orgId=0
  // (member_audit_log.organization_id is NOT NULL).
  if (org) {
    const { recordMemberAudit } = await import("../lib/auditMember");
    await recordMemberAudit({
      req,
      organizationId: parsed.orgId,
      clubMemberId: null,
      entity: "comm_prefs",
      entityId: parsed.userId,
      action: "update",
      changes: { [spec.prefField]: { from: previousFlag, to: true } },
      reason: "Public portal-mute revert link clicked",
      metadata: {
        source: "public_portal_mute_revert_link",
        kind: spec.notificationKey,
        digestSlug: spec.slug,
        direction: "revert_portal_mute",
        targetUserId: parsed.userId,
      },
    });
  }
  const safeOrg = String(org?.name ?? "your club").replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  htmlPage(
    "Re-enabled",
    `<h1 class="ok">${spec.revertHeadlineHtml}</h1>
    <p>${spec.revertBodyHtml.replace(/\bfrom <org>\b/g, `from <strong>${safeOrg}</strong>`)}</p>
    <p><a class="prefs" href="/portal/notification-preferences">Manage other notification preferences</a></p>`,
  );
}
router.get("/portal-digest-mute-revert", handlePortalDigestMuteRevert);
router.post("/portal-digest-mute-revert", handlePortalDigestMuteRevert);

// GET/POST /api/public/notification-event-mute?token=... — Task #1734
// One-click opt-out from a single notification event (currently
// `wallet.refund.digest.failed` and `side_game.receipt.digest.failed`,
// per `EVENT_MUTE_SLUGS` in `notifyDispatch.ts`). The token is HMAC-
// signed (`pem1:` prefix in `bouncedDigestUnsubscribe.ts`) and carries
// (userId, slug, orgId, iat) — slug routes back to the right
// notification key + per-event opt-out column without leaking the full
// registry key into the URL. Tokens have a 90-day TTL — that's defence
// in depth on top of the natural idempotency of the underlying flag
// flip; a stale token returns the same "invalid link" page as a forged
// one rather than silently failing.
//
// Like the erasure-digest opt-out, this flips a *user-level*
// `userNotificationPrefs` column (per-event, not per-(user, org)). The
// orgId from the token is carried only so the confirmation page can
// name the club the alert came from. Accepting POST as well as GET
// supports RFC 8058 mail-client one-click unsubscribe.
async function handleNotificationEventMute(req: Request, res: Response): Promise<void> {
  const { verifyEventMuteToken } = await import("../lib/bouncedDigestUnsubscribe");
  const { EVENT_MUTE_KEY_FOR_SLUG, perEventOptOutColumn, perEventOptOutFieldName } =
    await import("../lib/notifyDispatch");
  const { userNotificationPrefsTable, organizationsTable: orgsT, notificationAuditLogTable } =
    await import("@workspace/db");
  const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
  const fromBody = typeof (req.body as { token?: unknown } | undefined)?.token === "string"
    ? (req.body as { token: string }).token : "";
  const token = fromQuery || fromBody;
  const parsed = verifyEventMuteToken(token);
  function htmlPage(title: string, body: string, status = 200): void {
    res.status(status).type("html").send(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{max-width:480px;text-align:center;padding:40px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{color:#9ca3af;line-height:1.6;margin:0 0 8px;}
  .ok{color:#4ade80;}
  a.resub{display:inline-block;margin-top:16px;color:#60a5fa;text-decoration:underline;}
</style></head><body><div class="box">${body}</div></body></html>`);
  }
  if (!parsed) {
    htmlPage("Invalid link", `<h1>Invalid mute link</h1><p>This link is malformed or expired. You can also silence this alert from your KHARAGOLF notification preferences.</p>`, 400);
    return;
  }
  const key = EVENT_MUTE_KEY_FOR_SLUG[parsed.slug];
  const column = key ? perEventOptOutColumn(key) : undefined;
  const fieldName = key ? perEventOptOutFieldName(key) : undefined;
  if (!key || !column || !fieldName) {
    // Slug shape was valid but no longer maps to a registered event
    // (e.g. the slug map was removed in a later release). Treat as a
    // bad link rather than crashing — the user gets a clear message
    // and can manage prefs from the portal.
    htmlPage("Unknown alert", `<h1>This alert can no longer be muted from email</h1><p>You can manage notification preferences from your KHARAGOLF profile.</p>`, 400);
    return;
  }
  const [org] = parsed.orgId
    ? await db.select({ id: orgsT.id, name: orgsT.name }).from(orgsT).where(eq(orgsT.id, parsed.orgId))
    : [undefined];
  // Capture the previous flag value before flipping it so the audit row
  // records a precise from→to change. Schema default is true, so a
  // missing prefs row means the admin was opted in.
  const [existingPrefs] = await db
    .select({ flag: column })
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, parsed.userId));
  const previousFlag = existingPrefs?.flag ?? true;
  // Upsert: drizzle's strongly-typed `set` insists the keys be valid
  // SCHEMA-OBJECT field names (camelCase), so we feed it `fieldName`
  // resolved from PER_EVENT_OPT_OUT_FIELD_NAMES. Cast through `never`
  // because TS can't follow the dynamic key.
  await db.insert(userNotificationPrefsTable).values(
    { userId: parsed.userId, [fieldName]: false } as never,
  ).onConflictDoUpdate({
    target: userNotificationPrefsTable.userId,
    set: { [fieldName]: false, updatedAt: new Date() } as never,
  });
  // Notification-side audit row — the canonical paper trail for
  // suppressions on this key. Mirrors the audit emitted by the
  // dispatcher when it short-circuits an opted-out recipient (Task
  // #1429), but with a distinct reason (`event_opted_out_via_email_link`)
  // so ops can tell email-link mutes apart from in-app toggle changes.
  await db.insert(notificationAuditLogTable).values({
    notificationKey: key,
    userId: parsed.userId,
    channel: "email",
    status: "skipped",
    reason: "event_opted_out_via_email_link",
    payload: {
      source: "email_mute_link",
      orgId: parsed.orgId,
      direction: "unsubscribe",
      previousFlag,
      field: fieldName,
    },
  });
  // Member-side audit row — only when the org carried by the token
  // still exists, mirroring the erasure-digest pattern. The
  // user-level flip succeeds either way; the audit just records the
  // (user, org) breadcrumb when an org context is available.
  if (org) {
    const { recordMemberAudit } = await import("../lib/auditMember");
    await recordMemberAudit({
      req,
      organizationId: parsed.orgId,
      clubMemberId: null,
      entity: "comm_prefs",
      entityId: parsed.userId,
      action: "update",
      changes: {
        [fieldName]: { from: previousFlag, to: false },
      },
      reason: "Public mute link clicked",
      metadata: {
        source: "email_mute_link",
        kind: "notification_event_mute",
        notificationKey: key,
        slug: parsed.slug,
        direction: "unsubscribe",
        targetUserId: parsed.userId,
      },
    });
  }
  const safeOrg = String(org?.name ?? "your club").replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  const safeKey = String(key).replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  const resubUrl = `/api/public/notification-event-resubscribe?token=${encodeURIComponent(token)}`;
  htmlPage("Muted", `<h1 class="ok">This alert is muted</h1>
    <p>You will no longer receive emails for <code>${safeKey}</code> from <strong>${safeOrg}</strong>.</p>
    <p>Your other notifications and the in-app inbox are unaffected.</p>
    <p><a class="resub" href="${resubUrl}">Changed your mind? Re-subscribe</a></p>`);
}
router.get("/notification-event-mute", handleNotificationEventMute);
router.post("/notification-event-mute", handleNotificationEventMute);

// GET /api/public/notification-event-resubscribe?token=... — Task #1734
// One-click reversal of the mute above. Uses the same HMAC-signed token
// (still subject to the 90-day TTL) so an admin who clicked mute by
// mistake can restore the alert without involving an admin or logging
// in. Idempotent: a user who is not currently opted out still sees the
// success page (the upsert just keeps the flag on).
router.get("/notification-event-resubscribe", async (req: Request, res: Response) => {
  const { verifyEventMuteToken } = await import("../lib/bouncedDigestUnsubscribe");
  const { EVENT_MUTE_KEY_FOR_SLUG, perEventOptOutColumn, perEventOptOutFieldName } =
    await import("../lib/notifyDispatch");
  const { userNotificationPrefsTable, organizationsTable: orgsT, notificationAuditLogTable } =
    await import("@workspace/db");
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const parsed = verifyEventMuteToken(token);
  function htmlPage(title: string, body: string, status = 200): void {
    res.status(status).type("html").send(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{max-width:480px;text-align:center;padding:40px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{color:#9ca3af;line-height:1.6;margin:0 0 8px;}
  .ok{color:#4ade80;}
</style></head><body><div class="box">${body}</div></body></html>`);
  }
  if (!parsed) {
    htmlPage("Invalid link", `<h1>Invalid re-subscribe link</h1><p>This link is malformed or expired. You can manage your email preferences from your KHARAGOLF profile.</p>`, 400);
    return;
  }
  const key = EVENT_MUTE_KEY_FOR_SLUG[parsed.slug];
  const column = key ? perEventOptOutColumn(key) : undefined;
  const fieldName = key ? perEventOptOutFieldName(key) : undefined;
  if (!key || !column || !fieldName) {
    htmlPage("Unknown alert", `<h1>This alert can no longer be re-subscribed from email</h1><p>You can manage notification preferences from your KHARAGOLF profile.</p>`, 400);
    return;
  }
  const [org] = parsed.orgId
    ? await db.select({ id: orgsT.id, name: orgsT.name }).from(orgsT).where(eq(orgsT.id, parsed.orgId))
    : [undefined];
  const [existingPrefs] = await db
    .select({ flag: column })
    .from(userNotificationPrefsTable)
    .where(eq(userNotificationPrefsTable.userId, parsed.userId));
  const previousFlag = existingPrefs?.flag ?? true;
  await db.insert(userNotificationPrefsTable).values(
    { userId: parsed.userId, [fieldName]: true } as never,
  ).onConflictDoUpdate({
    target: userNotificationPrefsTable.userId,
    set: { [fieldName]: true, updatedAt: new Date() } as never,
  });
  await db.insert(notificationAuditLogTable).values({
    notificationKey: key,
    userId: parsed.userId,
    channel: "email",
    status: "skipped",
    reason: "event_opted_in_via_email_link",
    payload: {
      source: "email_mute_link",
      orgId: parsed.orgId,
      direction: "resubscribe",
      previousFlag,
      field: fieldName,
    },
  });
  if (org) {
    const { recordMemberAudit } = await import("../lib/auditMember");
    await recordMemberAudit({
      req,
      organizationId: parsed.orgId,
      clubMemberId: null,
      entity: "comm_prefs",
      entityId: parsed.userId,
      action: "update",
      changes: {
        [fieldName]: { from: previousFlag, to: true },
      },
      reason: "Public re-subscribe link clicked",
      metadata: {
        source: "email_mute_link",
        kind: "notification_event_mute",
        notificationKey: key,
        slug: parsed.slug,
        direction: "resubscribe",
        targetUserId: parsed.userId,
      },
    });
  }
  const safeOrg = String(org?.name ?? "your club").replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  const safeKey = String(key).replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  htmlPage("Re-subscribed", `<h1 class="ok">You're re-subscribed</h1>
    <p>You'll receive emails for <code>${safeKey}</code> from <strong>${safeOrg}</strong> again the next time something needs your attention.</p>`);
});


// GET /api/public/tie-break-email-resubscribe?token=... — Task #1045
// One-click reversal of the opt-out above. Idempotent: deleting zero rows
// is a no-op and still renders the success page.
router.get("/tie-break-email-resubscribe", async (req: Request, res: Response) => {
  const { verifyTieBreakEmailOptOutToken } = await import("../lib/bouncedDigestUnsubscribe");
  const { roundRobinTieBreakEmailOptOutsTable, organizationsTable: orgsT } = await import("@workspace/db");
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const parsed = verifyTieBreakEmailOptOutToken(token);
  function htmlPage(title: string, body: string, status = 200): void {
    res.status(status).type("html").send(`<!DOCTYPE html>
<html><head><title>${title}</title><style>
  body{font-family:Inter,sans-serif;background:#0a0a0a;color:#fff;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;}
  .box{max-width:480px;text-align:center;padding:40px;}
  h1{font-size:22px;margin:0 0 12px;}
  p{color:#9ca3af;line-height:1.6;margin:0 0 8px;}
  .ok{color:#4ade80;}
</style></head><body><div class="box">${body}</div></body></html>`);
  }
  if (!parsed) {
    htmlPage("Invalid link", `<h1>Invalid re-subscribe link</h1><p>This link is malformed or expired. You can manage your email preferences from your KHARAGOLF profile.</p>`, 400);
    return;
  }
  const [org] = await db.select({ id: orgsT.id, name: orgsT.name }).from(orgsT).where(eq(orgsT.id, parsed.orgId));
  if (!org) {
    htmlPage("Unknown organization", `<h1>Unknown organization</h1><p>The organization referenced by this link no longer exists.</p>`, 404);
    return;
  }
  await db.delete(roundRobinTieBreakEmailOptOutsTable).where(and(
    eq(roundRobinTieBreakEmailOptOutsTable.organizationId, parsed.orgId),
    eq(roundRobinTieBreakEmailOptOutsTable.userId, parsed.userId),
  ));
  const safeOrg = String(org.name ?? "your club").replace(/[<>&"']/g, c =>
    ({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&#39;"}[c]!));
  htmlPage("Re-subscribed", `<h1 class="ok">You're re-subscribed</h1>
    <p>You'll receive the "round-robin tie-break required" emails from <strong>${safeOrg}</strong> again.</p>`);
});

export default router;
