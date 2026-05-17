import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import playerAuthRouter from "./player-auth";
import socialAuthRouter from "./social-auth";
import portalRouter from "./portal";
import organizationsRouter from "./organizations";
import coursesRouter from "./courses";
import tournamentsRouter from "./tournaments";
import playersRouter from "./players";
import scoresRouter from "./scores";
import teeTimesRouter from "./tee-times";
import membersRouter from "./members";
import adminRouter from "./admin";
import adminPlayersRouter from "./admin-players";
import sseRouter from "./sse";
import leaguesRouter from "./leagues";
import publicRouter from "./public";
import flightsRouter from "./flights";
import paymentsRouter from "./payments";
import matchResultsRouter from "./match-results";
import sideGamesRouter from "./side-games";
import sideGamesV2Router from "./side-games-v2";
import invitationsRouter, { broadcastRouter, announcementsRouter, deviceTokenRouter, publicInviteRouter, templatesRouter, automationRulesRouter } from "./communications";
import mediaRouter from "./media";
import chatRouter from "./chat";
import webhooksRouter from "./webhooks";
import membershipsRouter from "./memberships";
import sponsorsRouter, { orgSponsorsRouter, packagesRouter, assignmentsRouter, invoicesRouter, sponsorPortalRouter } from "./sponsors";
import { adCampaignsRouter, publicAdRouter } from "./ad-campaigns";
import prizesRouter from "./prizes";
import shopRouter from "./shop";
import staffRouter from "./staff";
import whsRouter from "./whs";
import rulesRouter from "./rules";
import tournamentTemplatesRouter, { createFromTemplateRouter } from "./tournament-templates";
import practiceRouter from "./practice";
import tournamentRoundsRouter from "./tournament-rounds";
import handicapCommitteeRouter from "./handicap-committee";
import handicapCasesRouter, { handicapCasesPortalRouter } from "./handicap-cases";
import peerReviewPublicRouter from "./peer-review-public";
import marketplaceRouter from "./marketplace";
import marketplaceDiscoverRouter from "./marketplace-discover";
import superAdminRouter from "./super-admin";
import onboardingRouter from "./onboarding";
import generalPlayRouter from "./general-play";
import teeBookingsRouter from "./tee-bookings";
import teeRulesRouter from "./tee-rules";
import teePricingRouter from "./tee-pricing";
import rangeBookingsRouter from "./range-bookings";
import scorerStationRouter from "./scorer-station";
import cartsRouter from "./carts";
import noticeBoardRouter from "./notice-board";
import posRouter from "./pos";
import matchPlayRouter from "./match-play";
import publicBracketRouter from "./public-bracket";
import fantasyRouter from "./fantasy";
import predictionsRouter from "./predictions";
import lessonsRouter from "./lessons";
import swingVideosRouter from "./swing-videos";
import coachMarketplaceRouter from "./coach-marketplace";
import swingReviewsRouter from "./swing-reviews";
import lockersRouter from "./lockers";
import fbOrdersRouter from "./fb-orders";
import corporateCharityRouter from "./corporate-charity";
import governanceRouter from "./governance";
import feedRouter from "./feed";
import tripsRouter from "./trips";
import displayBoardRouter from "./display-board";
import paceOfPlayRouter from "./pace-of-play";
import rankingsRouter, { publicRankingsRouter, portalRankingsRouter } from "./rankings";
import clubRepairRouter, { fittingRouter } from "./club-repair";
import procurementRouter from "./procurement";
import rentalsRouter from "./rentals";
import consignmentRouter from "./consignment";
import giftCardsRouter from "./gift-cards";
import loyaltyRouter from "./loyalty";
import commissionsRouter from "./commissions";
import caddiesRouter from "./caddies";
import courseMaintenanceRouter, { publicCourseConditionsRouter } from "./course-maintenance";
import eventsRouter, { publicEventsRouter } from "./events";
import schedulingRouter from "./scheduling";
import waitlistRouter from "./waitlist";
import guestPassesRouter from "./guest-passes";
import duesBillingRouter from "./dues-billing";
import accountingRouter from "./accounting";
import analyticsRouter from "./analytics";
import surveysRouter from "./surveys";
import clubChampionshipRouter from "./club-championship";
import interclubRouter from "./interclub";
import juniorGolfRouter from "./junior-golf";
import eventStaffingRouter from "./event-staffing";
import marketingRouter, { marketingPublicRouter } from "./marketing";
import marketingSiteRouter, { marketingSitePublicRouter } from "./marketing-site";
import vendorOperatorsRouter from "./vendor-operators";
import gstInvoicesRouter from "./gst-invoices";
import commerceAnalyticsRouter from "./commerce-analytics";
import inventoryRouter from "./inventory";
import promotionsRouter from "./promotions";
import outboundWebhooksRouter from "./outbound-webhooks";
import documentsRouter from "./documents";
import reportsRouter from "./reports";
import eventFormsRouter from "./event-forms";
import markerLiveRouter from "./marker-live";
import member360Router from "./member-360";
import broadcastOverlaysRouter from "./broadcast-overlays";
import highlightsRouter from "./highlights";
import crossClubLaddersRouter, { publicCrossClubLaddersRouter } from "./cross-club-ladders";
import currencyTaxRouter, { playerPrefRouter as currencyTaxPlayerPrefRouter } from "./currency-tax";
import marketingFunnelRouter from "./marketing-funnel";
import emailCtaTrackingRouter from "./email-cta-tracking";

const router: IRouter = Router();

/**
 * Global scorer-session guard.
 * Scorer PIN sessions are only allowed to reach score-entry endpoints
 * (/scores, /scores/bulk, and the scorer-login endpoint itself).
 * All other paths get a 403 if a scorer session is present.
 * Individual score-entry routes additionally call requireScorerAccess
 * which further validates tournament scope.
 */
// Matches any URL segment that is exactly "scores", e.g.:
//   /organizations/1/tournaments/5/scores
//   /organizations/1/tournaments/5/scores/bulk
//   /organizations/1/tournaments/5/scores/42/9  (correction/delete)
const SCORER_ALLOWED_PATH = /\/scores(\/|$)/;
// The dedicated scorer-station router (mounted at /scorer/*) — group picker,
// per-hole score entry, group submit, and per-shot capture (Task #710,
// `source: 'scorer'`) — is fully gated by getScorerSession() inside each
// handler, so it is safe to permit the whole prefix here.
const SCORER_STATION_PATH = /^\/scorer\//;
// Allow scorer sessions to READ tee-time groups (for the group picker) and course holes (for par/SI)
const SCORER_READONLY_PATH = /\/(tee-times|course-holes)(\/|$)/;

function blockNonScoringForScorerSessions(req: Request, res: Response, next: NextFunction): void {
  if (!req.scorerSession) { next(); return; }
  if (SCORER_ALLOWED_PATH.test(req.path)) { next(); return; }
  if (SCORER_STATION_PATH.test(req.path)) { next(); return; }
  if (req.method === "GET" && SCORER_READONLY_PATH.test(req.path)) { next(); return; }
  res.status(403).json({ error: "Scorer sessions may only be used for score entry." });
}

// Marker live view — fully public, token-only auth (no session required)
router.use("/marker-live", markerLiveRouter);

// Webhook endpoints (verified by provider HMAC — no session auth)
router.use("/webhooks", webhooksRouter);

// Public onboarding (club registration, directory, plan listing — no auth)
router.use(onboardingRouter);

// Public (no auth required)
router.use("/public", publicRouter);

// Player email/password auth (open endpoints — includes scorer-login)
router.use(playerAuthRouter);
router.use(socialAuthRouter);

// Global guard: block scorer PIN sessions from all non-scoring routes
// Score-entry routes (/scores, /scores/bulk) are exempt; they validate scope themselves.
router.use(blockNonScoringForScorerSessions);

// Payments (Razorpay — key endpoint is open, verify/webhook may be open too)
router.use("/payments", paymentsRouter);

// Health
router.use(healthRouter);

// Auth
router.use(authRouter);

// Player portal (session-protected)
router.use(portalRouter);

// SSE real-time
router.use("/sse", sseRouter);

// Admin
router.use(adminRouter);

// Super-admin (platform-level management)
router.use(superAdminRouter);
router.use(adminPlayersRouter);

// Organizations + nested resources
router.use("/organizations", organizationsRouter);
router.use("/organizations/:orgId/courses", coursesRouter);
router.use("/organizations/:orgId/members", membersRouter);
router.use("/organizations/:orgId/leagues", leaguesRouter);
// Tournament templates: must be before /tournaments/:tournamentId to avoid param conflicts
router.use("/organizations/:orgId/tournament-templates", tournamentTemplatesRouter);
router.use("/organizations/:orgId/tournaments", createFromTemplateRouter);
router.use("/organizations/:orgId/tournaments", tournamentsRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId/flights", flightsRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId/players", playersRouter);
// Broadcast overlay producer endpoints — must mount before scoresRouter at the
// tournament scope, because scoresRouter has DELETE /:playerId/:holeNumber which
// would otherwise match /overlay-templates/:templateId.
router.use(broadcastOverlaysRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId/scores", scoresRouter);
router.use(
  "/organizations/:orgId/tournaments/:tournamentId",
  (req, _res, next) => {
    // Forward leaderboard and scorecard to scores router
    next();
  },
);
router.use("/organizations/:orgId/tournaments/:tournamentId", scoresRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId/tee-times", teeTimesRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId", teeTimesRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId", matchResultsRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId/side-games", sideGamesRouter);
// Side games v2 — instances/templates/settlements (org-scoped, supports tournaments,
// league rounds, and general-play rounds via scope params).
router.use("/", sideGamesV2Router);

// Communications: invitations, broadcast messages, templates, automation rules
router.use("/organizations/:orgId/invitations", invitationsRouter);
router.use("/organizations/:orgId/messages", broadcastRouter);
router.use("/organizations/:orgId/templates", templatesRouter);
router.use("/organizations/:orgId/automation-rules", automationRulesRouter);

// Tournament announcements (admin post + public get)
router.use("/organizations/:orgId/tournaments/:tournamentId/announcements", announcementsRouter);

// Device token registration (portal bearer-auth protected)
// Mounted at /api/portal/ (not /api/) intentionally: these routes require a valid
// player portal Bearer JWT (issued by POST /api/auth/player-login).  The mobile app
// calls POST /api/portal/push/register on boot and after login via context/auth.tsx.
router.use("/portal", deviceTokenRouter);

// Public: invite token validation
router.use("/public", publicInviteRouter);

// Media galleries (upload-url, register, approve, delete, serve)
router.use(mediaRouter);

// Chat rooms + messages
router.use(chatRouter);

// Membership tiers + club members + subscriptions
router.use("/organizations/:orgId/membership-tiers", membershipsRouter);
router.use("/organizations/:orgId/club-members", membershipsRouter);

// Member Management 360 (Task #166) — extended profile, lifecycle, audit, etc.
router.use("/organizations/:orgId/members-360", member360Router);

// Sponsors (per-tournament)
router.use("/organizations/:orgId/tournaments/:tournamentId/sponsors", sponsorsRouter);

// Sponsors CRM (org-level)
router.use("/organizations/:orgId/sponsors", orgSponsorsRouter);

// Sponsorship Packages
router.use("/organizations/:orgId/sponsorship-packages", packagesRouter);

// Sponsorship Assignments
router.use("/organizations/:orgId/sponsorship-assignments", assignmentsRouter);

// Sponsor Invoices
router.use("/organizations/:orgId/sponsor-invoices", invoicesRouter);

// Sponsor Portal (public — JWT-based auth for sponsor contacts)
router.use("/sponsor-portal", sponsorPortalRouter);

// Ad inventory: slots, creatives, campaigns (Task #371)
router.use("/organizations/:orgId/ad-inventory", adCampaignsRouter);
router.use("/public", publicAdRouter);

// Prizes (per-tournament)
router.use("/organizations/:orgId/tournaments/:tournamentId/prizes", prizesRouter);

// Practice sessions (per-org per-user)
router.use("/organizations/:orgId/practice", practiceRouter);

// Handicap Committee Tools
router.use("/organizations/:orgId/handicap", handicapCommitteeRouter);
// Handicap Committee Review Cases (peer-review workflow)
router.use("/organizations/:orgId/handicap", handicapCasesRouter);
// Player-facing portal: my-cases for the signed-in user
router.use("/portal", handicapCasesPortalRouter);
// Public peer-review response (token-authenticated)
router.use("/public", peerReviewPublicRouter);

// Tee Time Marketplace
router.use("/organizations/:orgId/marketplace", marketplaceRouter);

// Cross-Club Tee Time Marketplace Discovery (Task 359)
router.use("/marketplace-discover", marketplaceDiscoverRouter);

// Tournament rounds (multi-course assignments)
router.use("/organizations/:orgId/tournaments/:tournamentId/rounds", tournamentRoundsRouter);

// Shop (products + orders)
router.use("/organizations/:orgId/shop", shopRouter);

// Promotions, discounts, affiliates, bundle deals, flash sales
router.use("/organizations/:orgId/shop/promotions", promotionsRouter);

// Staff management + scorer PINs + scorer login
router.use(staffRouter);

// WHS / GHIN score posting
// Tournament-level mount (for /rounds/:round/post-whs etc.)
router.use("/organizations/:orgId/tournaments/:tournamentId", whsRouter);
// Org-level mount (for /organizations/:orgId/whs/states, /annual-review, /review-status, /pdf etc.)
// Uses root mount so that full-path routes like "/organizations/:orgId/whs/..." resolve correctly.
router.use(whsRouter);

// AI Golf Rules Assistant (public — no auth required)
router.use("/public", rulesRouter);

// General Play Rounds (portal player + org admin)
router.use(generalPlayRouter);
router.use("/organizations/:orgId", generalPlayRouter);

// Tee Time Bookings (org admin + portal player)
router.use(teeBookingsRouter);

// Tee Sheet Rules Engine (Task #129)
router.use(teeRulesRouter);

// Dynamic Pricing & Yield Management (Task #367)
router.use(teePricingRouter);

// Golf Cart Fleet Management
router.use(cartsRouter);
router.use(noticeBoardRouter);

// Lesson & Coaching Booking
router.use("/organizations/:orgId/lessons", lessonsRouter);

// Coach Marketplace + Swing Video Feature (Task #380)
router.use("/swing-videos", swingVideosRouter);
router.use("/coach-marketplace", coachMarketplaceRouter);
router.use("/swing-reviews", swingReviewsRouter);

// Driving Range & Bay Bookings
router.use(rangeBookingsRouter);

// Event Day Staffing — Caddies & Volunteers/Marshals
router.use(eventStaffingRouter);

// Scorer Station (PIN-session, separate guard already applies)
router.use(scorerStationRouter);

// Pro Shop POS
router.use("/organizations/:orgId/pos", posRouter);

// Match Play Brackets & Ryder Cup
router.use("/organizations/:orgId/tournaments/:tournamentId", matchPlayRouter);

// Public spectator views (no auth, share-token based)
router.use("/public", publicBracketRouter);

// Fantasy Golf Leagues (per-org)
router.use("/organizations/:orgId/fantasy", fantasyRouter);
router.use("/organizations/:orgId/tournaments/:tournamentId/predictions", predictionsRouter);

// Locker Room Management
router.use("/organizations/:orgId/lockers", lockersRouter);

// Food & Beverage On-Course Ordering
router.use("/organizations/:orgId/fb", fbOrdersRouter);

// Corporate & Charity Golf Events (Task #92)
router.use("/organizations/:orgId/tournaments", corporateCharityRouter);

// Governance Hub (Documents, Notices, Meetings, Votes)
router.use(governanceRouter);

// Document Library — club & event operational documents (Task #147)
router.use(documentsRouter);

// Social Wall & Club Feed
router.use("/organizations/:orgId/feed", feedRouter);

// Golf Trips & Away Day Planner
router.use("/organizations/:orgId/trips", tripsRouter);

// TV Display Board — public pairing + admin settings/codes
router.use(displayBoardRouter);

// Pace of Play (Task #96)
router.use("/organizations/:orgId/tournaments", paceOfPlayRouter);
router.use("/organizations/:orgId", paceOfPlayRouter);

// Rankings: public endpoints (no auth)
router.use("/public", publicRankingsRouter);

// Rankings: portal player history
router.use("/portal", portalRankingsRouter);

// Rankings: org admin series management + standings
router.use("/organizations/:orgId/rankings", rankingsRouter);

// Club Repair & Fitting Tracker
router.use("/organizations/:orgId/repair-jobs", clubRepairRouter);
router.use("/organizations/:orgId/fitting-sessions", fittingRouter);

// Procurement: Suppliers & Purchase Orders (Task #101)
router.use("/organizations/:orgId/procurement", procurementRouter);

// Rental Equipment Management (clubs, trolleys, GPS devices, umbrellas, etc.)
router.use("/organizations/:orgId/rentals", rentalsRouter);

// Consignment Tracking (Task #104)
router.use("/organizations/:orgId/consignment", consignmentRouter);

// Gift Cards & Store Credit (Task #102)
router.use("/organizations/:orgId/gift-cards", giftCardsRouter);

// Loyalty & Rewards Programme (Task #103)
router.use("/organizations/:orgId/loyalty", loyaltyRouter);

// Staff Commission Tracking (Task #105)
router.use("/organizations/:orgId/commissions", commissionsRouter);

// Caddie Management & Booking (Task #106)
router.use(caddiesRouter);

// Course Maintenance & Greenkeeper Logs (Task #108)
router.use("/organizations/:orgId/maintenance", courseMaintenanceRouter);
router.use("/public", publicCourseConditionsRouter);

// Event & Banquet / Function Management (Task #109)
router.use("/organizations/:orgId/events", eventsRouter);

// Public event enquiry & space listing (no auth)
router.use("/public/organizations/:orgId/events", publicEventsRouter);

// Staff Scheduling & Roster Management (Task #110)
router.use("/organizations/:orgId/scheduling", schedulingRouter);

// Member Waitlist & Application Management (Task #111)
router.use("/organizations/:orgId/waitlist", waitlistRouter);
router.use(waitlistRouter);

// Guest & Visitor Pass Management (Task #112)
router.use(guestPassesRouter);

// Annual Dues & Billing Automation (Task #113)
router.use("/organizations/:orgId/dues-billing", duesBillingRouter);

// Accounting & Finance Integration (Task #114)
router.use("/organizations/:orgId/accounting", accountingRouter);

// Business Intelligence & Analytics (Task #115)
router.use("/organizations/:orgId/analytics", analyticsRouter);

// Member Feedback & Survey Tools (Task #117)
router.use("/organizations/:orgId/surveys", surveysRouter);
// Marketing & Email Campaign Tools (Task #116)
router.use("/organizations/:orgId/marketing", marketingRouter);
router.use("/marketing", marketingPublicRouter);
// Per-club marketing site builder (Task #369)
router.use("/organizations/:orgId/marketing-site", marketingSiteRouter);
router.use("/public", marketingSitePublicRouter);

// Club Championships (per-org)
router.use("/organizations/:orgId/club-championships", clubChampionshipRouter);

// Interclub fixtures and seasons (per-org)
router.use("/organizations/:orgId/interclub", interclubRouter);

// Junior Golf Programs (profiles, guardians, pathways, programs, sessions, leaderboard)
router.use("/organizations/:orgId/junior", juniorGolfRouter);

// Vendor Operator Pro Shop Management (Task #119)
router.use("/organizations/:orgId/vendor-operators", vendorOperatorsRouter);

// GST Invoices — multi-channel tax invoice management (Task #132)
router.use("/organizations/:orgId/gst-invoices", gstInvoicesRouter);

// Commerce Analytics Dashboard (Task #132)
router.use("/organizations/:orgId/commerce-analytics", commerceAnalyticsRouter);

// Inventory: Multi-location stock, barcode scanning, stocktake, transfers (Task #133)
router.use("/organizations/:orgId/inventory", inventoryRouter);

// Outbound Webhooks management (Task #149)
router.use("/organizations/:orgId/webhooks", outboundWebhooksRouter);

// Custom Report Builder (Task #148)
router.use("/organizations/:orgId/reports", reportsRouter);

// Custom Registration Forms & Post-Event Surveys (Task #142)
router.use(eventFormsRouter);

// Broadcast Overlays (Task #370) — OBS/vMix browser-source endpoints + producer control
router.use(broadcastOverlaysRouter);

// Photo-to-video highlight reels (Task #361)
router.use(highlightsRouter);

// Cross-Club Leagues & National Ladders (Task #376)
router.use(crossClubLaddersRouter);
router.use("/public", publicCrossClubLaddersRouter);

// Multi-currency & multi-tax (Task #373) — admin config + quoting + FX P&L
router.use("/organizations/:orgId/currency-tax", currencyTaxRouter);
// Player preferred-currency (separate, no orgId scope)
router.use("/currency-tax", currencyTaxPlayerPrefRouter);

// Marketing funnel public endpoints (Task #382) — ROI calc, demo booking, analytics
router.use("/public", marketingFunnelRouter);

// Task #1622 — Email CTA click-tracking redirect (`/r/email/:token`) +
// admin CTR report (`/admin/notification-cta-stats`).
router.use(emailCtaTrackingRouter);

// Wave 2 (Task #937) — load-bearing endpoints
import wave2Router from "./wave2";
router.use(wave2Router);
import wave3Router from "./wave3";
router.use(wave3Router);
import followsStatusRouter from "./follows-status";
router.use(followsStatusRouter);
// Task #2159 — generic per-user in-app notification inbox (currently
// surfaces `social.follow.new` rows; new keys can opt in by inserting
// into `userInboxNotificationsTable` from their dispatch site).
import portalInboxRouter from "./portal-inbox";
router.use("/", portalInboxRouter);

export default router;
