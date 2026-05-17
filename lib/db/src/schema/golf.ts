import {
  foreignKey,
  pgTable, text, integer, timestamp, boolean, numeric, serial, bigserial, date,
  pgEnum, uniqueIndex, index, jsonb, pgView, unique, primaryKey, check, type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Enums
export const supportedLanguageEnum = pgEnum("supported_language", [
  "en", "hi", "ar", "es", "fr", "de", "pt",
  "ja", "ko", "zh", "th", "ms", "id", "vi",
  "fil", "sw", "af", "am", "ha", "zu", "yo",
]);

// Task #362 — per-club governing-body wording for the AI Rules Assistant.
// "rna" = R&A wording (default — international), "usga" = USGA wording.
export const rulesGoverningBodyEnum = pgEnum("rules_governing_body", [
  "rna", "usga",
]);

export const orgRoleEnum = pgEnum("org_role", [
  "super_admin", "org_admin", "membership_secretary", "treasurer", "tournament_director", "committee_member", "competition_secretary", "volunteer", "player", "spectator", "pro_shop",
]);

export const tournamentStaffRoleEnum = pgEnum("tournament_staff_role", [
  "tournament_admin", "live_scorer", "volunteer",
]);

export const leagueStaffRoleEnum = pgEnum("league_staff_role", [
  "league_admin", "competition_secretary",
]);
export const subscriptionTierEnum = pgEnum("subscription_tier", [
  "free", "starter", "pro", "enterprise",
]);
export const tournamentFormatEnum = pgEnum("tournament_format", [
  "stroke_play", "net_stroke", "best_ball", "scramble", "skins", "match_play", "stableford", "shamble",
  "match_play_bracket", "ryder_cup", "maximum_score", "par_bogey", "team_stableford",
]);
export const tournamentStatusEnum = pgEnum("tournament_status", [
  "draft", "upcoming", "active", "completed", "cancelled", "suspended",
]);
export const paymentStatusEnum = pgEnum("payment_status", [
  "unpaid", "pending", "paid", "refunded",
]);
export const teeBoxEnum = pgEnum("tee_box", ["blue", "white", "red", "gold", "black"]);

// League enums
export const leagueFormatEnum = pgEnum("league_format", [
  "stableford",       // Points per hole vs par — UK/Ireland/Aus/SA/Europe
  "stroke_play",      // Medal — classic gross strokes
  "net_stroke",       // Net Medal with handicap
  "match_play",       // Head-to-head holes won
  "bogey",            // Hole-by-hole vs bogey (Germany/Netherlands)
  "eclectic",         // Best score per hole across season
  "foursomes",        // Alternate shot pairs — UK traditional
  "greensomes",       // Both tee, pick best, alternate — UK
  "texas_scramble",   // Team scramble — UK clubs
  "waltz",            // Best 2 of 3 holes — Ireland
  "alliance",         // Team best ball per hole — UK
  "better_ball",      // Best ball of 2 partners
  "order_of_merit",   // Season-long points ranking
  "shamble",          // Scramble tee + individual play in
]);
export const leagueTypeEnum = pgEnum("league_type", ["individual", "team", "pairs"]);
export const leagueStatusEnum = pgEnum("league_status", ["draft", "upcoming", "active", "completed"]);
// Wave 1 W1-A: AI Caddie advice mode applied during a round.
//   open          — all advice surfaces enabled
//   distance_only — only F/C/B yardages permitted; club rec / strategy hidden
//   lockdown      — every advice surface (incl. yardages) blocked + audited
export const aiCaddieModeEnum = pgEnum("ai_caddie_mode", [
  "open",
  "distance_only",
  "lockdown",
]);

export const tiebreakerMethodEnum = pgEnum("tiebreaker_method", [
  "countback", "multi_round_countback", "net_countback", "lower_handicap", "no_tiebreaker",
]);
export const leaderboardTypeEnum = pgEnum("leaderboard_type", ["gross", "net", "both"]);

// ORG SUBSCRIPTION STATUS (mirrors Razorpay subscription lifecycle)
export const orgSubscriptionStatusEnum = pgEnum("org_subscription_status", [
  "free", "active", "past_due", "cancelled", "pending_payment",
]);

// SUBSCRIPTION PLAN CONFIGS (one row per tier — editable by super admin)
export const subscriptionPlanConfigsTable = pgTable("subscription_plan_configs", {
  tier: subscriptionTierEnum("tier").primaryKey(),
  priceMonthly: integer("price_monthly").notNull().default(0),
  maxActiveTournaments: integer("max_active_tournaments"),
  maxMembers: integer("max_members"),
  maxLeagues: integer("max_leagues"),
  sponsorLogos: boolean("sponsor_logos").notNull().default(false),
  advancedAnalytics: boolean("advanced_analytics").notNull().default(false),
  prioritySupport: boolean("priority_support").notNull().default(false),
  mobileApp: boolean("mobile_app").notNull().default(true),
  marketplace: boolean("marketplace").notNull().default(false),
  aiRulesAssistant: boolean("ai_rules_assistant").notNull().default(false),
  whsScoring: boolean("whs_scoring").notNull().default(false),
  duesBilling: boolean("dues_billing").notNull().default(false),
  shopLockerAccess: boolean("shop_locker_access").notNull().default(false),
  whiteLabel: boolean("white_label").notNull().default(false),
  customDomain: boolean("custom_domain").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ORG PLAN OVERRIDES (per-club field-level overrides — null = use tier default)
export const orgPlanOverridesTable = pgTable("org_plan_overrides", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  overrideMaxTournaments: integer("override_max_tournaments"),
  overrideMaxMembers: integer("override_max_members"),
  overrideMaxLeagues: integer("override_max_leagues"),
  overrideSponsorLogos: boolean("override_sponsor_logos"),
  overrideAdvancedAnalytics: boolean("override_advanced_analytics"),
  overridePrioritySupport: boolean("override_priority_support"),
  overrideMobileApp: boolean("override_mobile_app"),
  overrideMarketplace: boolean("override_marketplace"),
  overrideAiRulesAssistant: boolean("override_ai_rules_assistant"),
  overrideWhsScoring: boolean("override_whs_scoring"),
  overrideDuesBilling: boolean("override_dues_billing"),
  overrideShopLockerAccess: boolean("override_shop_locker_access"),
  overrideWhiteLabel: boolean("override_white_label"),
  overrideCustomDomain: boolean("override_custom_domain"),
  overrideReason: text("override_reason"),
  overrideSetByUserId: integer("override_set_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  overrideExpiresAt: timestamp("override_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("org_plan_overrides_org_unique").on(t.organizationId),
]);

// LEGACY PLAN SLUG MAPPINGS (Task #1131)
// Editable mapping from non-standard legacy plan slugs (e.g. "basic", "premium")
// to a canonical SubscriptionTier. Read by the Plan Migration audit panel to
// suggest a restore tier; managed by super admins via the super-admin UI so
// support staff can add/edit entries without an engineer or code deploy.
export const legacyPlanSlugMappingsTable = pgTable("legacy_plan_slug_mappings", {
  slug: text("slug").primaryKey(),
  tier: subscriptionTierEnum("tier").notNull(),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ORGANIZATIONS
export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").default("#1e4d2b"),
  customDomain: text("custom_domain"),
  // Task #581 — Automatic HTTPS for vanity domains. The platform calls the
  // configured ingress provider (Cloudflare for SaaS / Caddy on-demand /
  // mock) when an admin saves a custom domain, and stores the certificate
  // provisioning state here so the admin UI can show pending/active/failed
  // and offer a retry. Status is one of: 'none' | 'pending' | 'active' | 'failed'.
  customDomainCertStatus: text("custom_domain_cert_status").notNull().default("none"),
  customDomainCertProvider: text("custom_domain_cert_provider"),
  customDomainCertError: text("custom_domain_cert_error"),
  customDomainCertRequestedAt: timestamp("custom_domain_cert_requested_at", { withTimezone: true }),
  customDomainCertIssuedAt: timestamp("custom_domain_cert_issued_at", { withTimezone: true }),
  customDomainCertCheckedAt: timestamp("custom_domain_cert_checked_at", { withTimezone: true }),
  // Task #668 — De-dup tracking for the "HTTPS live / failed" admin email.
  // Records the (host, status) tuple we last emailed admins about so retries
  // and idempotent re-saves don't re-spam. Reset to NULL when the cert is
  // cleared (custom domain removed) so re-adding the same domain re-arms
  // the notification.
  customDomainCertNotifiedStatus: text("custom_domain_cert_notified_status"),
  customDomainCertNotifiedHost: text("custom_domain_cert_notified_host"),
  // Task #818 — Timestamp of when the most recent dedup-claimed admin
  // notification was sent. Surfaced via /custom-domain/status so admins
  // can see "Last notified admins: HTTPS active on Apr 21, 14:02".
  customDomainCertNotifiedAt: timestamp("custom_domain_cert_notified_at", { withTimezone: true }),
  // Task #1101 — Lets an admin who knows their cert is broken (e.g. mid
  // DNS migration) silence the periodic HTTPS-failed re-nudge email for a
  // bounded window without having to clear/re-add the domain. The
  // re-nudge job (renudgeStaleCustomDomainHttpsFailures) skips orgs whose
  // snooze-until is still in the future, and the snooze auto-clears
  // anywhere the cert flips to 'active' or the custom domain is cleared.
  customDomainCertRenudgeSnoozedUntil: timestamp("custom_domain_cert_renudge_snoozed_until", { withTimezone: true }),
  // Task #1482 — When the re-nudge job fires the snooze-ended email it
  // atomically clears `customDomainCertRenudgeSnoozedUntil` (Task #1262),
  // so the original snooze date is gone afterwards. This column captures
  // it at the moment of the snooze-ended re-nudge so the in-app HTTPS
  // panel can render the same "you snoozed this until X — that snooze
  // has now ended" acknowledgement that the email body shows. Cleared on
  // the next admin action (retry, re-snooze, cancel-snooze, domain
  // change) and on the cron path that flips the cert back to 'active'.
  // GET /custom-domain/status additionally hides the value when the most
  // recent admin notification is more than ~7 days old so a stale banner
  // never lingers forever.
  customDomainCertSnoozeEndedFromUntil: timestamp("custom_domain_cert_snooze_ended_from_until", { withTimezone: true }),
  subscriptionTier: subscriptionTierEnum("subscription_tier").notNull().default("free"),
  subscriptionStatus: orgSubscriptionStatusEnum("org_subscription_status").notNull().default("free"),
  pendingSubscriptionTier: subscriptionTierEnum("pending_subscription_tier"),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  isActive: boolean("is_active").notNull().default(true),
  /** @deprecated Stripe is no longer the active payment processor. Use razorpaySubscriptionId for subscription tracking. */
  stripeCustomerId: text("stripe_customer_id"),
  shopReviewModerationEnabled: boolean("shop_review_moderation_enabled").notNull().default(false),
  marketplaceCancelWindowHours: integer("marketplace_cancel_window_hours").notNull().default(24),
  // Task 359 — cross-club tee-time marketplace controls
  marketplaceEnabled: boolean("marketplace_enabled").notNull().default(false),
  marketplaceDefaultPublic: boolean("marketplace_default_public").notNull().default(false),
  marketplaceCommissionPct: numeric("marketplace_commission_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  marketplaceMarkupPct: numeric("marketplace_markup_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  address: text("address"),
  website: text("website"),
  handicapReviewCompletedAt: timestamp("handicap_review_completed_at"),
  handicapReviewCompletedByUserId: integer("handicap_review_completed_by_user_id"),
  defaultLanguage: supportedLanguageEnum("default_language").notNull().default("en"),
  // Task #362 — per-club Rules Assistant configuration. Governing body
  // controls which wording (R&A vs USGA) the AI Rules Assistant uses, and
  // localRulesContent is a markdown blob of club-specific local rules that
  // gets injected into the assistant's prompt so answers respect them.
  rulesGoverningBody: rulesGoverningBodyEnum("rules_governing_body").notNull().default("rna"),
  localRulesContent: text("local_rules_content"),
  // Task 274 — per-org scheduling for the bounced-levy reminders email digest.
  // frequency: 'daily' | 'weekday' | 'weekly' (Mondays only).
  // hourLocal: 0-23, evaluated in `timezone`. NULL hour or NULL tz keeps the
  // legacy "fire on the first cron tick of the UTC day" behaviour.
  bouncedDigestFrequency: text("bounced_digest_frequency").notNull().default("daily"),
  bouncedDigestHourLocal: integer("bounced_digest_hour_local"),
  bouncedDigestTimezone: text("bounced_digest_timezone"),
  // ISO date (YYYY-MM-DD) in the org's timezone (or UTC if no tz set) when the
  // last digest was delivered. Survives restarts so we can't double-send.
  bouncedDigestLastSentOn: text("bounced_digest_last_sent_on"),
  // Task #1078 — per-org dedup watermark for the daily "stuck erasure cleanup"
  // controller digest (sent to org_admins / membership_secretaries / treasurers
  // when the count of members with leftover object-storage files > 0). Stores
  // the UTC date (YYYY-MM-DD) of the most recent successful send so the cron
  // can re-run safely after a restart without double-emailing the same day.
  erasureStorageDigestLastSentOn: text("erasure_storage_digest_last_sent_on"),
  // Task #1489 — per-org dedup watermark for the monthly "member
  // notification preferences" controller digest CSV. Stores the
  // current-month tag (UTC `YYYY-MM`) of the most recent successful
  // send so the cron can re-run safely after a restart without
  // double-emailing the same calendar month. The cron polls daily and
  // skips orgs whose stamp already matches the current month.
  memberPrefsDigestLastSentOn: text("member_prefs_digest_last_sent_on"),
  // Task #654 — persistent backing store for the per-org schedule-change
  // notify throttle. The notify path atomically claims this column via a
  // conditional UPDATE so the 60-second rate limit (and the audit rows
  // gated on it) survive an API server restart.
  bouncedDigestScheduleNotifyAt: timestamp("bounced_digest_schedule_notify_at", { withTimezone: true }),
  // Task #850 — Per-org thresholds + alert email for the wearable
  // needs_reauth sweep alert. Defaults match the previous hardcoded
  // constants (≥ 5 connections OR ≥ 25 % of attempted with at least
  // 4 attempts). The alert email is optional; when null we fall back
  // to the global WELLNESS_REAUTH_ALERT_EMAIL env var (legacy default).
  wearableReauthAlertMinCount: integer("wearable_reauth_alert_min_count").notNull().default(5),
  wearableReauthAlertMinSharePct: integer("wearable_reauth_alert_min_share_pct").notNull().default(25),
  wearableReauthAlertMinAttempted: integer("wearable_reauth_alert_min_attempted").notNull().default(4),
  wearableReauthAlertEmail: text("wearable_reauth_alert_email"),
  // Task #1325 — Per-org override for the weekly week-over-week needs_reauth
  // drift threshold consumed by `evaluateWeeklyReauthDrift` in
  // `artifacts/api-server/src/lib/wearables.ts`. Larger clubs typically
  // tolerate a higher delta floor before being alerted; smaller clubs may
  // want to be paged on any drift.
  //
  // NULL means "inherit the system-wide default" — i.e. the
  // `WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA` env var, falling back to the
  // hardcoded `WELLNESS_REAUTH_WOW_ALERT_DEFAULT_MIN_DELTA`. We
  // intentionally do not seed a hardcoded default on the column because
  // doing so would freeze every existing org at 1.00 and silently bypass
  // any future change to the env-var default for orgs that never touched
  // the field. Admins can still clear an override (set back to NULL) to
  // re-inherit the env value.
  wearableReauthWowAlertMinDelta: numeric("wearable_reauth_wow_alert_min_delta", { precision: 6, scale: 2 }),
  // Task #1188 — Org-wide default for the manual-entry data-quality alert
  // (`notifyManualEntryRound`). When false, the alert is muted across every
  // tournament in the org regardless of the per-tournament toggle so clubs
  // running hundreds of casual social events don't have to flip the
  // tournament-level switch on every new event. New tournaments inherit
  // this value at creation time (`tournaments.notify_manual_entry_alerts`
  // is seeded from this column).
  notifyManualEntryAlerts: boolean("notify_manual_entry_alerts").notNull().default(true),
  // Task #1673 — additional org-wide notification defaults that follow the
  // same registry-driven inheritance pattern as `notifyManualEntryAlerts`.
  // Each has a sibling boolean column on `tournaments` and is registered in
  // `lib/orgNotificationDefaults.ts` so the /club-settings card and the
  // /notification-defaults endpoint family pick them up automatically.
  //
  // Schedule-change alerts: pings tournament directors when start/end dates,
  // round times, or registration deadlines shift after publish so they can
  // re-broadcast the change to entrants. Mute org-wide for clubs running
  // standing weekly leagues where minor reschedules are routine and
  // already broadcast through other channels.
  notifyScheduleChanges: boolean("notify_schedule_changes").notNull().default(true),
  // Score-correction alerts: pings tournament directors when an admin edits
  // a previously-finalized scorecard so they can audit the change. Mute
  // org-wide for clubs that resolve corrections informally and don't need
  // a per-edit notification.
  notifyScoreCorrections: boolean("notify_score_corrections").notNull().default(true),
  // Task #1151 — per-org rate-limit watermark for the weekly week-over-week
  // needs_reauth drift email. The weekly evaluator (`evaluateWeeklyReauthDrift`
  // in lib/wearables.ts) uses an atomic conditional UPDATE on
  // `WHERE wearable_reauth_wow_alert_last_sent_at IS NULL OR
  //  wearable_reauth_wow_alert_last_sent_at < now() - interval '7 days'`
  // so the alert is delivered at most once per week per org regardless of
  // how often the cron tick fires.
  wearableReauthWowAlertLastSentAt: timestamp("wearable_reauth_wow_alert_last_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// APP USERS (linked to Replit auth OR local email/password auth)
export const appUsersTable = pgTable("app_users", {
  id: serial("id").primaryKey(),
  replitUserId: text("replit_user_id").notNull().unique(),
  username: text("username").notNull(),
  email: text("email"),
  displayName: text("display_name"),
  profileImage: text("profile_image"),
  role: orgRoleEnum("role").notNull().default("player"),
  organizationId: integer("organization_id").references(() => organizationsTable.id),
  // Local email/password auth fields (null for Replit OAuth users)
  passwordHash: text("password_hash"),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  emailVerificationExpiry: timestamp("email_verification_expiry", { withTimezone: true }),
  passwordResetToken: text("password_reset_token"),
  passwordResetExpiry: timestamp("password_reset_expiry", { withTimezone: true }),
  preferredLanguage: supportedLanguageEnum("preferred_language").notNull().default("en"),
  // Task #1349 — Player's pinned baseline for the proximity-by-club chart
  // ("tour" | "scratch" | "mid" | "auto"). NULL or "auto" means: derive the
  // primary baseline automatically from the player's current handicap index
  // (≤4 → tour, ≤12 → scratch, otherwise mid-handicap).
  preferredProximityBaseline: text("preferred_proximity_baseline"),
  // Task #1643 — Player's pinned baseline for the strokes-gained chart
  // ("scratch" | "10" | "18" | "auto"). NULL or "auto" means: derive the
  // SG baseline automatically from the player's current handicap index
  // (≤4 → scratch, ≤12 → 10-hcp, otherwise 18-hcp; thresholds mirror
  // `pickPrimaryProximityBaseline`). Mirrors the auto-pick
  // + pin-override pattern used by `preferred_proximity_baseline` so the
  // SG numbers feel as personal as the proximity numbers.
  preferredSgBaseline: text("preferred_sg_baseline"),
  // Task #2048 — Last auto-derived SG baseline the player explicitly
  // acknowledged (or was implicitly initialized to on first stats fetch).
  // When the auto-derived baseline crosses a threshold (e.g. handicap
  // drops from 14.5 → 13.8 and the cohort moves from "18" → "10"), the
  // stats endpoint surfaces a one-time `baselineChange` notice so the
  // player can either acknowledge the move or pin the previous cohort
  // back. The dedicated POST `/portal/player/sg-baseline-change-ack`
  // endpoint advances this column to the current auto-derived value
  // (and optionally pins `preferred_sg_baseline`), so the notice doesn't
  // re-fire until the auto-pick crosses *another* threshold. Only
  // populated when `baselineSource === "handicap"` — players with no
  // handicap on file (source="default") never see the notice.
  lastSeenAutoSgBaseline: text("last_seen_auto_sg_baseline"),
  // Public player profile (Task #383) — opt-in, OFF by default
  publicHandle: text("public_handle"),
  publicProfileEnabled: boolean("public_profile_enabled").notNull().default(false),
  publicShowHandicap: boolean("public_show_handicap").notNull().default(true),
  publicShowRecentRounds: boolean("public_show_recent_rounds").notNull().default(true),
  publicShowAchievements: boolean("public_show_achievements").notNull().default(true),
  publicShowFavoriteCourses: boolean("public_show_favorite_courses").notNull().default(true),
  publicBio: text("public_bio"),
  publicLocation: text("public_location"),
  // Task #467: Tombstone written by the auto-erasure cron worker after the
  // 30-day cancellation grace window elapses. Once set the row is "erased":
  // - all PII fields above are scrubbed in the same transaction
  // - the OAuth login path MUST refuse to re-hydrate this row from claims
  //   (see routes/auth.ts upsertUser) so a re-login does not resurrect PII
  // The id + replit_user_id columns are kept so historical FK references
  // (scores, audits, payments) remain intact, but the account is no longer
  // usable for sign-in.
  erasedAt: timestamp("erased_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("app_users_email_idx").on(t.email),
  uniqueIndex("app_users_public_handle_unique").on(t.publicHandle),
]);

// ORG MEMBERSHIPS
export const orgMembershipsTable = pgTable("org_memberships", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  role: orgRoleEnum("role").notNull().default("player"),
  vendorOperatorId: integer("vendor_operator_id").references(() => vendorOperatorsTable.id, { onDelete: "set null" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("org_user_unique").on(t.organizationId, t.userId),
  index("org_memberships_vendor_idx").on(t.vendorOperatorId),
]);

// COURSES
export const coursesTable = pgTable("courses", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  location: text("location"),
  holes: integer("holes").notNull().default(18),
  par: integer("par").notNull().default(72),
  rating: numeric("rating", { precision: 4, scale: 1 }),
  slope: integer("slope"),
  yardage: integer("yardage"),
  externalCourseId: text("external_course_id"),
  // ── Task #384: public course page fields ─────────────────────────────
  slug: text("slug").notNull(),
  description: text("description"),
  heroImageUrl: text("hero_image_url"),
  designer: text("designer"),
  yearOpened: integer("year_opened"),
  awards: jsonb("awards").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  contactPhone: text("contact_phone"),
  contactEmail: text("contact_email"),
  teeTimeCtaUrl: text("tee_time_cta_url"),
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  isPublic: boolean("is_public").notNull().default(true),
  // ── Task #1312: remembered mapper centre ─────────────────────────────
  // Saved by the in-house course mapper when an admin picks a place
  // search result (or first saves geometry) so the next admin to open
  // the mapper for this course flies straight to the course instead of
  // starting at the world view. Kept separate from the course-level
  // `latitude`/`longitude` above (which feed weather correlation, the
  // public course page, etc.) so editing the mapper centre never moves
  // the course on those surfaces.
  mapDefaultLat: numeric("map_default_lat", { precision: 10, scale: 7 }),
  mapDefaultLng: numeric("map_default_lng", { precision: 10, scale: 7 }),
  mapDefaultZoom: integer("map_default_zoom"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("courses_org_slug_unique").on(t.organizationId, t.slug)]);

// HOLE DETAILS
export const holeDetailsTable = pgTable("hole_details", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  par: integer("par").notNull().default(4),
  handicap: integer("handicap"),
  yardageBlue: integer("yardage_blue"),
  yardageWhite: integer("yardage_white"),
  yardageRed: integer("yardage_red"),
  description: text("description"),
  greenFrontLat: numeric("green_front_lat", { precision: 10, scale: 7 }),
  greenFrontLng: numeric("green_front_lng", { precision: 10, scale: 7 }),
  greenCentreLat: numeric("green_centre_lat", { precision: 10, scale: 7 }),
  greenCentreLng: numeric("green_centre_lng", { precision: 10, scale: 7 }),
  greenBackLat: numeric("green_back_lat", { precision: 10, scale: 7 }),
  greenBackLng: numeric("green_back_lng", { precision: 10, scale: 7 }),
}, (t) => [uniqueIndex("course_hole_unique").on(t.courseId, t.holeNumber)]);

// TOURNAMENTS
export const tournamentsTable = pgTable("tournaments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id),
  name: text("name").notNull(),
  description: text("description"),
  format: tournamentFormatEnum("format").notNull().default("stroke_play"),
  status: tournamentStatusEnum("status").notNull().default("draft"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  rounds: integer("rounds").notNull().default(1),
  maxPlayers: integer("max_players"),
  entryFee: numeric("entry_fee", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  isPublic: boolean("is_public").notNull().default(false),
  membersOnly: boolean("members_only").notNull().default(false),
  memberEntryFee: numeric("member_entry_fee", { precision: 10, scale: 2 }),
  allowSpectators: boolean("allow_spectators").notNull().default(true),
  registrationDeadline: timestamp("registration_deadline", { withTimezone: true }),
  selfPosting: boolean("self_posting").notNull().default(false),
  allowSelfScoring: boolean("allow_self_scoring").notNull().default(false),
  markerValidation: boolean("marker_validation").notNull().default(false),
  handicapAllowance: integer("handicap_allowance").notNull().default(100),
  cutLine: integer("cut_line"),
  checkInCutoffAt: timestamp("check_in_cutoff_at", { withTimezone: true }),
  autoWelcome: boolean("auto_welcome").notNull().default(true),
  autoReminder: boolean("auto_reminder").notNull().default(true),
  autoResults: boolean("auto_results").notNull().default(false),
  reminderDaysBefore: integer("reminder_days_before"),
  mediaModerationEnabled: boolean("media_moderation_enabled").notNull().default(true),
  // Wave 1 W1-A: AI Caddie advice mode at the tournament level (open|distance_only|lockdown).
  aiCaddieMode: aiCaddieModeEnum("ai_caddie_mode").notNull().default("open"),
  autoPostWhs: boolean("auto_post_whs").notNull().default(false),
  notifyPairings: boolean("notify_pairings").notNull().default(true),
  // Task #1018 — per-tournament toggle for the manual-entry data-quality
  // alert (`notifyManualEntryRound`). Defaults to true so existing
  // tournaments keep firing the alert; directors of casual/social events
  // can switch it off without affecting their other notifications.
  notifyManualEntryAlerts: boolean("notify_manual_entry_alerts").notNull().default(true),
  // Task #1673 — sibling per-tournament toggles seeded at creation time
  // from the matching org-wide default in `organizations`. Notification
  // helpers should consult both the org-wide and per-tournament flag
  // (org-wide false short-circuits) before firing.
  notifyScheduleChanges: boolean("notify_schedule_changes").notNull().default(true),
  notifyScoreCorrections: boolean("notify_score_corrections").notNull().default(true),
  pairingsPublishedAt: timestamp("pairings_published_at", { withTimezone: true }),
  tiebreakerMethod: tiebreakerMethodEnum("tiebreaker_method").notNull().default("countback"),
  leaderboardType: leaderboardTypeEnum("leaderboard_type").notNull().default("both"),
  localRules: text("local_rules"),
  localRulesConfig: jsonb("local_rules_config").$type<{
    preferredLies?: boolean;
    preferredLiesRadius?: "6_inches" | "1_club";
    preferredLiesArea?: "fairways_only" | "through_green";
    reducedEsc?: boolean;
    reducedEscMax?: number;
    liftCleanPlace?: boolean;
    dropZones?: string;
    additionalNotes?: string;
  }>(),
  suspendReason: text("suspend_reason"),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  resumedAt: timestamp("resumed_at", { withTimezone: true }),
  courseConditions: text("course_conditions"),
  payoutStructure: jsonb("payout_structure").$type<{ position: number; percentage: number }[]>(),
  prizeDistributionStatus: text("prize_distribution_status"),
  eventType: text("event_type").notNull().default("standard"),
  scoringCloseTime: text("scoring_close_time"),
  stablefordPointsConfig: jsonb("stableford_points_config").$type<{
    eagle?: number;
    birdie?: number;
    par?: number;
    bogey?: number;
    double?: number;
    worse?: number;
  }>(),
  maxScoreCap: integer("max_score_cap"),
  cutAfterRound: integer("cut_after_round"),
  cutPosition: text("cut_position"),
  correctionWindowHours: integer("correction_window_hours").notNull().default(24),
  // Task #378 — live odds & prediction widgets gating (read-only, no gambling)
  oddsWidgetsEnabled: boolean("odds_widgets_enabled").notNull().default(true),
  predictionsEnabled: boolean("predictions_enabled").notNull().default(true),
  // Task #796 — persist 24h/1h tee-off reminder dispatch so a server restart
  // inside the polling window does not double-push every player.
  reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
  reminder1hSentAt: timestamp("reminder_1h_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// FLIGHTS (dedicated flight management per tournament)
export const flightsTable = pgTable("flights", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  handicapMin: numeric("handicap_min", { precision: 4, scale: 1 }),
  handicapMax: numeric("handicap_max", { precision: 4, scale: 1 }),
  teeBox: teeBoxEnum("tee_box"),
  maxPlayers: integer("max_players"),
  tiebreakerMethod: tiebreakerMethodEnum("tiebreaker_method"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// PLAYERS / REGISTRATIONS
export const playersTable = pgTable("players", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  handicapOverride: numeric("handicap_override", { precision: 4, scale: 1 }),
  ghinNumber: text("ghin_number"),
  flight: text("flight"),
  teeBox: teeBoxEnum("tee_box").default("white"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  stripePaymentId: text("stripe_payment_id"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  razorpayRefundId: text("razorpay_refund_id"),
  paymentLinkId: text("payment_link_id"),
  paymentLinkUrl: text("payment_link_url"),
  checkedIn: boolean("checked_in").notNull().default(false),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  dns: boolean("dns").notNull().default(false),
  teamName: text("team_name"),
  currentRound: integer("current_round").notNull().default(1),
  currentHole: integer("current_hole"),
  shareToken: text("share_token"),
  // Per-scorecard hide flag — owning user can hide a single round from public profile/scorecard URL (Task #383)
  publicHidden: boolean("public_hidden").notNull().default(false),
  // Task #1004 — Wave 2 cut tracking. When non-null, the player was cut from
  // the tournament at this timestamp by `applyCut` (lib/cutHandler.ts). The
  // leaderboard treats these players as `madeCut=false` regardless of any
  // recomputed cut math (so manual / persisted cuts always win).
  cutAt: timestamp("cut_at", { withTimezone: true }),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("players_share_token_unique").on(t.shareToken)]);

// PLAYER-FLIGHTS junction (player can be in multiple flights)
export const playerFlightsTable = pgTable("player_flights", {
  id: serial("id").primaryKey(),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  flightId: integer("flight_id").notNull().references(() => flightsTable.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("player_flight_unique").on(t.playerId, t.flightId)]);

// TEE TIMES / PAIRINGS
export const teeTimesTable = pgTable("tee_times", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  teeTime: timestamp("tee_time", { withTimezone: true }).notNull(),
  startingHole: integer("starting_hole").notNull().default(1),
  isManual: boolean("is_manual").notNull().default(false),
  spectatorTeeOffAlertedAt: timestamp("spectator_tee_off_alerted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// TEE TIME PLAYERS (join table)
export const teeTimePlayersTable = pgTable("tee_time_players", {
  id: serial("id").primaryKey(),
  teeTimeId: integer("tee_time_id").notNull().references(() => teeTimesTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
}, (t) => [uniqueIndex("tee_time_player_unique").on(t.teeTimeId, t.playerId)]);

// SCORES
export const scoresTable = pgTable("scores", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  holeNumber: integer("hole_number").notNull(),
  strokes: integer("strokes").notNull(),
  putts: integer("putts"),
  fairwayHit: boolean("fairway_hit"),
  girHit: boolean("gir_hit"),
  isVerified: boolean("is_verified").notNull().default(false),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("player_round_hole_unique").on(t.playerId, t.round, t.holeNumber)]);

// ROUND SUBMISSIONS (marker validation workflow)
export const roundSubmissionsTable = pgTable("round_submissions", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  markerPlayerId: integer("marker_player_id").references(() => playersTable.id),
  markerCode: text("marker_code"),
  markerShareToken: text("marker_share_token"),
  markerShareTokenExpiresAt: timestamp("marker_share_token_expires_at", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  totalStrokes: integer("total_strokes"),
  notes: text("notes"),
  rejectionReason: text("rejection_reason"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("player_round_submission_unique").on(t.playerId, t.round),
  uniqueIndex("round_submission_share_token_unique").on(t.markerShareToken),
]);

// LEAGUES
export const leaguesTable = pgTable("leagues", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id),
  name: text("name").notNull(),
  description: text("description"),
  format: leagueFormatEnum("format").notNull().default("stableford"),
  type: leagueTypeEnum("type").notNull().default("individual"),
  status: leagueStatusEnum("status").notNull().default("draft"),
  seasonStart: timestamp("season_start", { withTimezone: true }),
  seasonEnd: timestamp("season_end", { withTimezone: true }),
  maxMembers: integer("max_members"),
  entryFee: numeric("entry_fee", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  handicapAllowance: integer("handicap_allowance").default(100),
  pointsPerWin: integer("points_per_win").default(2),
  pointsPerDraw: integer("points_per_draw").default(1),
  pointsPerLoss: integer("points_per_loss").default(0),
  roundsCount: integer("rounds_count").default(1),
  isPublic: boolean("is_public").notNull().default(false),
  membersOnly: boolean("members_only").notNull().default(false),
  memberEntryFee: numeric("member_entry_fee", { precision: 10, scale: 2 }),
  oomPointsConfig: jsonb("oom_points_config").$type<number[]>(),
  mediaModerationEnabled: boolean("media_moderation_enabled").notNull().default(true),
  tiebreakerMethod: tiebreakerMethodEnum("tiebreaker_method").notNull().default("countback"),
  // Wave 1 W1-A: AI Caddie advice mode at the league level (open|distance_only|lockdown).
  aiCaddieMode: aiCaddieModeEnum("ai_caddie_mode").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// LEAGUE ROUNDS (each round links to a tournament event)
export const leagueRoundsTable = pgTable("league_rounds", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id),
  roundNumber: integer("round_number").notNull(),
  name: text("name"),
  scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
  status: text("status").notNull().default("upcoming"),
  pointsMultiplier: numeric("points_multiplier", { precision: 3, scale: 1 }).default("1.0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// LEAGUE DIVISIONS — multi-division support per league season
export const leagueDivisionsTable = pgTable("league_divisions", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  level: integer("level").notNull().default(1),
  promoteCount: integer("promote_count").notNull().default(0),
  relegateCount: integer("relegate_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("league_divisions_league_idx").on(t.leagueId)]);

// LEAGUE MEMBERS
export const leagueMembersTable = pgTable("league_members", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id),
  divisionId: integer("division_id").references(() => leagueDivisionsTable.id, { onDelete: "set null" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  teamName: text("team_name"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  razorpayRefundId: text("razorpay_refund_id"),
  paymentLinkId: text("payment_link_id"),
  paymentLinkUrl: text("payment_link_url"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("league_member_unique").on(t.leagueId, t.userId)]);

// LEAGUE STANDINGS (running totals per member)
export const leagueStandingsTable = pgTable("league_standings", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => leagueMembersTable.id, { onDelete: "cascade" }),
  roundsPlayed: integer("rounds_played").notNull().default(0),
  won: integer("won").notNull().default(0),
  drawn: integer("drawn").notNull().default(0),
  lost: integer("lost").notNull().default(0),
  totalPoints: integer("total_points").notNull().default(0),
  totalGross: integer("total_gross").notNull().default(0),
  totalNet: integer("total_net").notNull().default(0),
  totalStableford: integer("total_stableford").notNull().default(0),
  bestScore: integer("best_score"),
  position: integer("position"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("league_member_standing_unique").on(t.leagueId, t.memberId)]);

// SHOT TRACKING (GPS shot-by-shot)
export const shotTypeEnum = pgEnum("shot_type", ["tee", "fairway", "approach", "chip", "sand", "putt"]);

// Task #547 — explicit ingest source so the round map (and per-source
// analytics) can tell apart watch, phone auto-detect, manual entry, and
// scorer entry. Previously the map inferred "watch" from the presence of
// GPS coordinates, which wrongly bucketed phone-detected shots.
export const shotSourceEnum = pgEnum("shot_source", ["watch", "phone", "manual", "scorer"]);

export const shotsTable = pgTable("shots", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  generalPlayRoundId: integer("general_play_round_id").references(() => generalPlayRoundsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  holeNumber: integer("hole_number").notNull(),
  shotNumber: integer("shot_number").notNull().default(1),
  shotType: shotTypeEnum("shot_type").notNull().default("fairway"),
  club: text("club"),
  missDirection: text("miss_direction"),
  lieType: text("lie_type"),
  shotShape: text("shot_shape"),
  penaltyReason: text("penalty_reason"),
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  distanceToPin: numeric("distance_to_pin", { precision: 8, scale: 1 }),
  distanceCarried: numeric("distance_carried", { precision: 8, scale: 1 }),
  source: shotSourceEnum("source").notNull().default("manual"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shots_player_tournament_idx").on(t.playerId, t.tournamentId),
  index("shots_user_gp_idx").on(t.userId, t.generalPlayRoundId),
  // Task #851 — restore the "one shot per (player, tournament, round, hole,
  // shotNumber)" and corresponding general-play unique guards. The route
  // POST /portal/shots/detect commits with
  // `.onConflictDoNothing({ target: [...these columns] })`, which postgres
  // only honours when a non-partial unique constraint exists on those
  // exact columns. Migration 0059 dropped the older partial copies; these
  // declarations (mirrored by migration 0077) recreate them properly so
  // retried commits do not duplicate shots and the route's commit branch
  // does not 500.
  uniqueIndex("shots_player_tournament_round_hole_shot_unique").on(
    t.playerId, t.tournamentId, t.round, t.holeNumber, t.shotNumber,
  ),
  uniqueIndex("shots_user_gp_round_hole_shot_unique").on(
    t.userId, t.generalPlayRoundId, t.round, t.holeNumber, t.shotNumber,
  ),
]);

// SIDE GAMES CONFIG (per-tournament toggles for skins, CTP, LD, Greenies)
export const sideGamesConfigTable = pgTable("side_games_config", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }).unique(),
  skinsEnabled: boolean("skins_enabled").notNull().default(false),
  skinsPrize: text("skins_prize"),
  ctpEnabled: boolean("ctp_enabled").notNull().default(false),
  ctpHoles: jsonb("ctp_holes").$type<number[]>().default([]),
  ctpPrize: text("ctp_prize"),
  ldEnabled: boolean("ld_enabled").notNull().default(false),
  ldHoles: jsonb("ld_holes").$type<number[]>().default([]),
  ldPrize: text("ld_prize"),
  ctpSponsorId: integer("ctp_sponsor_id").references(() => sponsorsTable.id, { onDelete: "set null" }),
  ldSponsorId: integer("ld_sponsor_id").references(() => sponsorsTable.id, { onDelete: "set null" }),
  greeniesEnabled: boolean("greenies_enabled").notNull().default(false),
  greeniesPrize: text("greenies_prize"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// SIDE GAME RESULTS (manual CTP/LD/Greenie award + auto skins)
export const sideGameResultsTable = pgTable("side_game_results", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  gameType: text("game_type").notNull(),
  holeNumber: integer("hole_number"),
  round: integer("round").notNull().default(1),
  notes: text("notes"),
  prize: text("prize"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

// WAITLIST (players who registered when tournament was full)
export const waitlistTable = pgTable("waitlist", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  flight: text("flight"),
  teeBox: teeBoxEnum("tee_box").default("white"),
  position: integer("position").notNull(),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("waitlist_tournament_idx").on(t.tournamentId)]);

// MATCH RESULTS (Match Play bracket)
export const matchResultsTable = pgTable("match_results", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  player1Id: integer("player1_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  player2Id: integer("player2_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  winnerId: integer("winner_id").references(() => playersTable.id),
  result: text("result"),
  player1Holes: integer("player1_holes"),
  player2Holes: integer("player2_holes"),
  notes: text("notes"),
  isComplete: boolean("is_complete").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// LEAGUE FIXTURES (Round-robin schedule)
export const leagueFixturesTable = pgTable("league_fixtures", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  leagueRoundId: integer("league_round_id").references(() => leagueRoundsTable.id),
  roundNumber: integer("round_number").notNull().default(1),
  homeId: integer("home_id").notNull().references(() => leagueMembersTable.id, { onDelete: "cascade" }),
  awayId: integer("away_id").notNull().references(() => leagueMembersTable.id, { onDelete: "cascade" }),
  scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  result: text("result"),
  isPlayed: boolean("is_played").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// LEAGUE ROUND RESULTS (per-member scores for a league round)
export const leagueRoundResultsTable = pgTable("league_round_results", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  roundId: integer("round_id").notNull().references(() => leagueRoundsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => leagueMembersTable.id, { onDelete: "cascade" }),
  grossScore: integer("gross_score"),
  netScore: integer("net_score"),
  stablefordPoints: integer("stableford_points"),
  matchResult: text("match_result"),
  holeScores: jsonb("hole_scores").$type<Record<string, { strokes?: number; result?: string; points?: number }>>(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("league_round_member_unique").on(t.roundId, t.memberId)]);

// WITHDRAWALS — persisted withdrawal records with refund tracking
export const withdrawalsTable = pgTable("withdrawals", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerName: text("player_name").notNull(),
  playerEmail: text("player_email").notNull(),
  phone: text("phone"),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  flight: text("flight"),
  teeBox: text("tee_box"),
  entryFee: integer("entry_fee"),
  paymentStatus: text("payment_status"),
  paymentReference: text("payment_reference"),
  refundStatus: text("refund_status").notNull().default("pending"),
  refundReference: text("refund_reference"),
  refundNotes: text("refund_notes"),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }).notNull().defaultNow(),
  actorName: text("actor_name"),
}, (t) => [index("withdrawals_tournament_idx").on(t.tournamentId)]);

// ORG GHIN CREDENTIALS — per-org GHIN API secrets (encrypted at rest via pg row security)
export const orgGhinCredentialsTable = pgTable("org_ghin_credentials", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().unique().references(() => organizationsTable.id, { onDelete: "cascade" }),
  ghinApiKey: text("ghin_api_key").notNull(),
  ghinApiUsername: text("ghin_api_username").notNull(),
  ghinApiPassword: text("ghin_api_password").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// WHS POSTINGS — per-player WHS/GHIN score posting records
export const whsPostingStatusEnum = pgEnum("whs_posting_status", [
  "pending", "posted", "failed", "no_ghin",
]);

export const whsPostingsTable = pgTable("whs_postings", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  grossScore: integer("gross_score"),
  adjustedGrossScore: integer("adjusted_gross_score"),
  ghinNumber: text("ghin_number"),
  courseRating: numeric("course_rating", { precision: 4, scale: 1 }),
  slope: integer("slope"),
  status: whsPostingStatusEnum("status").notNull().default("pending"),
  ghinResponse: jsonb("ghin_response").$type<Record<string, unknown>>(),
  errorMessage: text("error_message"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("whs_postings_tournament_idx").on(t.tournamentId),
  index("whs_postings_player_idx").on(t.playerId),
  uniqueIndex("whs_posting_player_round_unique").on(t.tournamentId, t.playerId, t.round),
]);

// ECLECTIC SCORES VIEW — best score per player per hole across all rounds
export const eclecticScoresView = pgView("eclectic_scores_view").as((qb) =>
  qb
    .select({
      tournamentId: scoresTable.tournamentId,
      playerId: scoresTable.playerId,
      holeNumber: scoresTable.holeNumber,
      bestStrokes: sql<number>`MIN(${scoresTable.strokes})`.as("best_strokes"),
    })
    .from(scoresTable)
    .groupBy(scoresTable.tournamentId, scoresTable.playerId, scoresTable.holeNumber),
);

// INVITATIONS — tokenized invitation links for tournaments and leagues
export const invitationsTable = pgTable("invitations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  recipientEmail: text("recipient_email"),
  recipientPhone: text("recipient_phone"),
  recipientName: text("recipient_name"),
  channels: text("channels").array().notNull().default(sql`ARRAY[]::text[]`),
  status: text("status").notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("invitations_org_idx").on(t.organizationId), index("invitations_token_idx").on(t.token)]);

// MESSAGE LOGS — broadcast message history (email/SMS/WhatsApp/push)
export const messageLogsTable = pgTable("message_logs", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "cascade" }),
  subject: text("subject"),
  body: text("body").notNull(),
  channels: text("channels").array().notNull().default(sql`ARRAY[]::text[]`),
  recipientCount: integer("recipient_count").notNull().default(0),
  templateKey: text("template_key"),
  sentByUserId: integer("sent_by_user_id").references(() => appUsersTable.id),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull().default("sent"),
  /** Per-channel delivery outcomes: { email: { sent, failed }, push: { sent, failed }, sms: { sent, failed } } */
  deliveryStats: jsonb("delivery_stats").$type<Record<string, { sent: number; failed: number }>>(),
}, (t) => [index("message_logs_org_idx").on(t.organizationId)]);

// TOURNAMENT ANNOUNCEMENTS — live admin-to-player messages during active tournaments
export const tournamentAnnouncementsTable = pgTable("tournament_announcements", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  type: text("type").notNull().default("general"),
  authorName: text("author_name"),
  sentByUserId: integer("sent_by_user_id").references(() => appUsersTable.id),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("announcements_tournament_idx").on(t.tournamentId)]);

// MESSAGE TEMPLATES — reusable admin-composed message templates (per org)
export const messageTemplatesTable = pgTable("message_templates", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  type: text("type").notNull().default("general"),
  channels: jsonb("channels").$type<string[]>().notNull().default(["email"]),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("templates_org_idx").on(t.organizationId)]);

// ANNOUNCEMENT READ RECEIPTS — tracks which users have read each tournament announcement
export const announcementReadReceiptsTable = pgTable("announcement_read_receipts", {
  id: serial("id").primaryKey(),
  announcementId: integer("announcement_id").notNull(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("read_receipt_unique").on(t.announcementId, t.userId),
  index("read_receipt_ann_idx").on(t.announcementId),
  foreignKey({ name: "announcement_read_receipts_announcement_id_fk", columns: [t.announcementId], foreignColumns: [tournamentAnnouncementsTable.id] }).onDelete("cascade"),
]);

// ACHIEVEMENTS — gamification badge system
export const achievementsTable = pgTable("achievements", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  badgeType: text("badge_type").notNull(),
  badgeLabel: text("badge_label").notNull(),
  badgeIcon: text("badge_icon").notNull(),
  badgeCategory: text("badge_category").notNull().default("milestone"),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  earnedAt: timestamp("earned_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("achievements_user_idx").on(t.userId),
  uniqueIndex("achievement_user_badge_unique").on(t.userId, t.badgeType),
]);

// HANDICAP HISTORY — one record per tournament/round completed, for trend charts
export const handicapHistoryTable = pgTable("handicap_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }).notNull(),
  roundGross: integer("round_gross"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("handicap_history_user_idx").on(t.userId)]);

// WEARABLE CONNECTIONS — links to GPS/fitness devices (Garmin, Apple Watch, Fitbit, Arccos)
export const wearableConnectionsTable = pgTable("wearable_connections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  status: text("status").notNull().default("connected"),
  externalUserId: text("external_user_id"),
  /** OAuth access token (encrypted at rest in production; stored as-is in dev) */
  accessToken: text("access_token"),
  /** OAuth refresh token — used to renew access_token when expired */
  refreshToken: text("refresh_token"),
  /** OAuth token expiry; used to trigger refresh before API calls */
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  /** When this wearable connection was first authenticated */
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wearable_user_provider_unique").on(t.userId, t.provider),
  index("wearable_user_idx").on(t.userId),
]);

// WELLNESS SWEEP RUNS — append-only audit log of the hourly wellness-sweep
// background job (see `sweepWellnessConnections` in api-server). Persisting
// each run lets the admin dashboard show the latest result immediately after
// a server restart (instead of going blank for up to ~60 min until the next
// sweep ticks) and lets us draw a short trend chart of attempted / succeeded
// / needs_reauth counts. Older rows are pruned to ~90 days to keep the table
// bounded.
export const wellnessSweepRunsTable = pgTable("wellness_sweep_runs", {
  id: serial("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  attempted: integer("attempted").notNull(),
  succeeded: integer("succeeded").notNull(),
  needsReauth: integer("needs_reauth").notNull(),
  alerted: boolean("alerted").notNull().default(false),
}, (t) => [
  index("wellness_sweep_runs_ran_at_idx").on(t.ranAt),
]);

// Task #1578 — append-only audit log of admin "Acknowledge / snooze" clicks
// on the WoW drift tile. Each row captures who pushed the button, the org
// they pushed it for, the snooze duration they chose, and the watermark
// values before/after so a postmortem can reconstruct the sequence even if
// the live `wearable_reauth_wow_alert_last_sent_at` column on
// `organizations` has since been re-stamped by the cron evaluator.
//
// The latest row per org also drives the "Acknowledged by X on Y" line on
// the dashboard (the column-only pattern from Task #1501 would only show
// the most recent ack — admins want to see the trail).
export const wearableReauthWowAcknowledgmentsTable = pgTable("wearable_reauth_wow_acknowledgments", {
  id: serial("id").primaryKey(),
  // Auto-generated FK name (`<table>_<col>_<reftable>_<refcol>_fk`) clips
  // past Postgres's 63-char identifier limit on this long table name, so
  // we pin explicit short names below (see Task #805 / FK preflight).
  organizationId: integer("organization_id").notNull(),
  // Acting admin. Nullable references so deleting the user later doesn't
  // erase the audit trail (we still have the snapshotted name/role).
  acknowledgedByUserId: integer("acknowledged_by_user_id"),
  // Display name + role snapshotted at click time so the audit row reads
  // sensibly even after the user is renamed, role-changed, or deleted.
  acknowledgedByName: text("acknowledged_by_name"),
  acknowledgedByRole: text("acknowledged_by_role"),
  // The snooze duration the admin chose, in days. Constrained server-side
  // to 1..30; persisted as-is for the audit so postmortems can spot a
  // pattern of "always snoozed for 30 days".
  snoozeDays: integer("snooze_days").notNull(),
  // Watermark values before/after the bump. `prevWatermark` is null when
  // no drift email had ever been sent for this org before the click.
  prevWatermark: timestamp("prev_watermark", { withTimezone: true }),
  newWatermark: timestamp("new_watermark", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("wearable_reauth_wow_ack_org_created_idx").on(t.organizationId, t.createdAt),
  foreignKey({
    name: "wearable_reauth_wow_ack_org_id_fk",
    columns: [t.organizationId],
    foreignColumns: [organizationsTable.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "wearable_reauth_wow_ack_user_id_fk",
    columns: [t.acknowledgedByUserId],
    foreignColumns: [appUsersTable.id],
  }).onDelete("set null"),
]);
export type WearableReauthWowAcknowledgment = typeof wearableReauthWowAcknowledgmentsTable.$inferSelect;

// WELLNESS DAILY METRICS — recovery, sleep, HRV, steps aggregated per day per user.
// Sourced from Whoop, Garmin Connect, Apple Health, Google Fit (and any other
// connected wearable). One row per (user, date, source); the API also computes
// a per-day "best of" view across sources for the wellness dashboard and the
// pre-round readiness card.
export const wellnessDailyMetricsTable = pgTable("wellness_daily_metrics", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  /** Local date in YYYY-MM-DD — kept as text so timezone is implicit to the source */
  metricDate: text("metric_date").notNull(),
  /** Provider source: whoop | garmin | apple_health | google_fit | manual */
  source: text("source").notNull(),
  /** Whoop-style 0–100 recovery score; null when the source does not expose one */
  readinessScore: integer("readiness_score"),
  /** Sleep duration in minutes (total time asleep) */
  sleepMinutes: integer("sleep_minutes"),
  /** Sleep performance / efficiency 0–100 (Whoop, Garmin Body Battery, etc.) */
  sleepScore: integer("sleep_score"),
  /** Heart-rate variability in milliseconds (RMSSD) */
  hrvMs: numeric("hrv_ms", { precision: 5, scale: 1 }),
  /** Resting heart rate in bpm */
  restingHr: integer("resting_hr"),
  /** Daily step count */
  steps: integer("steps"),
  /** Active calories burned */
  activeCalories: integer("active_calories"),
  /** Whoop-style 0–21 strain score; Garmin training load if exposed */
  strainScore: numeric("strain_score", { precision: 4, scale: 1 }),
  /** Raw provider payload for debugging / future-proofing */
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wellness_daily_user_date_source_unique").on(t.userId, t.metricDate, t.source),
  index("wellness_daily_user_idx").on(t.userId, t.metricDate),
]);

// WELLNESS CONSENTS — per-user opt-ins for sharing wellness data with coaches,
// the club analytics dashboards, and the round leaderboard. Defaults to false:
// no health data leaves the player without explicit opt-in. Disconnecting a
// provider records a row here too (granted=false) so revocations are audited.
export const wellnessConsentsTable = pgTable("wellness_consents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  /** share_with_coach | share_with_club | show_on_leaderboard | export_csv */
  scope: text("scope").notNull(),
  granted: boolean("granted").notNull().default(false),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source"),
  ipAddress: text("ip_address"),
}, (t) => [
  uniqueIndex("wellness_consent_user_scope_unique").on(t.userId, t.scope),
  index("wellness_consent_user_idx").on(t.userId),
]);

// USER HEALTH PREFERENCES — per-user opt-in for HR/HRV capture from wearables.
// Health data is sensitive: capture is OFF by default and only enabled when the
// player explicitly opts in. Baseline HR is the resting HR used for the
// "elevated HR" correlation widget on the stats screen.
export const userHealthPrefsTable = pgTable("user_health_prefs", {
  userId: integer("user_id").primaryKey().references(() => appUsersTable.id, { onDelete: "cascade" }),
  hrCaptureEnabled: boolean("hr_capture_enabled").notNull().default(false),
  baselineHrBpm: integer("baseline_hr_bpm"),
  // Task #946 — trailing-round window the wellness dashboard's scoring-average
  // overlay should average over (3 / 5 / 10 / 20). Persisted server-side so the
  // player's choice follows them across devices and reinstalls. Nullable means
  // "use the app default (5)".
  wellnessTrailingWindow: integer("wellness_trailing_window"),
  // Task #1091 — visible range (in days) the wellness dashboard renders for
  // the readiness/sleep/HRV/RHR charts. Allowed values: 30 / 60 / 90.
  // Persisted on the user's profile so the choice follows them across devices
  // (mirrors the trailing-window pattern above). Nullable means "use the app
  // default (30)".
  wellnessRangeDays: integer("wellness_range_days"),
  consentedAt: timestamp("consented_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// HR / STRESS SAMPLES — per-shot/per-hole heart-rate (and HRV-derived stress)
// samples streamed from the watch during a round. Samples are tagged to
// (tournament|generalPlayRound, round, holeNumber, shotNumber) so the mobile
// app can render per-hole HR strips and per-round heat-strips, and the stats
// screen can correlate elevated HR with scoring.
export const hrSamplesTable = pgTable("hr_samples", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  generalPlayRoundId: integer("general_play_round_id").references(() => generalPlayRoundsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  holeNumber: integer("hole_number"),
  shotNumber: integer("shot_number"),
  hrBpm: integer("hr_bpm").notNull(),
  hrvMs: numeric("hrv_ms", { precision: 6, scale: 2 }),
  /** Stress score 0-100 derived on-watch from HRV (Garmin/Apple Health style). */
  stressScore: integer("stress_score"),
  source: text("source").notNull().default("apple_watch"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("hr_samples_user_round_idx").on(t.userId, t.tournamentId, t.round),
  index("hr_samples_user_gp_idx").on(t.userId, t.generalPlayRoundId, t.round),
  index("hr_samples_user_recorded_idx").on(t.userId, t.recordedAt),
]);

// ACTIVE HR-CAPTURE SESSIONS — shared cross-instance marker that the watch's
// HR-sample ingest endpoint uses to refuse stragglers from an abandoned round
// (Task #717 / #874 / #1025). The phone bridge upserts a row on hrStart with
// `expiresAt = now() + TTL` and deletes it on hrStop; each accepted batch
// refreshes the TTL. Lives in shared storage (Postgres) instead of an
// in-memory per-process Map so a session opened on instance A is visible to
// instance B in a multi-instance deployment.
export const hrActiveSessionsTable = pgTable("hr_active_sessions", {
  userId: integer("user_id").primaryKey().references(() => appUsersTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// DEVICE TOKENS — Expo push notification device tokens per user
export const deviceTokensTable = pgTable("device_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  platform: text("platform").notNull().default("expo"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("device_token_user_unique").on(t.userId, t.token)]);

// USER NOTIFICATION PREFERENCES — per-user channel preferences for push/email notifications
export const userNotificationPrefsTable = pgTable("user_notification_prefs", {
  userId: integer("user_id").primaryKey().references(() => appUsersTable.id, { onDelete: "cascade" }),
  preferEmail: boolean("prefer_email").notNull().default(true),
  preferPush: boolean("prefer_push").notNull().default(true),
  preferSms: boolean("prefer_sms").notNull().default(false),
  preferWhatsapp: boolean("prefer_whatsapp").notNull().default(false),
  // Staff-only opt-out: when false, this user does not receive
  // member_document_pending email/push alerts. Defaults to true so the
  // existing behaviour is preserved for everyone.
  notifyMemberDocuments: boolean("notify_member_documents").notNull().default(true),
  // Task #754 — committee-only opt-out: when false, this user is skipped by
  // `sendCommitteePeerResponsesDigests` (the daily peer-response digest
  // email). Real-time push + inbox delivery is unaffected. Defaults to true
  // so existing committee members keep receiving the digest.
  notifyCommitteePeerDigest: boolean("notify_committee_peer_digest").notNull().default(true),
  // Task #962 — per-event-type opt-out for the side-game settlement-paid
  // recipient receipt email (`sendSideGameSettlementReceiptEmail`). Lets a
  // member who still wants other club billing emails (levy receipts,
  // statements) silence just the casual side-game receipts. Defaults to
  // true so existing recipients keep receiving them. Only the email channel
  // is gated by this flag — the in-app inbox row and push notification are
  // unaffected.
  notifySideGameReceipts: boolean("notify_side_game_receipts").notNull().default(true),
  // Task #1018 — per-user opt-out for the manual-entry data-quality alert
  // (`notifyManualEntryRound`). Defaults to true so existing TDs keep
  // receiving the alert; lets a director who finds the alert noisy on
  // social leagues silence it without affecting other notifications.
  notifyManualEntryAlerts: boolean("notify_manual_entry_alerts").notNull().default(true),
  // Task #1224 — per-user opt-out for the admin "coach payout account
  // created/updated" security alert (`notifyOrgAdminsCoachPayoutAccountChanged`,
  // added in Task #1060). Defaults to true so existing org admins keep
  // receiving the alert; lets an admin who finds it noisy mute just this
  // one event without silencing other admin emails or flipping the global
  // digest mode. Honoured even when digest mode is on — false means
  // audit-only (no per-event email AND no digest enqueue).
  notifyCoachPayoutAccountChanges: boolean("notify_coach_payout_account_changes").notNull().default(true),
  // Task #1724 — per-event opt-out for the courtesy email a coach receives
  // when an organisation admin manually re-verifies their payout account
  // (`sendCoachPayoutAccountReverifiedByAdminEmail`, added in Task #1428).
  // Until now the only switch was the broader `billing` comm-prefs opt-out,
  // which also silences payout receipts and the cron-side
  // needs-attention email — far more than coaches who only want to mute
  // the admin courtesy notice. Mirrors the per-event pattern admins got
  // for the inverse direction (`notifyCoachPayoutAccountChanges`,
  // Task #1224). Defaults to true so existing coaches keep receiving the
  // notice; setting it false skips just the admin-triggered courtesy
  // email and leaves every other payout-related notification intact.
  notifyAdminPayoutReverify: boolean("notify_admin_payout_reverify").notNull().default(true),
  // Task #2150 — per-event opt-out for the security heads-up email sent
  // by `sendSocialLinkAddedSecurityEmail` (added in Task #1736) when an
  // Apple or Google sign-in identity is freshly attached to the player's
  // KHARAGOLF account via `POST /api/portal/me/social-links/:provider`
  // in `routes/wave3.ts`. Until now the alert always sent — Task #1736
  // intentionally bypassed the broader `privacy` comm-prefs opt-out so
  // a hijacker couldn't pre-mute the alert by flipping the umbrella
  // category before attaching their own provider. That trade-off
  // suppresses noise for the typical user but punishes power users who
  // link/unlink frequently (e.g. during testing). This per-event flag
  // lets THEM mute just this one notice while the umbrella `privacy`
  // category stays out of the picture entirely. Defaults to true so
  // every existing player keeps receiving the heads-up unless they
  // explicitly silence it from the Communications preferences page.
  notifySocialLinkAdded: boolean("notify_social_link_added").notNull().default(true),
  // Task #1075 — per-user opt-out for the "your data export expires in ~24h"
  // reminder (see `sendDataExportExpiringReminders` and
  // `sendDataExportPurgeReminders`). When false, the daily reminder cron
  // skips this member's outstanding access exports and counts them on the
  // `suppressed` log line instead. Defaults to true so existing members
  // continue to receive the helpful nudge unless they explicitly opt out.
  // The in-app message and email for the original "ready" notice are
  // unaffected — this only silences the *follow-up* reminder.
  notifyDataExportExpiring: boolean("notify_data_export_expiring").notNull().default(true),
  // Task #1242 — per-user opt-out for the daily controller digest of stuck
  // erasure cleanups (`sendErasureStorageFailuresDigest`, added in Task
  // #1078). The digest goes to every org_admin / membership_secretary /
  // treasurer on an org; this flag lets a controller (e.g. a treasurer
  // who only cares about finance) silence just this email without
  // affecting other org-admin notifications. Defaults to true so existing
  // controllers keep receiving the digest. The cron skips opted-out
  // recipients and counts them on a separate `suppressed` log field
  // instead of `recipientsEmailed`. Honoured via either the in-portal
  // toggle or the one-click List-Unsubscribe link in the email itself.
  notifyErasureStorageDigest: boolean("notify_erasure_storage_digest").notNull().default(true),
  // Task #1449 — per-user opt-out for the IN-APP / PUSH side of the same
  // "stuck erasure cleanup" digest above. Task #1241 wired the digest into
  // the in-app inbox + push channel via the
  // `privacy.erasure.storage_failures.controller_digest` registry key with
  // `defaultChannels: ["push"]`. Until now both channels were silenced by a
  // single flag (`notifyErasureStorageDigest`), so a controller who wanted
  // to keep the email but mute the daily push had no way to do so. Splitting
  // the opt-out lets each controller pick their own channels — email-only,
  // push-only, both, or none. The cron's email path keeps honouring
  // `notifyErasureStorageDigest`; the dispatcher's per-event opt-out
  // (`PER_EVENT_OPT_OUT_COLUMNS` in `notifyDispatch.ts`) honours this
  // column. Defaults to true so existing controllers keep receiving the
  // in-app row + push unless they explicitly opt out.
  notifyErasureStorageDigestPush: boolean("notify_erasure_storage_digest_push").notNull().default(true),
  // Task #1776 — Rate-limit watermark for the one-time confirmation email
  // sent when a controller mutes the stuck-erasure digest from the in-portal
  // toggle (PATCH /portal/notification-preferences). Each transition of
  // `notifyErasureStorageDigest` (email) or `notifyErasureStorageDigestPush`
  // (push) from true→false triggers the confirmation, but only when the
  // watermark is older than the throttle window (default 5 minutes) so a
  // controller who quickly toggles off → on → off doesn't get spammed. The
  // PATCH handler stamps this column AFTER a confirmation send actually
  // succeeds; a re-send is suppressed (audit-only) when `now - watermark <
  // throttle`. The same column gates both channels because the confirmation
  // email already covers them in a single message — there's no need for
  // independent per-channel rate-limit slots.
  notifyErasureStorageDigestMuteConfirmationLastSentAt: timestamp(
    "notify_erasure_storage_digest_mute_confirmation_last_sent_at",
    { withTimezone: true },
  ),
  // Task #1489 — per-user opt-out for the monthly per-org "member
  // notification preferences" CSV controller digest. The cron emails
  // org_admins / membership_secretaries / treasurers a downloadable
  // snapshot of every member's per-channel and per-category notify
  // preferences once a month so finance / outreach can audit who is
  // opted in to what without logging in. Mirrors the email-side
  // semantics of `notifyErasureStorageDigest` above (Task #1242):
  // defaults to true so existing controllers keep receiving the digest;
  // the cron skips opted-out recipients and counts them on a separate
  // `suppressed` log field instead of `recipientsEmailed`. Honoured via
  // either the in-portal toggle or the one-click List-Unsubscribe link
  // in the email itself (token prefix `mpd1:` in
  // `bouncedDigestUnsubscribe.ts`).
  notifyMemberPrefsDigest: boolean("notify_member_prefs_digest").notNull().default(true),
  // Task #1429 — per-user opt-out for the admin "wallet auto-refund digest
  // failed/paused" alert (`wallet.refund.digest.failed`, dispatched from
  // `routes/side-games-v2.ts` via `dispatchNotification`). Lets an admin
  // who finds the alert noisy mute just this one event without silencing
  // the rest of their admin email/push, and without flipping the global
  // digest mode. Honoured even when digest mode is on — false means
  // audit-only (no per-event push/email AND no digest enqueue), mirroring
  // the per-event opt-out shipped for the coach payout-account alert in
  // Task #1224.
  notifyWalletRefundDigestFailed: boolean("notify_wallet_refund_digest_failed").notNull().default(true),
  // Task #1429 — per-user opt-out for the admin "stuck side-game receipts
  // digest failed/paused" alert (`side_game.receipt.digest.failed`,
  // dispatched from `routes/side-games-v2.ts` via `dispatchNotification`).
  // Same audit-only short-circuit semantics as
  // `notifyWalletRefundDigestFailed` above.
  notifySideGameReceiptDigestFailed: boolean("notify_side_game_receipt_digest_failed").notNull().default(true),
  // Task #1762 — per-user opt-out for the admin "per-levy ledger CSV
  // digest failed/paused" alert (`levy.ledger.digest.failed`, dispatched
  // from `runOneLevyLedgerEmailSchedule` in `routes/member-360.ts` via
  // `dispatchNotification`, registered in Task #1444). Same audit-only
  // short-circuit semantics as `notifyWalletRefundDigestFailed` above —
  // false means audit-only (no per-event push/email AND no digest
  // enqueue) so an admin who watches the run history dashboard can mute
  // the email noise without losing the audit trail. Defaults to true so
  // existing admins/treasurers/membership_secretaries keep receiving
  // the alerts unless they explicitly opt out.
  notifyLevyLedgerDigestFailed: boolean("notify_levy_ledger_digest_failed").notNull().default(true),
  // Task #1762 — per-user opt-out for the admin "club-wide combined levy
  // ledger CSV digest failed/paused" alert (`levy.ledger.org.digest.failed`,
  // dispatched from `runOneOrgLevyLedgerEmailSchedule` in
  // `routes/member-360.ts`, registered in Task #1444). Independent of
  // the per-levy variant above so admins can mute one without the other
  // (e.g. the org-wide digest is the noisier of the two).
  notifyLevyLedgerOrgDigestFailed: boolean("notify_levy_ledger_org_digest_failed").notNull().default(true),
  // Task #1762 — per-user opt-out for the admin "bounced-levy reminders
  // digest failed/paused" alert (`levy.reminders.digest.failed`,
  // dispatched from `sendBouncedLevyRemindersDigest` in `lib/cron.ts`,
  // registered in Task #1444). Recipients are derived dynamically from
  // org_admin / treasurer / membership_secretary roles so there is no
  // schedule row to mutate — the cron only filters and alerts. Same
  // audit-only short-circuit semantics as the two above.
  notifyLevyRemindersDigestFailed: boolean("notify_levy_reminders_digest_failed").notNull().default(true),
  // Task #1663 — per-user opt-out for the weekly super-admin "silent
  // failures" CSV digest (`sendSilentAlertsDigestToSuperAdmins`). The
  // cron emails every super_admin a CSV of the previous 7 days of
  // zero-delivery manual-entry alerts so ops can spot recipient
  // inboxes / device tokens that aren't getting through. Defaults to
  // true so existing super admins keep receiving the digest; the cron
  // skips opted-out recipients and counts them on the dispatch log.
  // Mirrors the email-side opt-out semantics of
  // `notifyMemberPrefsDigest` (Task #1489) and
  // `notifyErasureStorageDigest` (Task #1242).
  notifySilentAlertsDigest: boolean("notify_silent_alerts_digest").notNull().default(true),
  // Task #1855 — per-user opt-out for the super-admin fallback alert
  // (`notify.exhaustion.admin_digest.failed`, dispatched from
  // `sendNotifyExhaustionAdminDigest` in `lib/cron.ts`) emitted when
  // every admin recipient for an org bounces / is on the suppression
  // list / fails the SMTP send. Defaults to true so existing super
  // admins keep receiving the alert unless they explicitly opt out,
  // mirroring `notifySilentAlertsDigest` (Task #1663).
  notifyExhaustionAdminDigestFailed: boolean("notify_exhaustion_admin_digest_failed").notNull().default(true),
  // Task #2040 — per-player opt-out for the daily "you closed the gap"
  // coaching encouragement push (`coaching.gap.closed`, dispatched from
  // `runCoachingGapClosedDailySweep` in `lib/cron.ts`). The push fires
  // when a player's proximity-vs-tour trend on a club has shrunk by at
  // least 1.5 ft between the prior 30-day window and the current 30-day
  // window — the same threshold (`TREND_ENCOURAGEMENT_FT`) the AI Caddie
  // uses to flip its hint to encouragement. Defaults to true so players
  // see the nudge unless they explicitly mute it; honoured via the
  // dispatcher's `PER_EVENT_OPT_OUT_COLUMNS` map so a `false` value
  // short-circuits the push to audit-only without affecting the
  // global `preferPush` toggle.
  notifyCoachingTipClosed: boolean("notify_coaching_tip_closed").notNull().default(true),
  // Task #1005 — Digest mode. When true, notifications whose registry spec
  // has `digestable = true` are queued into `notification_digest_queue`
  // instead of dispatched immediately. A daily cron drains the queue and
  // sends one summary email per user. Transactional/non-digestable types
  // (booking confirmations, payment receipts, etc.) are still sent
  // immediately so urgent comms are never delayed.
  digestMode: boolean("digest_mode").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Task #1170 — Per-notification-key delivery preference. Lets a user pick
// whether each digestable notification key is sent in real-time or batched
// into the daily digest, overriding the global `digestMode` flag for that
// key only. Absence of a row means "fall back to global digestMode".
//
// Only digestable keys (per `notification_type_registry.digestable`) ever
// produce rows here — the dispatcher never reads this table for
// non-digestable keys, since they always send immediately anyway.
//
// `deliveryMode` is a free text column with an application-level enum
// (`'realtime' | 'digest'`); we use text rather than a pg enum so adding
// future modes (e.g. `'weekly'`) does not require a destructive migration.
export const userNotificationKeyPrefsTable = pgTable("user_notification_key_prefs", {
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  notificationKey: text("notification_key").notNull(),
  deliveryMode: text("delivery_mode").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "user_notification_key_prefs_pkey", columns: [t.userId, t.notificationKey] }),
  index("user_notification_key_prefs_user_idx").on(t.userId),
  // Defense-in-depth: even though the API validates `delivery_mode`, a
  // CHECK constraint stops out-of-band writes (psql, ad-hoc scripts)
  // from inserting a value the dispatcher would silently treat as
  // "fall back to global digestMode".
  check("user_notification_key_prefs_delivery_mode_chk",
    sql`${t.deliveryMode} IN ('realtime', 'digest')`),
]);
export type UserNotificationKeyPref = typeof userNotificationKeyPrefsTable.$inferSelect;

// Task #2219 — Rate-limit watermarks for the per-digest "you just muted
// this from the portal" confirmation emails. Task #1776 introduced this
// safety-net pattern for the stuck-erasure digest only, with its
// watermark living on `userNotificationPrefs` directly
// (`notifyErasureStorageDigestMuteConfirmationLastSentAt`). Extending
// the same pattern to the wallet-refund / side-game-receipt /
// levy-ledger / levy-reminders / exhaustion-admin / silent-alerts
// digests would otherwise mean adding 6+ near-identical watermark
// columns to the prefs row. We use a side table keyed on
// `(user_id, digest_slug)` instead so future digests join the registry
// without another schema migration. The existing erasure column stays
// where it is — its tests, audit history, and rate-limit behaviour are
// already in production and there's no upside to migrating it across.
//
// One row per (user, digest) means the controller has been emailed
// confirmation for that digest at least once; the timestamp is checked
// against the throttle window (5 minutes by default, mirroring
// `ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS`) to suppress a re-send
// from a quick toggle off→on→off in the same session. Stamped only AFTER
// a successful send so a transient mailer outage doesn't poison the
// next genuine attempt.
export const portalDigestMuteConfirmationSendsTable = pgTable("portal_digest_mute_confirmation_sends", {
  userId: integer("user_id").notNull(),
  // Short opcode that maps to the boolean column on
  // `user_notification_prefs` plus the per-digest mailer + revert URL —
  // see `PORTAL_DIGEST_MUTE_REGISTRY` in
  // `artifacts/api-server/src/lib/portalDigestMuteRegistry.ts`. We
  // carry the slug rather than the full pref column name so the table
  // stays narrow and so a future renamed column keeps working as long
  // as the registry is updated in lockstep.
  digestSlug: text("digest_slug").notNull(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull(),
}, (t) => [
  primaryKey({ name: "portal_digest_mute_confirmation_sends_pkey", columns: [t.userId, t.digestSlug] }),
  // Explicit FK name matches the constraint as it was created by
  // `lib/db/drizzle/0156_portal_digest_mute_confirmation_sends.sql`.
  // Drizzle's auto-name (`..._user_id_app_users_id_fk`, 61 chars)
  // would otherwise diff against the migration name on every sync,
  // surfacing as a destructive DROP+ADD constraint pair that blocks
  // post-merge setup. Following the same explicit-name pattern as
  // `bouncedDigestScheduleOptOutsTable` immediately below.
  foreignKey({
    name: "portal_digest_mute_confirmation_sends_user_id_fk",
    columns: [t.userId],
    foreignColumns: [appUsersTable.id],
  }).onDelete("cascade"),
]);
export type PortalDigestMuteConfirmationSend = typeof portalDigestMuteConfirmationSendsTable.$inferSelect;

// Task #387 — per-recipient opt-out for the "bounced-reminders digest schedule
// changed" heads-up email (added in Task #319). One row per (org, user) means
// that user no longer receives schedule-change notifications for that org;
// the regular digest itself is unaffected.
export const bouncedDigestScheduleOptOutsTable = pgTable("bounced_digest_schedule_opt_outs", {
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("bounced_digest_schedule_opt_out_unique").on(t.organizationId, t.userId),
  foreignKey({ name: "bounced_digest_schedule_opt_outs_organization_id_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

// Task #513 — audit trail of bounced-digest schedule-change emails actually
// dispatched to admins (recipients + timestamp). Lets the club-settings UI
// show "last sent at … to N people" alongside the opt-out list. One row per
// successful send (the per-org throttle and "no recipients" path skip the
// insert, so duplicates do not occur).
export const bouncedDigestScheduleSendsTable = pgTable("bounced_digest_schedule_sends", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  // The admin whose save triggered the heads-up. Set NULL if the user is
  // later deleted so the audit row survives.
  changedByUserId: integer("changed_by_user_id"),
  // Snapshot of who actually received the email at send time (display name +
  // email captured even if the user later changes their profile / leaves).
  recipients: jsonb("recipients").$type<Array<{
    userId: number;
    email: string;
    displayName: string;
  }>>().notNull().default(sql`'[]'::jsonb`),
  // Task #813 — Per-(org, sendId) cooldown for the on-demand resend endpoint.
  // The resend path atomically claims this column via a conditional UPDATE
  // before dispatching emails so a rapid second click is rejected with 429.
  // NULL means "never resent" (the row was created by the original send).
  lastResendAt: timestamp("last_resend_at", { withTimezone: true }),
}, (t) => [
  index("bounced_digest_schedule_sends_org_sent_idx").on(t.organizationId, t.sentAt),
  // Explicit short FK names: the auto-generated names exceed Postgres's
  // 63-char identifier limit and get truncated, which causes endless
  // drift-check churn (drizzle keeps re-emitting them).
  foreignKey({ name: "bounced_digest_schedule_sends_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "bounced_digest_schedule_sends_user_fk", columns: [t.changedByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

// Task #1045 — per-recipient opt-out for the round-robin tie-break required
// alert email (added in Task #898). One row per (org, user) means that user
// no longer receives the tie-break email for that org via
// `sendRoundRobinTieBreakAlertEmail`. Push + in-app inbox are unaffected.
export const roundRobinTieBreakEmailOptOutsTable = pgTable("round_robin_tie_break_email_opt_outs", {
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("rr_tie_break_email_opt_out_unique").on(t.organizationId, t.userId),
  foreignKey({ name: "rr_tie_break_email_opt_outs_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

// MEDIA — photos and videos uploaded for tournaments or leagues
export const mediaTable = pgTable("media", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "cascade" }),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  uploaderName: text("uploader_name"),
  objectPath: text("object_path").notNull(),
  thumbnailPath: text("thumbnail_path"),
  mediaType: text("media_type").notNull().default("image"),
  // True duration of an uploaded video, in whole seconds (rounded up).
  // NULL for images and legacy rows uploaded before Task #703.
  durationSeconds: integer("duration_seconds"),
  // Task #1327: timestamp of the most recent re-probe attempt (manual
  // admin "Re-check" or background cron) for a legacy video whose
  // duration we couldn't measure. Bumped by both the manual endpoint
  // (POST .../media/:mediaId/recheck-duration) and the
  // recheckLegacyVideoDurations cron — the per-row backoff in the cron
  // reads this column so a single row isn't re-probed more than once a
  // day.
  durationLastCheckedAt: timestamp("duration_last_checked_at", { withTimezone: true }),
  // Task #1584: number of consecutive background cron re-probe attempts
  // that have failed without producing a duration. Bumped by the cron;
  // reset to 0 when the probe finally succeeds (manual or auto). Once
  // it crosses LEGACY_VIDEO_AUTO_RETRY_CAP the row is flagged via
  // duration_unverifiable_reason and stops being auto-retried.
  durationAutoRecheckCount: integer("duration_auto_recheck_count").notNull().default(0),
  // Task #1584: set by the cron once the auto-retry cap is reached so
  // the row stops being retried forever. Surfaced on the admin
  // "unverifiable videos" page as the reason the cron gave up:
  //   'object_missing'           — storage returned ObjectNotFoundError
  //                                on the most recent attempt; the file
  //                                was deleted from the bucket.
  //   'permanently_unverifiable' — ffprobe consistently could not read
  //                                a duration (corrupt file, no video
  //                                stream, etc.).
  // Cleared back to NULL when a recheck eventually recovers the row.
  durationUnverifiableReason: text("duration_unverifiable_reason"),
  // Task #1975 — timestamp of the digest email that notified org admins
  // about this row being auto-flagged as unverifiable. Stamped by the
  // recheckLegacyVideoDurations cron the moment a row crosses the
  // auto-retry cap and the digest pass selects it for inclusion. Used
  // to dedup so the same row isn't included in a subsequent pass's
  // digest if a clear/re-flag race somehow re-trips it. NULL means
  // the row's auto-flag has not yet been emailed about (either it
  // was flagged before the digest existed or it was just flagged this
  // pass and the digest send is in progress).
  durationFlagNotifiedAt: timestamp("duration_flag_notified_at", { withTimezone: true }),
  // Task #1597 — timestamp of the most recent re-upload nudge email
  // sent for this row (per-row endpoint or bulk endpoint). Used by the
  // bulk-request-reupload endpoint to:
  //   * de-duplicate by uploader within a single call (one email per
  //     uploader, listing all of their selected videos), and
  //   * rate-limit per uploader across calls — we look at MAX(this)
  //     for the uploader's rows in the org and refuse a fresh nudge
  //     within REUPLOAD_REQUEST_COOLDOWN_HOURS of that timestamp.
  // NULL means no nudge has ever been sent for this row.
  lastReuploadRequestAt: timestamp("last_reupload_request_at", { withTimezone: true }),
  caption: text("caption"),
  approved: boolean("approved").notNull().default(false),
  // ── Task #384: course-attached photos (gallery + per-hole) ───────────
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number"),
  isHero: boolean("is_hero").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("media_tournament_idx").on(t.tournamentId),
  index("media_league_idx").on(t.leagueId),
  index("media_org_idx").on(t.organizationId),
  index("media_course_idx").on(t.courseId),
  index("media_course_hole_idx").on(t.courseId, t.holeNumber),
  // Task #1584: partial index that backs the recheckLegacyVideoDurations
  // cron's "find next batch of in-flight rows" query. Restricted to
  // legacy NULL-duration video rows the cron hasn't yet given up on so
  // it stays cheap as the media table grows.
  index("media_legacy_video_recheck_idx")
    .on(t.durationLastCheckedAt)
    .where(sql`${t.mediaType} = 'video' AND ${t.durationSeconds} IS NULL AND ${t.durationUnverifiableReason} IS NULL`),
]);

// CHAT ROOMS — one per tournament or league
export const chatRoomsTable = pgTable("chat_rooms", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  entityId: integer("entity_id").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  mutedUserIds: jsonb("muted_user_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chat_room_entity_unique").on(t.organizationId, t.type, t.entityId),
  index("chat_room_org_idx").on(t.organizationId),
]);

// CHAT MESSAGES — messages in a chat room
export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id").notNull().references(() => chatRoomsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  displayName: text("display_name").notNull(),
  body: text("body").notNull(),
  messageType: text("message_type").notNull().default("text"),
  mediaId: integer("media_id").references(() => mediaTable.id, { onDelete: "set null" }),
  reactions: jsonb("reactions").$type<Record<string, number[]>>().notNull().default(sql`'{}'::jsonb`),
  isPinned: boolean("is_pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("chat_messages_room_idx").on(t.roomId),
]);

// ─── MEMBERSHIP TIERS ────────────────────────────────────────────────────────
export const memberSubscriptionStatusEnum = pgEnum("member_subscription_status", [
  "active", "past_due", "cancelled", "expired", "pending",
]);

export const membershipTiersTable = pgTable("membership_tiers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  annualFee: numeric("annual_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  billingPeriod: text("billing_period").notNull().default("annual"),
  currency: text("currency").notNull().default("INR"),
  gracePeriodDays: integer("grace_period_days").notNull().default(14),
  razorpayPlanId: text("razorpay_plan_id"),
  isActive: boolean("is_active").notNull().default(true),
  /** Discount percentage for shop purchases (all categories) — e.g. 15 = 15% off */
  shopDiscountPct: numeric("shop_discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  /** Per-category discount overrides (JSON map of category → pct) */
  shopCategoryDiscounts: jsonb("shop_category_discounts").$type<Record<string, number>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("membership_tiers_org_idx").on(t.organizationId)]);

export const clubMembersTable = pgTable("club_members", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tierId: integer("tier_id").references(() => membershipTiersTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  memberNumber: text("member_number"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  dateOfBirth: timestamp("date_of_birth", { withTimezone: true }),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  whsGhinNumber: text("whs_ghin_number"),
  joinDate: timestamp("join_date", { withTimezone: true }).notNull().defaultNow(),
  renewalDate: timestamp("renewal_date", { withTimezone: true }),
  showInDirectory: boolean("show_in_directory").notNull().default(true),
  subscriptionStatus: memberSubscriptionStatusEnum("subscription_status").notNull().default("pending"),
  inviteToken: text("invite_token"),
  inviteTokenExpiry: timestamp("invite_token_expiry", { withTimezone: true }),
  pendingMemberLink: boolean("pending_member_link").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("club_members_org_idx").on(t.organizationId),
  index("club_members_email_idx").on(t.email),
]);

export const memberSubscriptionsTable = pgTable("member_subscriptions", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tierId: integer("tier_id").references(() => membershipTiersTable.id, { onDelete: "set null" }),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  razorpayPlanId: text("razorpay_plan_id"),
  status: memberSubscriptionStatusEnum("status").notNull().default("pending"),
  nextBillingDate: timestamp("next_billing_date", { withTimezone: true }),
  lastPaymentAt: timestamp("last_payment_at", { withTimezone: true }),
  lastPaymentId: text("last_payment_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  failedPaymentCount: integer("failed_payment_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("member_subscriptions_member_idx").on(t.clubMemberId)]);

// ─── MEMBERSHIP WAITLIST ─────────────────────────────────────────────────────

export const applicationStageEnum = pgEnum("application_stage", [
  "applied", "under_review", "pending_committee", "approved", "rejected",
]);

/**
 * Public membership applications submitted by prospective members.
 * Not linked to any appUser until approved (when a club member account is auto-created).
 */
export const membershipApplicationsTable = pgTable("membership_applications", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tierId: integer("tier_id").references(() => membershipTiersTable.id, { onDelete: "set null" }),

  // Personal details (collected from the public form)
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  dateOfBirth: timestamp("date_of_birth", { withTimezone: true }),
  address: text("address"),

  // Golf background
  golfBackground: text("golf_background"),
  currentHandicap: numeric("current_handicap", { precision: 4, scale: 1 }),
  previousClub: text("previous_club"),
  yearsPlaying: integer("years_playing"),

  // Proposer / seconder (optional — club may require)
  proposerName: text("proposer_name"),
  proposerMemberNumber: text("proposer_member_number"),
  seconderName: text("seconder_name"),
  seconderMemberNumber: text("seconder_member_number"),

  // Pipeline state
  stage: applicationStageEnum("stage").notNull().default("applied"),
  stageUpdatedAt: timestamp("stage_updated_at", { withTimezone: true }).notNull().defaultNow(),

  // When approved: auto-created club member reference
  createdMemberId: integer("created_member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),

  // Admin meta
  adminNotes: text("admin_notes"),
  rejectionReason: text("rejection_reason"),

  // Document attachments (stored as URLs, e.g. uploaded to object storage)
  attachments: jsonb("attachments").$type<{ name: string; url: string; uploadedAt: string }[]>().default([]),

  // Unique submission reference code shown to applicant
  referenceCode: text("reference_code").notNull(),

  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("membership_apps_org_idx").on(t.organizationId),
  index("membership_apps_stage_idx").on(t.organizationId, t.stage),
  index("membership_apps_email_idx").on(t.email),
  uniqueIndex("membership_apps_ref_unique").on(t.referenceCode),
]);

/**
 * Admin notes and activity log for a membership application.
 */
export const applicationNotesTable = pgTable("application_notes", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").notNull().references(() => membershipApplicationsTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  body: text("body").notNull(),
  isInternal: boolean("is_internal").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("app_notes_application_idx").on(t.applicationId)]);

export type MembershipApplication = typeof membershipApplicationsTable.$inferSelect;
export type ApplicationNote = typeof applicationNotesTable.$inferSelect;

// ─── SPONSORS ────────────────────────────────────────────────────────────────
export const sponsorsTable = pgTable("sponsors", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tier: text("tier").notNull().default("gold"),
  logoUrl: text("logo_url"),
  websiteUrl: text("website_url"),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  // Sponsor portal credentials
  contactEmail: text("contact_email"),
  contactName: text("contact_name"),
  contactPhone: text("contact_phone"),
  portalPasswordHash: text("portal_password_hash"),
  portalToken: text("portal_token"),
  portalTokenExpiry: timestamp("portal_token_expiry", { withTimezone: true }),
  // Asset management
  bannerUrl: text("banner_url"),
  pendingLogoUrl: text("pending_logo_url"),
  pendingBannerUrl: text("pending_banner_url"),
  assetRejectionFeedback: text("asset_rejection_feedback"),
  // Pipeline tracking
  pipelineStatus: text("pipeline_status").notNull().default("prospect"),
  renewalDate: timestamp("renewal_date", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sponsors_org_idx").on(t.organizationId), index("sponsors_tournament_idx").on(t.tournamentId)]);

// SPONSORSHIP PACKAGES — sellable sponsorship tiers with pricing
export const sponsorshipPackagesTable = pgTable("sponsorship_packages", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  deliverables: jsonb("deliverables").$type<string[]>().default([]),
  packageType: text("package_type").notNull().default("event"),
  isActive: boolean("is_active").notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sponsorship_packages_org_idx").on(t.organizationId)]);

// SPONSORSHIP ASSIGNMENTS — assign a sponsor+package to a hole or event/tournament
export const sponsorshipAssignmentsTable = pgTable("sponsorship_assignments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  packageId: integer("package_id").references(() => sponsorshipPackagesTable.id, { onDelete: "set null" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number"),
  assignmentType: text("assignment_type").notNull().default("event"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("sponsorship_assignments_org_idx").on(t.organizationId),
  index("sponsorship_assignments_sponsor_idx").on(t.sponsorId),
  index("sponsorship_assignments_tournament_idx").on(t.tournamentId),
]);

// SPONSOR INVOICES — invoice + payment tracking per sponsor assignment
export const sponsorInvoicesTable = pgTable("sponsor_invoices", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  assignmentId: integer("assignment_id").references(() => sponsorshipAssignmentsTable.id, { onDelete: "set null" }),
  packageId: integer("package_id").references(() => sponsorshipPackagesTable.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  razorpayPaymentLinkId: text("razorpay_payment_link_id"),
  razorpayPaymentLinkUrl: text("razorpay_payment_link_url"),
  razorpayPaymentId: text("razorpay_payment_id"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("sponsor_invoices_org_idx").on(t.organizationId),
  index("sponsor_invoices_sponsor_idx").on(t.sponsorId),
  uniqueIndex("sponsor_invoice_number_org_unique").on(t.organizationId, t.invoiceNumber),
]);

export const holeSponsorsTable = pgTable("hole_sponsors", {
  id: serial("id").primaryKey(),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("hole_sponsor_unique").on(t.tournamentId, t.holeNumber)]);

export const sponsorEventsTable = pgTable("sponsor_events", {
  id: serial("id").primaryKey(),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull(),
  tournamentId: integer("tournament_id"),
  eventType: text("event_type").notNull(),
  source: text("source").notNull(),
  sessionId: text("session_id").notNull(),
  // Ad campaign engine attribution (Task #371)
  slotKey: text("slot_key"),
  campaignId: integer("campaign_id"),
  creativeId: integer("creative_id"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("sponsor_events_sponsor_rec_idx").on(t.sponsorId, t.recordedAt),
  index("sponsor_events_org_idx").on(t.organizationId),
  index("sponsor_events_slot_idx").on(t.organizationId, t.slotKey, t.recordedAt),
  index("sponsor_events_campaign_idx").on(t.campaignId, t.recordedAt),
]);

// ─── AD INVENTORY: SLOTS, CREATIVES, CAMPAIGNS (Task #371) ───────────────────
// Ad slots are surfaces where sponsor creatives can render (TV ticker,
// leaderboard bug, player card, mobile splash, scorecard footer, etc.)
export const adSlotsTable = pgTable("ad_slots", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  slotKey: text("slot_key").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  surface: text("surface").notNull().default("web"),
  mediaTypes: jsonb("media_types").$type<string[]>().notNull().default(["image"]),
  rotationSeconds: integer("rotation_seconds").notNull().default(8),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ad_slot_org_key_unique").on(t.organizationId, t.slotKey),
]);

// A reusable creative belonging to a sponsor (image or video)
export const adCreativesTable = pgTable("ad_creatives", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mediaType: text("media_type").notNull().default("image"),
  mediaUrl: text("media_url").notNull(),
  clickThroughUrl: text("click_through_url"),
  headline: text("headline"),
  subheadline: text("subheadline"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ad_creatives_org_idx").on(t.organizationId),
  index("ad_creatives_sponsor_idx").on(t.sponsorId),
]);

// A campaign places one creative into one slot for a date range with a
// frequency cap (per session) and a relative weight.
export const adCampaignsTable = pgTable("ad_campaigns", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  slotId: integer("slot_id").notNull().references(() => adSlotsTable.id, { onDelete: "cascade" }),
  creativeId: integer("creative_id").notNull().references(() => adCreativesTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  weight: integer("weight").notNull().default(10),
  frequencyCapPerSession: integer("frequency_cap_per_session").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ad_campaigns_org_idx").on(t.organizationId),
  index("ad_campaigns_slot_window_idx").on(t.slotId, t.startDate, t.endDate),
  index("ad_campaigns_sponsor_idx").on(t.sponsorId),
]);

export type AdSlot = typeof adSlotsTable.$inferSelect;
export type AdCreative = typeof adCreativesTable.$inferSelect;
export type AdCampaign = typeof adCampaignsTable.$inferSelect;

// ─── PRIZES ──────────────────────────────────────────────────────────────────
export const prizeCategoriesTable = pgTable("prize_categories", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  prizeValue: numeric("prize_value", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  sponsorId: integer("sponsor_id").references(() => sponsorsTable.id, { onDelete: "set null" }),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("prize_categories_tournament_idx").on(t.tournamentId)]);

export const prizeAwardsTable = pgTable("prize_awards", {
  id: serial("id").primaryKey(),
  prizeCategoryId: integer("prize_category_id").notNull().references(() => prizeCategoriesTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  playerName: text("player_name").notNull(),
  awardAmount: numeric("award_amount", { precision: 10, scale: 2 }),
  awardCurrency: text("award_currency"),
  notes: text("notes"),
  certificateUrl: text("certificate_url"),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("prize_awards_tournament_idx").on(t.tournamentId)]);

// ─── SHOP ─────────────────────────────────────────────────────────────────────
export const shopOrderStatusEnum = pgEnum("shop_order_status", [
  "pending", "paid", "processing", "shipped", "delivered", "cancelled", "refunded", "cod_pending", "returned", "exchanged",
]);

export const shopProductsTable = pgTable("shop_products", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sizeVariantMap: jsonb("size_variant_map").$type<Record<string, string>>(),
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  category: text("category").notNull().default("apparel"),
  /**
   * Optional vendor-facility scope. When set, this product is visible only to the vendor
   * assigned to the matching facilityType (and to org admins). Null means org-wide / all vendors.
   * Values: "pro_shop" | "f_and_b" | "driving_range" | "other"
   */
  vendorFacilityType: text("vendor_facility_type"),
  basePrice: numeric("base_price", { precision: 10, scale: 2 }).notNull(),
  markupPrice: numeric("markup_price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  sizes: jsonb("sizes").$type<string[]>().notNull().default(["XS", "S", "M", "L", "XL", "XXL"]),
  isActive: boolean("is_active").notNull().default(true),
  stockCount: integer("stock_count"),
  hsnCode: text("hsn_code"),
  gstRate: numeric("gst_rate", { precision: 4, scale: 2 }).default("18"),
  /** Flash sale price (overrides markupPrice during sale window) */
  salePrice: numeric("sale_price", { precision: 10, scale: 2 }),
  saleStart: timestamp("sale_start", { withTimezone: true }),
  saleEnd: timestamp("sale_end", { withTimezone: true }),
  /**
   * Per-membership-tier price overrides. Maps membershipTier.id (as string key) to a price.
   * When set, this price takes precedence over markupPrice for members on that tier,
   * before any percentage discount is applied.
   * Example: { "3": 999.00, "7": 799.00 }
   */
  tierPricing: jsonb("tier_pricing").$type<Record<string, number>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("shop_products_org_idx").on(t.organizationId)]);

export const shopProductVariantsTable = pgTable("shop_product_variants", {
  id: serial("id").primaryKey(),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "cascade" }),
  color: text("color"),
  size: text("size"),
  stockQty: integer("stock_qty").notNull().default(0),
  barcode: text("barcode"),
  sku: text("sku"),
  costPrice: numeric("cost_price", { precision: 10, scale: 2 }),
  tierPricing: jsonb("tier_pricing").$type<Record<string, number>>(),
  salePrice: numeric("sale_price", { precision: 10, scale: 2 }),
  saleStart: timestamp("sale_start", { withTimezone: true }),
  saleEnd: timestamp("sale_end", { withTimezone: true }),
  /** Supplier linked to this variant for purchase order auto-drafting */
  supplierId: integer("supplier_id").references((): AnyPgColumn => suppliersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_variants_product_idx").on(t.productId),
  index("shop_variants_barcode_idx").on(t.barcode),
]);

export const shopOrdersTable = pgTable("shop_orders", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "restrict" }),
  variantId: integer("variant_id").references(() => shopProductVariantsTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerPhone: text("customer_phone"),
  size: text("size"),
  color: text("color"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  shippingAddress: jsonb("shipping_address").$type<{
    line1: string; line2?: string; city: string; state: string; pincode: string; country: string;
  }>(),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  paymentMode: text("payment_mode").notNull().default("razorpay"),
  shiprocketOrderId: text("shiprocket_order_id"),
  awbCode: text("awb_code"),
  trackingNumber: text("tracking_number"),
  trackingUrl: text("tracking_url"),
  buyerGstin: text("buyer_gstin"),
  sellerGstin: text("seller_gstin"),
  invoicePath: text("invoice_path"),
  gstRate: numeric("gst_rate", { precision: 4, scale: 2 }),
  hsnCode: text("hsn_code"),
  status: shopOrderStatusEnum("status").notNull().default("pending"),
  /** Applied promo code (if any) */
  promoCode: text("promo_code"),
  /** Discount breakdown as JSON — each entry: { type, label, amount, pct? } */
  discountBreakdown: jsonb("discount_breakdown").$type<Array<{
    type: "member" | "promo" | "loyalty" | "bundle" | "affiliate" | "flash_sale";
    label: string;
    amount: number;
    pct?: number;
  }>>(),
  /** Total discount amount applied */
  discountTotal: numeric("discount_total", { precision: 10, scale: 2 }).notNull().default("0"),
  /** Loyalty points redeemed */
  loyaltyPointsRedeemed: integer("loyalty_points_redeemed").notNull().default(0),
  /** Affiliate code used (if any) */
  affiliateCode: text("affiliate_code"),
  /** Stacking policy that was active at time of order */
  stackingPolicyApplied: text("stacking_policy_applied"),
  /** Tournament this order was placed as event merchandise (for tournament reporting) */
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("shop_orders_org_idx").on(t.organizationId)]);

export const shopCategoryFlashSalesTable = pgTable("shop_category_flash_sales", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  label: text("label"),
  discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull(),
  saleStart: timestamp("sale_start", { withTimezone: true }).notNull(),
  saleEnd: timestamp("sale_end", { withTimezone: true }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("shop_category_flash_org_idx").on(t.organizationId)]);

export type ShopCategoryFlashSale = typeof shopCategoryFlashSalesTable.$inferSelect;

export const shopStoreSettingsTable = pgTable("shop_store_settings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }).unique(),
  gstin: text("gstin"),
  sellerName: text("seller_name"),
  sellerAddress: text("seller_address"),
  sellerState: text("seller_state"),
  sellerStateCode: text("seller_state_code"),
  defaultSacCode: text("default_sac_code"),
  shiprocketEmail: text("shiprocket_email"),
  shiprocketPassword: text("shiprocket_password"),
  shiprocketToken: text("shiprocket_token"),
  shiprocketTokenExpiry: timestamp("shiprocket_token_expiry", { withTimezone: true }),
  /**
   * Discount stacking policy:
   * - "none": only the single highest discount applies
   * - "promo_member": promo code + member tier discount stack
   * - "all": promo + member + loyalty + bundle all stack
   * - "custom": custom priority order (see stackingPriority)
   */
  discountStackingPolicy: text("discount_stacking_policy").notNull().default("promo_member"),
  /** For "custom" policy: ordered list of discount types, e.g. ["member","promo","loyalty","bundle"] */
  stackingPriority: jsonb("stacking_priority").$type<string[]>(),
  /** How many point types apply in "custom" mode (null = all) */
  stackingMaxLayers: integer("stacking_max_layers"),
  /** Points-to-currency conversion: how many points = 1 unit of currency. e.g. 100 = 100pts per ₹1 */
  loyaltyPointsPerCurrencyUnit: integer("loyalty_points_per_currency_unit").notNull().default(100),
  /** Max % of order total redeemable via loyalty points (0-100) */
  loyaltyMaxRedemptionPct: integer("loyalty_max_redemption_pct").notNull().default(20),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("shop_store_settings_org_idx").on(t.organizationId)]);

// ─── SHOP WISHLIST ────────────────────────────────────────────────────────────
export const shopWishlistTable = pgTable("shop_wishlist", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("shop_wishlist_user_product_unique").on(t.userId, t.productId),
  index("shop_wishlist_user_idx").on(t.userId),
]);

// ─── SHOP REVIEWS ─────────────────────────────────────────────────────────────
export const shopReviewsTable = pgTable("shop_reviews", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  comment: text("comment"),
  isApproved: boolean("is_approved").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("shop_reviews_user_product_unique").on(t.userId, t.productId),
  index("shop_reviews_product_idx").on(t.productId),
  index("shop_reviews_org_idx").on(t.organizationId),
]);

// ─── SHOP REVIEW PROMPTS ──────────────────────────────────────────────────────
export const shopReviewPromptsTable = pgTable("shop_review_prompts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => shopOrdersTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "cascade" }),
  isDismissed: boolean("is_dismissed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("shop_review_prompts_user_order_unique").on(t.userId, t.orderId),
  index("shop_review_prompts_user_idx").on(t.userId),
]);

// ─── TASK #130: SHOP RETURNS, REFUNDS & EXCHANGES ───────────────────────────

export const shopReturnStatusEnum = pgEnum("shop_return_status", [
  "pending", "approved", "rejected", "received", "refunded", "flagged", "exchanged",
]);

export const shopReturnReasonEnum = pgEnum("shop_return_reason", [
  "wrong_size", "defective", "changed_mind", "wrong_item", "damaged_in_shipping", "other",
]);

export const shopReturnsTable = pgTable("shop_returns", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  /** For online shop returns — references shop_orders */
  orderId: integer("order_id").references(() => shopOrdersTable.id, { onDelete: "restrict" }),
  /** For POS returns — references pos_transactions */
  posTransactionId: integer("pos_transaction_id"),
  /** Source: "online" or "pos" */
  sourceType: text("source_type").notNull().default("online"),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  reason: shopReturnReasonEnum("reason").notNull(),
  reasonDetail: text("reason_detail"),
  status: shopReturnStatusEnum("status").notNull().default("pending"),
  /** Type of resolution: "refund" or "exchange" */
  returnType: text("return_type").notNull().default("refund"),
  refundAmount: numeric("refund_amount", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  /** For online orders: razorpay refund ID */
  razorpayRefundId: text("razorpay_refund_id"),
  /** For POS cash refunds or member account reversals */
  posRefundMethod: text("pos_refund_method"),
  /** Exchange: new variant selected */
  exchangeVariantId: integer("exchange_variant_id").references(() => shopProductVariantsTable.id, { onDelete: "set null" }),
  /** Exchange: credit note amount (if exchange item is cheaper) */
  creditNoteAmount: numeric("credit_note_amount", { precision: 10, scale: 2 }),
  /** Fraud detection */
  fraudScore: integer("fraud_score").notNull().default(0),
  fraudFlag: boolean("fraud_flag").notNull().default(false),
  fraudFlagReason: text("fraud_flag_reason"),
  fraudOverriddenByUserId: integer("fraud_overridden_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  fraudOverriddenAt: timestamp("fraud_overridden_at", { withTimezone: true }),
  /** Admin notes */
  adminNotes: text("admin_notes"),
  resolvedByUserId: integer("resolved_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_returns_org_idx").on(t.organizationId),
  index("shop_returns_order_idx").on(t.orderId),
  index("shop_returns_user_idx").on(t.userId),
  index("shop_returns_status_idx").on(t.status),
]);

export const shopReturnItemsTable = pgTable("shop_return_items", {
  id: serial("id").primaryKey(),
  returnId: integer("return_id").notNull().references(() => shopReturnsTable.id, { onDelete: "cascade" }),
  orderId: integer("order_id").references(() => shopOrdersTable.id, { onDelete: "set null" }),
  productId: integer("product_id").references(() => shopProductsTable.id, { onDelete: "set null" }),
  variantId: integer("variant_id").references(() => shopProductVariantsTable.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  size: text("size"),
  color: text("color"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  /** Whether this item has been restocked in inventory */
  restocked: boolean("restocked").notNull().default(false),
  /** For exchange: the new variant to swap to */
  exchangeVariantId: integer("exchange_variant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_return_items_return_idx").on(t.returnId),
  foreignKey({ name: "shop_return_items_exchange_variant_id_fk", columns: [t.exchangeVariantId], foreignColumns: [shopProductVariantsTable.id] }).onDelete("set null"),
]);

/** Accounts blacklisted from future returns by admins */
export const shopReturnBlacklistTable = pgTable("shop_return_blacklist", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  reason: text("reason"),
  blacklistedByUserId: integer("blacklisted_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("shop_return_blacklist_org_user_unique").on(t.organizationId, t.userId),
  index("shop_return_blacklist_org_idx").on(t.organizationId),
]);

export type ShopReturn = typeof shopReturnsTable.$inferSelect;
export type ShopReturnItem = typeof shopReturnItemsTable.$inferSelect;

/** Order / return lifecycle event log */
export const shopOrderEventsTable = pgTable("shop_order_events", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  orderId: integer("order_id").references(() => shopOrdersTable.id, { onDelete: "cascade" }),
  returnId: integer("return_id").references(() => shopReturnsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  description: text("description").notNull(),
  metadata: jsonb("metadata"),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_order_events_order_idx").on(t.orderId),
  index("shop_order_events_return_idx").on(t.returnId),
  index("shop_order_events_org_idx").on(t.organizationId),
]);

// ─── TASK #82: PRO SHOP POS SYSTEM ─────────────────────────────────────────

export const posPaymentMethodEnum = pgEnum("pos_payment_method", [
  "cash", "razorpay_pos", "member_account", "gift_card", "split_gift_card_cash",
]);

export const posTransactionStatusEnum = pgEnum("pos_transaction_status", [
  "pending", "completed", "voided", "refunded",
]);

export const posTransactionsTable = pgTable("pos_transactions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  receiptNumber: text("receipt_number").notNull(),
  staffUserId: integer("staff_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  clubMemberId: integer("club_member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),
  memberName: text("member_name"),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  paymentMethod: posPaymentMethodEnum("payment_method").notNull(),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  status: posTransactionStatusEnum("status").notNull().default("completed"),
  razorpayPaymentId: text("razorpay_payment_id"),
  notes: text("notes"),
  receiptEmailed: boolean("receipt_emailed").notNull().default(false),
  offlineSynced: boolean("offline_synced").notNull().default(false),
  giftCardId: integer("gift_card_id").references((): AnyPgColumn => giftCardsTable.id, { onDelete: "set null" }),
  giftCardAmountApplied: numeric("gift_card_amount_applied", { precision: 10, scale: 2 }),
  vendorOperatorId: integer("vendor_operator_id").references(() => vendorOperatorsTable.id, { onDelete: "set null" }),
  transactedAt: timestamp("transacted_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("pos_transactions_org_idx").on(t.organizationId),
  index("pos_transactions_member_idx").on(t.clubMemberId),
  index("pos_transactions_date_idx").on(t.transactedAt),
  index("pos_transactions_vendor_idx").on(t.vendorOperatorId),
  uniqueIndex("pos_transactions_receipt_org_unique").on(t.organizationId, t.receiptNumber),
]);

export const posTransactionItemsTable = pgTable("pos_transaction_items", {
  id: serial("id").primaryKey(),
  transactionId: integer("transaction_id").notNull().references(() => posTransactionsTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => shopProductsTable.id, { onDelete: "set null" }),
  variantId: integer("variant_id"),
  productName: text("product_name").notNull(),
  sku: text("sku"),
  category: text("category"),
  quantity: integer("quantity").notNull().default(1),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  lineTotal: numeric("line_total", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pos_transaction_items_txn_idx").on(t.transactionId)]);

export const memberAccountChargesTable = pgTable("member_account_charges", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  posTransactionId: integer("pos_transaction_id"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  description: text("description"),
  isSettled: boolean("is_settled").notNull().default(false),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  settledByUserId: integer("settled_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  settlementNote: text("settlement_note"),
  vendorOperatorId: integer("vendor_operator_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_account_charges_member_idx").on(t.clubMemberId),
  index("member_account_charges_org_idx").on(t.organizationId),
  index("member_account_charges_settled_idx").on(t.isSettled),
  index("member_account_charges_vendor_idx").on(t.vendorOperatorId),
  foreignKey({ name: "member_account_charges_pos_transaction_id_fk", columns: [t.posTransactionId], foreignColumns: [posTransactionsTable.id] }).onDelete("set null"),
  foreignKey({ name: "member_account_charges_vendor_operator_id_fk", columns: [t.vendorOperatorId], foreignColumns: [vendorOperatorsTable.id] }).onDelete("set null"),
]);

export type PosTransaction = typeof posTransactionsTable.$inferSelect;
export type PosTransactionItem = typeof posTransactionItemsTable.$inferSelect;
export type MemberAccountCharge = typeof memberAccountChargesTable.$inferSelect;

// ─── TOURNAMENT STAFF ─────────────────────────────────────────────────────────
export const tournamentStaffTable = pgTable("tournament_staff", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: tournamentStaffRoleEnum("role").notNull().default("volunteer"),
  invitedByUserId: integer("invited_by_user_id").references(() => appUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tournament_staff_email_unique").on(t.tournamentId, t.email),
  index("tournament_staff_tournament_idx").on(t.tournamentId),
]);

// ─── SCORER PINS ──────────────────────────────────────────────────────────────
export const scorerPinsTable = pgTable("scorer_pins", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  pin: text("pin").notNull(),
  label: text("label").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isRevoked: boolean("is_revoked").notNull().default(false),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("scorer_pins_pin_unique").on(t.tournamentId, t.pin),
  index("scorer_pins_tournament_idx").on(t.tournamentId),
]);

// ─── LEAGUE STAFF ─────────────────────────────────────────────────────────────
export const leagueStaffTable = pgTable("league_staff", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: leagueStaffRoleEnum("role").notNull().default("competition_secretary"),
  invitedByUserId: integer("invited_by_user_id").references(() => appUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("league_staff_email_unique").on(t.leagueId, t.email),
  index("league_staff_league_idx").on(t.leagueId),
]);

// Insert schemas
export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCourseSchema = createInsertSchema(coursesTable).omit({ id: true, createdAt: true });
export const insertTournamentSchema = createInsertSchema(tournamentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPlayerSchema = createInsertSchema(playersTable).omit({ id: true, registeredAt: true });
export const insertScoreSchema = createInsertSchema(scoresTable).omit({ id: true, submittedAt: true, updatedAt: true });
export const insertLeagueSchema = createInsertSchema(leaguesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertLeagueMemberSchema = createInsertSchema(leagueMembersTable).omit({ id: true, joinedAt: true });
export const insertFlightSchema = createInsertSchema(flightsTable).omit({ id: true, createdAt: true });
export const insertRoundSubmissionSchema = createInsertSchema(roundSubmissionsTable).omit({ id: true, submittedAt: true });

export type Organization = typeof organizationsTable.$inferSelect;
export type Course = typeof coursesTable.$inferSelect;
export type Tournament = typeof tournamentsTable.$inferSelect;
export type Player = typeof playersTable.$inferSelect;
export type Score = typeof scoresTable.$inferSelect;
export type AppUser = typeof appUsersTable.$inferSelect;
export type League = typeof leaguesTable.$inferSelect;
export type LeagueRound = typeof leagueRoundsTable.$inferSelect;
export type LeagueMember = typeof leagueMembersTable.$inferSelect;
export type LeagueStanding = typeof leagueStandingsTable.$inferSelect;
export type Flight = typeof flightsTable.$inferSelect;
export type PlayerFlight = typeof playerFlightsTable.$inferSelect;
export type RoundSubmission = typeof roundSubmissionsTable.$inferSelect;
export type Shot = typeof shotsTable.$inferSelect;
export type MatchResult = typeof matchResultsTable.$inferSelect;
export type LeagueFixture = typeof leagueFixturesTable.$inferSelect;
export type LeagueRoundResult = typeof leagueRoundResultsTable.$inferSelect;
export type SideGamesConfig = typeof sideGamesConfigTable.$inferSelect;
export type SideGameResult = typeof sideGameResultsTable.$inferSelect;
export type Waitlist = typeof waitlistTable.$inferSelect;
export type Withdrawal = typeof withdrawalsTable.$inferSelect;
export type Media = typeof mediaTable.$inferSelect;
export type ChatRoom = typeof chatRoomsTable.$inferSelect;
export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type Achievement = typeof achievementsTable.$inferSelect;
export type HandicapHistory = typeof handicapHistoryTable.$inferSelect;
export type WearableConnection = typeof wearableConnectionsTable.$inferSelect;
export type WellnessDailyMetric = typeof wellnessDailyMetricsTable.$inferSelect;
export type WellnessConsent = typeof wellnessConsentsTable.$inferSelect;
export type UserHealthPref = typeof userHealthPrefsTable.$inferSelect;
export type HrSample = typeof hrSamplesTable.$inferSelect;
export type MembershipTier = typeof membershipTiersTable.$inferSelect;
export type ClubMember = typeof clubMembersTable.$inferSelect;
export type MemberSubscription = typeof memberSubscriptionsTable.$inferSelect;
export type Sponsor = typeof sponsorsTable.$inferSelect;
export type HoleSponsor = typeof holeSponsorsTable.$inferSelect;
export type SponsorshipPackage = typeof sponsorshipPackagesTable.$inferSelect;
export type SponsorshipAssignment = typeof sponsorshipAssignmentsTable.$inferSelect;
export type SponsorInvoice = typeof sponsorInvoicesTable.$inferSelect;
export type PrizeCategory = typeof prizeCategoriesTable.$inferSelect;
export type PrizeAward = typeof prizeAwardsTable.$inferSelect;
export type ShopProduct = typeof shopProductsTable.$inferSelect;
export type ShopProductVariant = typeof shopProductVariantsTable.$inferSelect;
export type ShopOrder = typeof shopOrdersTable.$inferSelect;
export type ShopWishlist = typeof shopWishlistTable.$inferSelect;
export type ShopReview = typeof shopReviewsTable.$inferSelect;
export type ShopReviewPrompt = typeof shopReviewPromptsTable.$inferSelect;
export type ShopStoreSettings = typeof shopStoreSettingsTable.$inferSelect;
export type TournamentStaff = typeof tournamentStaffTable.$inferSelect;
export type ScorerPin = typeof scorerPinsTable.$inferSelect;
export type LeagueStaff = typeof leagueStaffTable.$inferSelect;
export type WhsPosting = typeof whsPostingsTable.$inferSelect;

// TOURNAMENT TEMPLATES — reusable tournament configurations per org
export const tournamentTemplatesTable = pgTable("tournament_templates", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  format: tournamentFormatEnum("format").notNull().default("stroke_play"),
  rounds: integer("rounds").notNull().default(1),
  handicapAllowance: integer("handicap_allowance").notNull().default(100),
  maxPlayers: integer("max_players"),
  entryFee: numeric("entry_fee", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  selfPosting: boolean("self_posting").notNull().default(false),
  allowSelfScoring: boolean("allow_self_scoring").notNull().default(false),
  markerValidation: boolean("marker_validation").notNull().default(false),
  tiebreakerMethod: tiebreakerMethodEnum("tiebreaker_method").notNull().default("countback"),
  leaderboardType: leaderboardTypeEnum("leaderboard_type").notNull().default("both"),
  autoWelcome: boolean("auto_welcome").notNull().default(true),
  autoReminder: boolean("auto_reminder").notNull().default(true),
  autoResults: boolean("auto_results").notNull().default(false),
  localRules: text("local_rules"),
  config: jsonb("config"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tournament_templates_org_idx").on(t.organizationId)]);

export type TournamentTemplate = typeof tournamentTemplatesTable.$inferSelect;

// PRACTICE SESSIONS — per-player non-competitive practice logging
export const practiceSessionTypeEnum = pgEnum("practice_session_type", [
  "range", "putting", "short_game", "on_course", "simulator", "other",
]);

export const practiceSessionsTable = pgTable("practice_sessions", {
  id: serial("id").primaryKey(),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  sessionType: practiceSessionTypeEnum("session_type").notNull().default("range"),
  durationMinutes: integer("duration_minutes"),
  notes: text("notes"),
  clubFocus: text("club_focus"),
  // Task #1641 — when a session is logged from a "Work on This Club" coaching
  // tip, capture the canonical club key + the suggested practice distance and
  // tag the source as "coaching_tip" so we can later A/B whether tip-driven
  // practice closes the proximity gap faster than ad-hoc range time. Manual
  // logs leave these null (source defaults to "manual" semantically).
  source: text("source"),
  practiceDistanceYards: integer("practice_distance_yards"),
  clubKey: text("club_key"),
  sessionDate: timestamp("session_date", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("practice_sessions_user_idx").on(t.userId),
  index("practice_sessions_org_idx").on(t.organizationId),
  index("practice_sessions_date_idx").on(t.sessionDate),
  index("practice_sessions_source_idx").on(t.source),
]);

// TOURNAMENT ROUNDS — per-round course assignments for multi-course championships
export const tournamentRoundsTable = pgTable("tournament_rounds", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  roundNumber: integer("round_number").notNull(),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "set null" }),
  scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
  notes: text("notes"),
}, (t) => [
  uniqueIndex("tournament_rounds_unique").on(t.tournamentId, t.roundNumber),
  index("tournament_rounds_tournament_idx").on(t.tournamentId),
]);

export type PracticeSession = typeof practiceSessionsTable.$inferSelect;
export type TournamentRound = typeof tournamentRoundsTable.$inferSelect;

// COACHING TIP IMPRESSIONS — per-render telemetry for the "Work on This Club"
// callout (Task #2045).
//
// Task #1641 already records *acted-on* tips (a practice session with
// `source='coaching_tip'`). On its own that lets us compute tip-driven
// session volume but not the conversion rate, because we don't know how
// many times a tip was shown and ignored. Logging one row per render
// (debounced/deduped client-side per session) fills the gap so a future
// dashboard can compute:
//
//     conversion = practice_sessions(source='coaching_tip')
//                / coaching_tip_impressions
//
// per club + date range. Rows are intentionally lightweight — we keep the
// canonical `clubKey` (so the join with `practice_sessions.club_key`
// works without re-resolving labels) and the suggested practice distance
// the tip rendered with at impression time.
export const coachingTipImpressionsTable = pgTable("coaching_tip_impressions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  clubKey: text("club_key").notNull(),
  practiceDistanceYards: integer("practice_distance_yards"),
  shownAt: timestamp("shown_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Conversion-rate roll-ups walk by (clubKey, shownAt) and dashboards
  // typically slice by user as well; keep both access patterns indexed.
  index("coaching_tip_impressions_club_idx").on(t.clubKey, t.shownAt),
  index("coaching_tip_impressions_user_idx").on(t.userId, t.shownAt),
]);

export type CoachingTipImpression = typeof coachingTipImpressionsTable.$inferSelect;

// EXCEPTIONAL SCORE FLAGS — WHS-triggered ESR queue (score differential drops HI by ≥3 strokes)
export const exceptionalScoreFlagsTable = pgTable("exceptional_score_flags", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  round: integer("round"),
  /** Optional link to the specific WHS posting / score record being flagged for ESR. */
  postingId: integer("posting_id"),
  scoreDifferential: numeric("score_differential", { precision: 5, scale: 1 }).notNull(),
  previousHandicapIndex: numeric("previous_handicap_index", { precision: 5, scale: 1 }),
  projectedHandicapIndex: numeric("projected_handicap_index", { precision: 5, scale: 1 }),
  adjustedHandicapIndex: numeric("adjusted_handicap_index", { precision: 5, scale: 1 }),
  status: text("status").notNull().default("pending"),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  notes: text("notes"),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("esr_flags_org_idx").on(t.organizationId),
  index("esr_flags_player_idx").on(t.playerId),
  index("esr_flags_status_idx").on(t.status),
  // Prevent duplicate auto-flags for the same player/tournament/round
  uniqueIndex("esr_player_round_unique").on(t.organizationId, t.playerId, t.tournamentId, t.round),
  // Prevent duplicate flags linked to the same WHS posting record
  uniqueIndex("esr_posting_unique").on(t.postingId),
]);

// HANDICAP ADJUSTMENTS — committee upward adjustments with mandatory reason + full audit trail
export const handicapAdjustmentsTable = pgTable("handicap_adjustments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  adjustedByUserId: integer("adjusted_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  previousHandicapIndex: numeric("previous_handicap_index", { precision: 5, scale: 1 }),
  newHandicapIndex: numeric("new_handicap_index", { precision: 5, scale: 1 }).notNull(),
  /** Upward stroke count entered by committee (newHI − previousHI). Primary audit field. */
  adjustmentStrokes: numeric("adjustment_strokes", { precision: 4, scale: 1 }),
  adjustmentReason: text("adjustment_reason").notNull(),
  committeeNotes: text("committee_notes"),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  /** Link to the ESR flag that triggered this adjustment (null for manual/standalone adjustments). */
  flagId: integer("flag_id").references(() => exceptionalScoreFlagsTable.id, { onDelete: "set null" }),
  adjustedAt: timestamp("adjusted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("hcp_adj_org_idx").on(t.organizationId),
  index("hcp_adj_player_idx").on(t.playerId),
  index("hcp_adj_date_idx").on(t.adjustedAt),
]);

export type ExceptionalScoreFlag = typeof exceptionalScoreFlagsTable.$inferSelect;
export type HandicapAdjustment = typeof handicapAdjustmentsTable.$inferSelect;

// HANDICAP COMMITTEE REVIEW CASES — peer-review workflow with state machine
// kinds:    anomalous | not_posted | exceptional | annual
// statuses: open → assigned → awaiting_peer → decided → closed (reopened → assigned)
// decisions: no_action | soft_cap | hard_cap | index_adjustment
export const handicapReviewCasesTable = pgTable("handicap_review_cases", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  /** Optional player row link (tournament-scoped). Null for cross-tournament/annual cases. */
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  /** Subject — the player handicap holder. Always set, used for cross-tournament aggregation. */
  subjectUserId: integer("subject_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("open"),
  /** Link to the ESR flag that seeded this case (when kind = exceptional). */
  flagId: integer("flag_id").references(() => exceptionalScoreFlagsTable.id, { onDelete: "set null" }),
  /** Free-form period label e.g. "2025-Q4", "Annual 2025", "Tournament 1234 R2". */
  periodLabel: text("period_label"),
  details: text("details"),
  assigneeUserId: integer("assignee_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  decision: text("decision"),
  decisionRationale: text("decision_rationale"),
  decisionAt: timestamp("decision_at", { withTimezone: true }),
  decidedByUserId: integer("decided_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  /** Link to applied adjustment when the decision triggered an HI change. */
  adjustmentId: integer("adjustment_id").references(() => handicapAdjustmentsTable.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("hcp_case_org_idx").on(t.organizationId),
  index("hcp_case_subject_idx").on(t.subjectUserId),
  index("hcp_case_status_idx").on(t.status),
  index("hcp_case_kind_idx").on(t.kind),
  uniqueIndex("hcp_case_flag_unique").on(t.flagId),
]);

export const handicapCasePeerReviewsTable = pgTable("handicap_case_peer_reviews", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull().references(() => handicapReviewCasesTable.id, { onDelete: "cascade" }),
  reviewerUserId: integer("reviewer_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  /** Random opaque token for the focused peer-response link (no auth required). */
  token: text("token").notNull(),
  invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Task #745 — set the first time the invited reviewer opens the invitation
   * from the mobile inbox (separate from `respondedAt`, which only gets set
   * when they actually submit a recommendation). Used to settle the unread
   * dot on the inbox card after the reviewer has at least seen the request.
   */
  seenAt: timestamp("seen_at", { withTimezone: true }),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  /** Reviewer recommendation: confirm | dispute | insufficient_info */
  recommendation: text("recommendation"),
  comment: text("comment"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [
  index("hcp_case_peer_case_idx").on(t.caseId),
  index("hcp_case_peer_reviewer_idx").on(t.reviewerUserId),
  uniqueIndex("hcp_case_peer_token_unique").on(t.token),
]);

export const handicapCaseAuditLogTable = pgTable("handicap_case_audit_log", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull().references(() => handicapReviewCasesTable.id, { onDelete: "cascade" }),
  /** Action verb: created | assigned | peer_invited | peer_responded | decided | closed | reopened | note */
  action: text("action").notNull(),
  actorUserId: integer("actor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  payload: jsonb("payload"),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("hcp_case_audit_case_idx").on(t.caseId),
  index("hcp_case_audit_created_idx").on(t.createdAt),
]);

export type HandicapReviewCase = typeof handicapReviewCasesTable.$inferSelect;
export type HandicapCasePeerReview = typeof handicapCasePeerReviewsTable.$inferSelect;
export type HandicapCaseAuditLog = typeof handicapCaseAuditLogTable.$inferSelect;

// In-app notifications surfaced on the player's notifications inbox when a
// committee review case affecting them transitions through key lifecycle
// events (opened, decided, closed, reopened). Persisted independently from
// push so that subjects who missed (or have not enabled) push delivery still
// have a durable record they can read in-app, and so that we can track read
// state per notification. Deep-links to /handicap-profile.
export const handicapCaseNotificationsTable = pgTable("handicap_case_notifications", {
  id: serial("id").primaryKey(),
  subjectUserId: integer("subject_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  caseId: integer("case_id").notNull().references(() => handicapReviewCasesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  /** Lifecycle event: opened | decided | closed | reopened */
  event: text("event").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** Optional structured payload (e.g. decision verb, rationale) */
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [
  index("hcp_case_notif_subject_idx").on(t.subjectUserId, t.createdAt),
  index("hcp_case_notif_case_idx").on(t.caseId),
  index("hcp_case_notif_unread_idx").on(t.subjectUserId, t.readAt),
]);

export type HandicapCaseNotification = typeof handicapCaseNotificationsTable.$inferSelect;

// Task #2159 — Generic per-user in-app notification inbox.
//
// Until now, the only durable in-app notification stream the web/mobile
// portal surfaced was `handicap_case_notifications`, which is tightly
// coupled to a committee review case (caseId / organizationId NOT NULL).
// Other notifications (`social.follow.new`, future engagement /
// moderation pings) only had a push or email path — web users who don't
// have push enabled missed them entirely once the toast was gone.
//
// This table is the generic alternative: a per-user inbox row keyed by
// the registry `notification_key` (e.g. `social.follow.new`), with the
// title/body that was dispatched and a free-form `payload` for any
// per-event metadata (followerId, deepLink, etc.). The notifications
// inbox page reads from BOTH this table AND the handicap-case table,
// merged by `created_at` desc, so the player sees a single feed.
//
// Indexed for the two access patterns the inbox + bell badge need:
//   - (user_id, created_at) for the cursor-paginated feed query
//   - (user_id, read_at)    for the unread-count badge query
export const userInboxNotificationsTable = pgTable("user_inbox_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  /** Registry key — must match a row in `notification_type_registry`. */
  notificationKey: text("notification_key").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** Free-form payload. Conventionally includes `deepLink` (string)
   *  for the click-through target; the inbox UI falls back to a
   *  per-key default when missing. */
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [
  index("user_inbox_notif_user_idx").on(t.userId, t.createdAt),
  index("user_inbox_notif_unread_idx").on(t.userId, t.readAt),
]);

export type UserInboxNotification = typeof userInboxNotificationsTable.$inferSelect;

// TEE TIME MARKETPLACE — org-created bookable slots (distinct from tournament-pairings)
export const marketplaceSlotsTable = pgTable("marketplace_slots", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "set null" }),
  slotDate: timestamp("slot_date", { withTimezone: true }).notNull(),
  startingHole: integer("starting_hole").notNull().default(1),
  maxPlayers: integer("max_players").notNull().default(4),
  bookedPlayers: integer("booked_players").notNull().default(0),
  pricePaise: integer("price_paise").notNull().default(0),
  // Task 359 — base price (pre-markup); when null we treat pricePaise as base
  basePricePaise: integer("base_price_paise"),
  // Task 359 — cross-club exposure & surge indicator
  isPublic: boolean("is_public").notNull().default(false),
  surgeIndicator: text("surge_indicator").notNull().default("normal"), // off_peak|normal|surge
  notes: text("notes"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("mkt_slots_org_idx").on(t.organizationId),
  index("mkt_slots_date_idx").on(t.slotDate),
  index("mkt_slots_status_idx").on(t.status),
  index("mkt_slots_public_idx").on(t.isPublic, t.slotDate),
]);

// MARKETPLACE SAVED SEARCHES — Task 359
export const marketplaceSavedSearchesTable = pgTable("marketplace_saved_searches", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  filters: jsonb("filters").notNull(), // { fromDate, toDate, daysOfWeek, courseIds, orgIds, lat, lng, radiusKm, minSpots, maxPricePaise }
  notifyEnabled: boolean("notify_enabled").notNull().default(true),
  // Per-search override of MARKETPLACE_ALERT_DAILY_CAP_PER_USER. NULL → use global default.
  dailyCap: integer("daily_cap"),
  // Optional quiet-hours window during which no pushes are sent for this saved search.
  // Hours are 0-23 in the user's local time-zone (defaults to Asia/Kolkata to match
  // existing push formatting). When start == end (or either is NULL) quiet hours are off.
  quietHoursStart: integer("quiet_hours_start"),
  quietHoursEnd: integer("quiet_hours_end"),
  quietHoursTz: text("quiet_hours_tz").notNull().default("Asia/Kolkata"),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  lastMatchCount: integer("last_match_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("mkt_saved_user_idx").on(t.userId),
  index("mkt_saved_notify_idx").on(t.notifyEnabled),
]);

export const marketplaceSavedSearchAlertsTable = pgTable("marketplace_saved_search_alerts", {
  id: serial("id").primaryKey(),
  searchId: integer("search_id").notNull(),
  slotId: integer("slot_id").notNull().references(() => marketplaceSlotsTable.id, { onDelete: "cascade" }),
  alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mkt_saved_alert_pair_unq").on(t.searchId, t.slotId),
  foreignKey({ name: "marketplace_saved_search_alerts_search_id_fk", columns: [t.searchId], foreignColumns: [marketplaceSavedSearchesTable.id] }).onDelete("cascade"),
]);

export type MarketplaceSavedSearch = typeof marketplaceSavedSearchesTable.$inferSelect;

// TEE TIME MARKETPLACE BOOKINGS — player reservations for marketplace slots
export const marketplaceBookingsTable = pgTable("marketplace_bookings", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull().references(() => marketplaceSlotsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  playerName: text("player_name").notNull(),
  playerEmail: text("player_email"),
  players: integer("players").notNull().default(1),
  amountPaise: integer("amount_paise").notNull().default(0),
  paymentStatus: text("payment_status").notNull().default("pending"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  notes: text("notes"),
  bookedAt: timestamp("booked_at", { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
}, (t) => [
  index("mkt_bookings_slot_idx").on(t.slotId),
  index("mkt_bookings_user_idx").on(t.userId),
  index("mkt_bookings_org_idx").on(t.organizationId),
]);

export type MarketplaceSlot = typeof marketplaceSlotsTable.$inferSelect;
export type MarketplaceBooking = typeof marketplaceBookingsTable.$inferSelect;

// WATCH PAIRING CHALLENGES — server-generated one-time codes for watch companion pairing
// Each code is random, short-lived (10 min), and invalidated on first use.
export const watchPairingChallengesTable = pgTable("watch_pairing_challenges", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),           // 6-digit random string
  platform: text("platform").notNull().default("apple_watch"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("watch_pair_user_idx").on(t.userId),
  index("watch_pair_code_idx").on(t.code),
]);

// EVENT TEAMS — first-class team entities for both tournaments and leagues
export const eventTeamsTable = pgTable("event_teams", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  colour: text("colour").default("#22c55e"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("event_teams_tournament_idx").on(t.tournamentId),
  index("event_teams_league_idx").on(t.leagueId),
]);

// EVENT TEAM MEMBERS — junction linking players/league members to teams
export const eventTeamMembersTable = pgTable("event_team_members", {
  id: serial("id").primaryKey(),
  teamId: integer("team_id").notNull().references(() => eventTeamsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "cascade" }),
  leagueMemberId: integer("league_member_id").references(() => leagueMembersTable.id, { onDelete: "cascade" }),
}, (t) => [
  index("event_team_members_team_idx").on(t.teamId),
  index("event_team_members_player_idx").on(t.playerId),
  index("event_team_members_lm_idx").on(t.leagueMemberId),
]);

export type EventTeam = typeof eventTeamsTable.$inferSelect;
export type EventTeamMember = typeof eventTeamMembersTable.$inferSelect;

// TOURNAMENT RULINGS — official committee decisions with penalty application
export const tournamentRulingsTable = pgTable("tournament_rulings", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  holeNumber: integer("hole_number"),
  round: integer("round").notNull().default(1),
  ruleRef: text("rule_ref"),
  decision: text("decision").notNull(),
  penaltyStrokes: integer("penalty_strokes").notNull().default(0),
  officialName: text("official_name"),
  loggedByUserId: integer("logged_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("rulings_tournament_idx").on(t.tournamentId),
  index("rulings_player_idx").on(t.playerId),
]);

export type TournamentRuling = typeof tournamentRulingsTable.$inferSelect;

// INTERCLUB FIXTURES — league fixtures against external clubs
export const interclubFixturesTable = pgTable("interclub_fixtures", {
  id: serial("id").primaryKey(),
  leagueId: integer("league_id").notNull().references(() => leaguesTable.id, { onDelete: "cascade" }),
  opponentName: text("opponent_name").notNull(),
  fixtureDate: timestamp("fixture_date", { withTimezone: true }),
  venue: text("venue"),
  format: text("format"),
  homeScore: numeric("home_score", { precision: 6, scale: 1 }),
  awayScore: numeric("away_score", { precision: 6, scale: 1 }),
  status: text("status").notNull().default("scheduled"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("interclub_league_idx").on(t.leagueId)]);

export type InterclubFixture = typeof interclubFixturesTable.$inferSelect;
export type LeagueDivision = typeof leagueDivisionsTable.$inferSelect;

export type WatchPairingChallenge = typeof watchPairingChallengesTable.$inferSelect;

// ─── TASK #70: PLAYER SELF-SCORING EXTENSIONS ──────────────────────────────

// Extend round_submissions with marker user ID, countersign info, dispute, committee override, deadline
export const roundSubmissionsExtTable = pgTable("round_submission_ext", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull().unique().references(() => roundSubmissionsTable.id, { onDelete: "cascade" }),
  markerUserId: integer("marker_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  countersignedAt: timestamp("countersigned_at", { withTimezone: true }),
  disputeNote: text("dispute_note"),
  committeeOverrideNote: text("committee_override_note"),
  committeeOverrideByUserId: integer("committee_override_by_user_id"),
  committeeOverrideAt: timestamp("committee_override_at", { withTimezone: true }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  scoringCloseTime: text("scoring_close_time"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "round_submission_ext_committee_override_by_user_id_fk", columns: [t.committeeOverrideByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

// Per-hole correction requests between player submission and marker countersign
export const scorecardCorrectionsTable = pgTable("scorecard_corrections", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull().references(() => roundSubmissionsTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  originalScore: integer("original_score").notNull(),
  requestedScore: integer("requested_score").notNull(),
  reason: text("reason"),
  markerDecision: text("marker_decision"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("scorecard_corrections_submission_idx").on(t.submissionId)]);

// Per-hole flags from marker during the round (live alert to player)
export const scorecardFlagsTable = pgTable("scorecard_flags", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull().references(() => roundSubmissionsTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  markerNote: text("marker_note"),
  playerResponse: text("player_response"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  flaggedAt: timestamp("flagged_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("scorecard_flags_submission_idx").on(t.submissionId)]);

export type RoundSubmissionExt = typeof roundSubmissionsExtTable.$inferSelect;
export type ScorecardCorrection = typeof scorecardCorrectionsTable.$inferSelect;
export type ScorecardFlag = typeof scorecardFlagsTable.$inferSelect;

// ─── TASK #77: WHS COMPLIANCE ENGINE ───────────────────────────────────────

// Tracks each player's WHS establishment state and Low H.I. per organisation
export const whsPlayerStateTable = pgTable("whs_player_state", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  totalHolesPosted: integer("total_holes_posted").notNull().default(0),
  establishmentPhase: integer("establishment_phase").notNull().default(1),
  currentHandicapIndex: numeric("current_handicap_index", { precision: 4, scale: 1 }),
  lowHandicapIndex: numeric("low_handicap_index", { precision: 4, scale: 1 }),
  lowHandicapIndexDate: timestamp("low_handicap_index_date", { withTimezone: true }),
  openingHandicapIndex: numeric("opening_handicap_index", { precision: 4, scale: 1 }),
  isProvisional: boolean("is_provisional").notNull().default(true),
  lastRecalcAt: timestamp("last_recalc_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("whs_player_state_user_org_unique").on(t.userId, t.organizationId),
  index("whs_player_state_org_idx").on(t.organizationId),
]);

// Individual score differential records for the WHS rolling 20-round window
export const whsScoreRecordsTable = pgTable("whs_score_records", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "set null" }),
  sourceType: text("source_type").notNull(),
  sourceTournamentId: integer("source_tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  sourceGeneralPlayId: integer("source_general_play_id"),
  holesPlayed: integer("holes_played").notNull(),
  grossScore: integer("gross_score"),
  adjustedGrossScore: integer("adjusted_gross_score"),
  courseRating: numeric("course_rating", { precision: 4, scale: 1 }),
  slopeRating: integer("slope_rating"),
  pccAdjustment: numeric("pcc_adjustment", { precision: 3, scale: 1 }).notNull().default("0"),
  rawDifferential: numeric("raw_differential", { precision: 5, scale: 1 }),
  esrAdjustment: numeric("esr_adjustment", { precision: 3, scale: 1 }).notNull().default("0"),
  finalDifferential: numeric("final_differential", { precision: 5, scale: 1 }),
  is9Hole: boolean("is_9_hole").notNull().default(false),
  markerName: text("marker_name"),
  markerGhinNumber: text("marker_ghin_number"),
  handicapIndexAfter: numeric("handicap_index_after", { precision: 4, scale: 1 }),
  playedAt: timestamp("played_at", { withTimezone: true }).notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("whs_score_records_user_idx").on(t.userId),
  index("whs_score_records_org_idx").on(t.organizationId),
  index("whs_score_records_played_idx").on(t.playedAt),
]);

// Admin-entered Playing Conditions Calculation (PCC) per course per day
export const whsPccEntriesTable = pgTable("whs_pcc_entries", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  competitionDate: timestamp("competition_date", { withTimezone: true }).notNull(),
  pccValue: numeric("pcc_value", { precision: 3, scale: 1 }).notNull().default("0"),
  notes: text("notes"),
  enteredByUserId: integer("entered_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("whs_pcc_course_date_unique").on(t.courseId, t.competitionDate),
  index("whs_pcc_org_idx").on(t.organizationId),
]);

export type WhsPlayerState = typeof whsPlayerStateTable.$inferSelect;
export type WhsScoreRecord = typeof whsScoreRecordsTable.$inferSelect;
export type WhsPccEntry = typeof whsPccEntriesTable.$inferSelect;

// ─── TASK #75: TEE TIME BOOKING SYSTEM ─────────────────────────────────────

// Slot templates per course per day (generated from tee pricing rules)
export const courseTeeSlotStatusEnum = pgEnum("course_tee_slot_status", [
  "open", "blocked", "booked", "members_only",
]);

export const teeStartTypeEnum = pgEnum("tee_start_type", ["normal", "split_tee", "shotgun"]);

export const courseTeeSlotTable = pgTable("course_tee_slots", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  slotDate: timestamp("slot_date", { withTimezone: true }).notNull(),
  slotTime: text("slot_time").notNull(),
  capacity: integer("capacity").notNull().default(4),
  status: courseTeeSlotStatusEnum("status").notNull().default("open"),
  isMembersOnly: boolean("is_members_only").notNull().default(false),
  startingHole: integer("starting_hole").notNull().default(1),
  startType: teeStartTypeEnum("start_type").notNull().default("normal"),
  templateId: integer("template_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_slot_course_date_idx").on(t.courseId, t.slotDate),
  index("tee_slot_org_idx").on(t.organizationId),
  uniqueIndex("tee_slot_unique_identity_idx").on(t.organizationId, t.courseId, t.slotDate, t.slotTime, t.startingHole),
]);

export const teeBookingStatusEnum = pgEnum("tee_booking_status", [
  "pending", "confirmed", "cancelled", "forfeited", "completed",
]);

export const teeBookingsTable = pgTable("tee_bookings", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull().references(() => courseTeeSlotTable.id, { onDelete: "restrict" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  leadUserId: integer("lead_user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  partySize: integer("party_size").notNull().default(1),
  status: teeBookingStatusEnum("status").notNull().default("pending"),
  paymentModel: text("payment_model").notNull().default("pay_at_checkin"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  cancellationReason: text("cancellation_reason"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cartRequested: boolean("cart_requested").notNull().default(false),
  reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
  reminder2hSentAt: timestamp("reminder_2h_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_bookings_slot_idx").on(t.slotId),
  index("tee_bookings_org_idx").on(t.organizationId),
  index("tee_bookings_lead_idx").on(t.leadUserId),
]);

export const teeBookingPlayerTypeEnum = pgEnum("tee_booking_player_type", ["member", "guest"]);

export const teeBookingPlayersTable = pgTable("tee_booking_players", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => teeBookingsTable.id, { onDelete: "cascade" }),
  playerType: teeBookingPlayerTypeEnum("player_type").notNull().default("member"),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  guestName: text("guest_name"),
  guestEmail: text("guest_email"),
  fee: numeric("fee", { precision: 10, scale: 2 }),
  confirmationStatus: text("confirmation_status").notNull().default("pending"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  declinedAt: timestamp("declined_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tee_booking_players_booking_idx").on(t.bookingId)]);

export const teePricingRulesTable = pgTable("tee_pricing_rules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().unique().references(() => organizationsTable.id, { onDelete: "cascade" }),
  memberRate: numeric("member_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  guestRate: numeric("guest_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  twilightStartTime: text("twilight_start_time"),
  twilightMemberRate: numeric("twilight_member_rate", { precision: 10, scale: 2 }),
  twilightGuestRate: numeric("twilight_guest_rate", { precision: 10, scale: 2 }),
  maxGuestsPerBooking: integer("max_guests_per_booking").notNull().default(3),
  paymentModel: text("payment_model").notNull().default("pay_at_checkin"),
  cancellationCutoffHours: integer("cancellation_cutoff_hours").notNull().default(24),
  cancellationPolicyType: text("cancellation_policy_type").notNull().default("forfeit"),
  cancellationFeeFlat: numeric("cancellation_fee_flat", { precision: 10, scale: 2 }),
  membersOnlyStartTime: text("members_only_start_time"),
  membersOnlyEndTime: text("members_only_end_time"),
  slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(10),
  firstTeeTime: text("first_tee_time").notNull().default("06:00"),
  lastTeeTime: text("last_tee_time").notNull().default("18:00"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CourseTeeSlot = typeof courseTeeSlotTable.$inferSelect;
export type TeeBooking = typeof teeBookingsTable.$inferSelect;
export type TeeBookingPlayer = typeof teeBookingPlayersTable.$inferSelect;
export type TeePricingRule = typeof teePricingRulesTable.$inferSelect;

// ─── TASK #129: TEE SHEET RULES ENGINE ──────────────────────────────────────

export const teeBlockReasonEnum = pgEnum("tee_block_reason", [
  "maintenance", "tournament", "private_event", "members_only", "weather", "other",
]);

export const teeRecurrenceEnum = pgEnum("tee_recurrence", ["one_off", "weekly", "monthly"]);

export const teeMembershipTierEnum = pgEnum("tee_membership_tier", [
  "full_member", "social_member", "guest", "public",
]);

/** Schedule templates — define the repeating pattern that the nightly job uses to materialise slots */
export const teeScheduleTemplatesTable = pgTable("tee_schedule_templates", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull().default([0,1,2,3,4,5,6]),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  firstTeeTime: text("first_tee_time").notNull().default("06:00"),
  lastTeeTime: text("last_tee_time").notNull().default("18:00"),
  intervalMinutes: integer("interval_minutes").notNull().default(10),
  capacity: integer("capacity").notNull().default(4),
  startType: teeStartTypeEnum("start_type").notNull().default("normal"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_schedule_templates_org_idx").on(t.organizationId),
  index("tee_schedule_templates_course_idx").on(t.courseId),
]);

/** Block rules — full-day or time-window blackouts */
export const teeBlockRulesTable = pgTable("tee_block_rules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  blockDate: timestamp("block_date", { withTimezone: true }),
  startTime: text("start_time"),
  endTime: text("end_time"),
  reason: teeBlockReasonEnum("reason").notNull().default("other"),
  recurrence: teeRecurrenceEnum("recurrence").notNull().default("one_off"),
  recurrenceDayOfWeek: integer("recurrence_day_of_week"),
  recurrenceDayOfMonth: integer("recurrence_day_of_month"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_block_rules_org_idx").on(t.organizationId),
  index("tee_block_rules_date_idx").on(t.blockDate),
]);

/** Player count rules — min/max per slot by day, time, membership tier */
export const teePlayerCountRulesTable = pgTable("tee_player_count_rules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  minPlayers: integer("min_players").notNull().default(1),
  maxPlayers: integer("max_players").notNull().default(4),
  daysOfWeek: jsonb("days_of_week").$type<number[]>(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  membershipTier: teeMembershipTierEnum("membership_tier"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tee_player_count_rules_org_idx").on(t.organizationId)]);

/** Booking windows — how many days ahead each membership tier can book */
export const teeBookingWindowsTable = pgTable("tee_booking_windows", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  membershipTier: teeMembershipTierEnum("membership_tier").notNull(),
  daysAhead: integer("days_ahead").notNull().default(30),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tee_booking_windows_org_tier_unique").on(t.organizationId, t.membershipTier),
]);

export type TeeScheduleTemplate = typeof teeScheduleTemplatesTable.$inferSelect;
export type TeeBlockRule = typeof teeBlockRulesTable.$inferSelect;
export type TeePlayerCountRule = typeof teePlayerCountRulesTable.$inferSelect;
export type TeeBookingWindow = typeof teeBookingWindowsTable.$inferSelect;

// ─── TASK #76: GENERAL PLAY ROUNDS ─────────────────────────────────────────

export const generalPlayStatusEnum = pgEnum("general_play_status", [
  "draft", "in_progress", "pending_marker", "confirmed", "disputed", "unverified", "cancelled",
]);

export const generalPlayRoundsTable = pgTable("general_play_rounds", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "restrict" }),
  teeBoxName: text("tee_box_name"),
  courseRating: numeric("course_rating", { precision: 4, scale: 1 }),
  slopeRating: integer("slope_rating"),
  holesPlayed: integer("holes_played").notNull().default(18),
  status: generalPlayStatusEnum("status").notNull().default("draft"),
  grossScore: integer("gross_score"),
  adjustedGrossScore: integer("adjusted_gross_score"),
  scoreDifferential: numeric("score_differential", { precision: 5, scale: 1 }),
  pccUsed: numeric("pcc_used", { precision: 3, scale: 1 }).notNull().default("0"),
  teeBookingId: integer("tee_booking_id").references(() => teeBookingsTable.id, { onDelete: "set null" }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  markerDeadlineAt: timestamp("marker_deadline_at", { withTimezone: true }),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  unverifiedAt: timestamp("unverified_at", { withTimezone: true }),
  notes: text("notes"),
  playedAt: timestamp("played_at", { withTimezone: true }).notNull().defaultNow(),
  // Wave 1 W1-A: optional per-round override of the AI Caddie advice mode.
  // When null the resolver falls through to tournament/league/default.
  aiCaddieMode: aiCaddieModeEnum("ai_caddie_mode"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("general_play_user_idx").on(t.userId),
  index("general_play_org_idx").on(t.organizationId),
  index("general_play_played_idx").on(t.playedAt),
]);

export const generalPlayHoleScoresTable = pgTable("general_play_hole_scores", {
  id: serial("id").primaryKey(),
  roundId: integer("round_id").notNull().references(() => generalPlayRoundsTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  par: integer("par"),
  strokeIndex: integer("stroke_index"),
  strokes: integer("strokes").notNull(),
  putts: integer("putts"),
  cappedStrokes: integer("capped_strokes"),
  fairwayHit: text("fairway_hit"),
  gir: boolean("gir"),
  sandSave: boolean("sand_save"),
  upAndDown: boolean("up_and_down"),
  penalties: integer("penalties"),
  penaltyReason: text("penalty_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("general_play_hole_unique").on(t.roundId, t.holeNumber),
]);

export const generalPlayMarkersTable = pgTable("general_play_markers", {
  id: serial("id").primaryKey(),
  roundId: integer("round_id").notNull().references(() => generalPlayRoundsTable.id, { onDelete: "cascade" }),
  markerUserId: integer("marker_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  markerName: text("marker_name").notNull(),
  markerEmail: text("marker_email"),
  markerGhinNumber: text("marker_ghin_number"),
  confirmationStatus: text("confirmation_status").notNull().default("pending"),
  disputeNote: text("dispute_note"),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("general_play_markers_round_idx").on(t.roundId)]);

export type GeneralPlayRound = typeof generalPlayRoundsTable.$inferSelect;
export type GeneralPlayHoleScore = typeof generalPlayHoleScoresTable.$inferSelect;

// ─── TASK #162: HOLE PIN POSITIONS ──────────────────────────────────────────
// Stores the daily pin position as a lat/lng offset from the green centre.
// Supports both general-play rounds and tournament rounds.
export const holePinPositionsTable = pgTable("hole_pin_positions", {
  id: serial("id").primaryKey(),
  // General play round linkage (nullable when used for tournament rounds)
  generalPlayRoundId: integer("general_play_round_id"),
  // Tournament round linkage (nullable when used for general play)
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "cascade" }),
  roundNumber: integer("round_number"),
  holeNumber: integer("hole_number").notNull(),
  // Offset in degrees from green centre lat/lng (small values, e.g. 0.00001)
  latOffset: numeric("lat_offset", { precision: 10, scale: 8 }).notNull().default("0"),
  lngOffset: numeric("lng_offset", { precision: 10, scale: 8 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("pin_pos_gp_hole_unique").on(t.generalPlayRoundId, t.holeNumber),
  uniqueIndex("pin_pos_tournament_unique").on(t.tournamentId, t.playerId, t.roundNumber, t.holeNumber),
  foreignKey({ name: "hole_pin_positions_general_play_round_id_fk", columns: [t.generalPlayRoundId], foreignColumns: [generalPlayRoundsTable.id] }).onDelete("cascade"),
]);

// ─── TASK #162: HOLE HAZARDS TABLE ──────────────────────────────────────────
// Stores GPS coordinates of hazards (water, bunkers, OB, tree lines) per hole.
// Used for hazard overlay rendering on the Course Map panel.
export const hazardTypeEnum = pgEnum("hazard_type", ["water", "bunker", "ob", "tree_line"]);

export const holeHazardsTable = pgTable("hole_hazards", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  hazardType: hazardTypeEnum("hazard_type").notNull(),
  lat: numeric("lat", { precision: 10, scale: 7 }).notNull(),
  lng: numeric("lng", { precision: 10, scale: 7 }).notNull(),
  radiusMeters: integer("radius_meters").default(10),
  name: text("name"),
}, (t) => [
  index("hole_hazards_course_hole_idx").on(t.courseId, t.holeNumber),
]);

// ─── TASK #358: GREEN CONTOUR DATA (3D greens with slope/break arrows) ─────
// Stores per-hole green contour data — a grid of elevation samples around the
// green centre. Used by the mobile 3D green renderer to colour slope severity
// and to compute putt break vectors from any selected ball position.
export const holeGreenContoursTable = pgTable("hole_green_contours", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  // Grid origin (typically the green centre lat/lng)
  originLat: numeric("origin_lat", { precision: 10, scale: 7 }).notNull(),
  originLng: numeric("origin_lng", { precision: 10, scale: 7 }).notNull(),
  // Grid dimensions and cell size (metres per grid step)
  rows: integer("rows").notNull(),
  cols: integer("cols").notNull(),
  cellMeters: numeric("cell_meters", { precision: 6, scale: 3 }).notNull().default("1.5"),
  // Flat array of elevation samples (length = rows*cols), ordered row-major
  // Stored as JSON for flexibility (LIDAR ingestion, manual entry, vendor data).
  elevations: jsonb("elevations").notNull(),
  source: text("source"), // "lidar" | "survey" | "manual" | "vendor"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("hole_green_contours_unique").on(t.courseId, t.holeNumber),
]);

export type HoleGreenContour = typeof holeGreenContoursTable.$inferSelect;

// ─── TASK #79: MATCH PLAY BRACKETS & RYDER CUP FORMATS ─────────────────────

// Match play bracket type enum: main draw or consolation
export const bracketTypeEnum = pgEnum("bracket_type", ["main", "consolation"]);

// Match result enum: player1_wins, player2_wins, halved (Ryder Cup)
export const matchResultEnum = pgEnum("match_result", [
  "pending", "player1_wins", "player2_wins", "halved", "conceded",
]);

// Ryder Cup session type enum
export const ryderCupSessionTypeEnum = pgEnum("ryder_cup_session_type", [
  "foursomes", "four_ball", "singles",
]);

// MATCH PLAY BRACKET — one bracket per tournament
export const matchPlayBracketTable = pgTable("match_play_brackets", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().unique().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  seededFrom: integer("seeded_from_tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  seedingMethod: text("seeding_method").notNull().default("manual"),
  // single_elim | double_elim | round_robin
  format: text("format").notNull().default("single_elim"),
  // sudden_death | extra_holes_3 | none
  tieBreakRule: text("tie_break_rule").notNull().default("sudden_death"),
  shareToken: text("share_token").unique(),
  hasConsolation: boolean("has_consolation").notNull().default(false),
  totalRounds: integer("total_rounds").notNull().default(1),
  drawGeneratedAt: timestamp("draw_generated_at", { withTimezone: true }),
  // Set when all matches have completed (and any tie-break is resolved)
  completedAt: timestamp("completed_at", { withTimezone: true }),
  championId: integer("champion_id").references(() => playersTable.id, { onDelete: "set null" }),
  runnerUpId: integer("runner_up_id").references(() => playersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("match_play_bracket_tournament_idx").on(t.tournamentId)]);

// BRACKET ROUNDS — each round of the bracket (R16, QF, SF, F, etc.)
export const bracketRoundsTable = pgTable("bracket_rounds", {
  id: serial("id").primaryKey(),
  bracketId: integer("bracket_id").notNull().references(() => matchPlayBracketTable.id, { onDelete: "cascade" }),
  roundNumber: integer("round_number").notNull(),
  name: text("name").notNull(),
  bracketType: bracketTypeEnum("bracket_type").notNull().default("main"),
  scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("bracket_round_unique").on(t.bracketId, t.roundNumber, t.bracketType),
  index("bracket_rounds_bracket_idx").on(t.bracketId),
]);

// BRACKET MATCHES — individual matches within a bracket round
export const bracketMatchesTable = pgTable("bracket_matches", {
  id: serial("id").primaryKey(),
  bracketId: integer("bracket_id").notNull().references(() => matchPlayBracketTable.id, { onDelete: "cascade" }),
  roundId: integer("round_id").notNull().references(() => bracketRoundsTable.id, { onDelete: "cascade" }),
  matchNumber: integer("match_number").notNull(),
  bracketType: bracketTypeEnum("bracket_type").notNull().default("main"),
  player1Id: integer("player1_id").references(() => playersTable.id, { onDelete: "set null" }),
  player2Id: integer("player2_id").references(() => playersTable.id, { onDelete: "set null" }),
  player1IsBye: boolean("player1_is_bye").notNull().default(false),
  player2IsBye: boolean("player2_is_bye").notNull().default(false),
  result: matchResultEnum("result").notNull().default("pending"),
  winnerId: integer("winner_id").references(() => playersTable.id, { onDelete: "set null" }),
  // Hole-by-hole match status: { holeNumber: "player1" | "player2" | "halved" }
  holeResults: jsonb("hole_results").$type<Record<number, "player1" | "player2" | "halved">>().default({}),
  // Running match status as string: e.g. "2 UP", "1 DOWN", "ALL SQUARE"
  matchStatus: text("match_status"),
  // Concession info
  conceededByPlayerId: integer("conceded_by_player_id").references(() => playersTable.id, { onDelete: "set null" }),
  conceededOnHole: integer("conceded_on_hole"),
  nextMatchId: integer("next_match_id"),
  // Deterministic slot in the next match for the winner (1 or 2). Null = first-empty fallback.
  nextWinnerSlot: integer("next_winner_slot"),
  // For double-elim: where the loser is routed (losers bracket match id)
  nextLoserMatchId: integer("next_loser_match_id"),
  // Deterministic slot in the LB match for the loser (1 or 2). Null = first-empty fallback.
  nextLoserSlot: integer("next_loser_slot"),
  // Self-referential after insert — not FK to avoid circular deps
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("bracket_match_round_num_unique").on(t.roundId, t.matchNumber, t.bracketType),
  index("bracket_matches_bracket_idx").on(t.bracketId),
  index("bracket_matches_round_idx").on(t.roundId),
  index("bracket_matches_player1_idx").on(t.player1Id),
  index("bracket_matches_player2_idx").on(t.player2Id),
]);

// RYDER CUP SESSIONS — Foursomes / Four-Ball / Singles sessions
export const ryderCupSessionsTable = pgTable("ryder_cup_sessions", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  sessionNumber: integer("session_number").notNull(),
  sessionType: ryderCupSessionTypeEnum("session_type").notNull().default("singles"),
  name: text("name").notNull(),
  team1Name: text("team1_name").notNull().default("Team 1"),
  team2Name: text("team2_name").notNull().default("Team 2"),
  scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ryder_cup_session_unique").on(t.tournamentId, t.sessionNumber),
  index("ryder_cup_sessions_tournament_idx").on(t.tournamentId),
]);

// RYDER CUP MATCHES — individual match play matches in a session
export const ryderCupMatchesTable = pgTable("ryder_cup_matches", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => ryderCupSessionsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  matchNumber: integer("match_number").notNull(),
  // For singles: player1 and player2; for foursomes/four-ball: partner1/partner2 per team
  team1Player1Id: integer("team1_player1_id").references(() => playersTable.id, { onDelete: "set null" }),
  team1Player2Id: integer("team1_player2_id").references(() => playersTable.id, { onDelete: "set null" }),
  team2Player1Id: integer("team2_player1_id").references(() => playersTable.id, { onDelete: "set null" }),
  team2Player2Id: integer("team2_player2_id").references(() => playersTable.id, { onDelete: "set null" }),
  result: matchResultEnum("result").notNull().default("pending"),
  // Points awarded: 1 for win, 0.5 for halved, 0 for loss
  team1Points: numeric("team1_points", { precision: 3, scale: 1 }).notNull().default("0"),
  team2Points: numeric("team2_points", { precision: 3, scale: 1 }).notNull().default("0"),
  // Hole-by-hole match status
  holeResults: jsonb("hole_results").$type<Record<number, "team1" | "team2" | "halved">>().default({}),
  matchStatus: text("match_status"),
  conceededByTeam: text("conceded_by_team"),
  conceededOnHole: integer("conceded_on_hole"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ryder_cup_match_session_num_unique").on(t.sessionId, t.matchNumber),
  index("ryder_cup_matches_session_idx").on(t.sessionId),
  index("ryder_cup_matches_tournament_idx").on(t.tournamentId),
]);

// RYDER CUP CONFIG — team names and overall point totals per tournament
export const ryderCupConfigTable = pgTable("ryder_cup_config", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().unique().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  team1Name: text("team1_name").notNull().default("Team 1"),
  team2Name: text("team2_name").notNull().default("Team 2"),
  team1Colour: text("team1_colour").default("#1e40af"),
  team2Colour: text("team2_colour").default("#dc2626"),
  totalPoints: integer("total_points").notNull().default(28),
  team1TotalPoints: numeric("team1_total_points", { precision: 6, scale: 1 }).notNull().default("0"),
  team2TotalPoints: numeric("team2_total_points", { precision: 6, scale: 1 }).notNull().default("0"),
  tieBreakRule: text("tie_break_rule").notNull().default("sudden_death"),
  shareToken: text("share_token").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ryder_cup_config_tournament_idx").on(t.tournamentId)]);

export type MatchPlayBracket = typeof matchPlayBracketTable.$inferSelect;
export type BracketRound = typeof bracketRoundsTable.$inferSelect;
export type BracketMatch = typeof bracketMatchesTable.$inferSelect;
export type RyderCupSession = typeof ryderCupSessionsTable.$inferSelect;
export type RyderCupMatch = typeof ryderCupMatchesTable.$inferSelect;
export type RyderCupConfig = typeof ryderCupConfigTable.$inferSelect;
export type GeneralPlayMarker = typeof generalPlayMarkersTable.$inferSelect;


export const cartStatusEnum = pgEnum("cart_status", [
  "available", "in_use", "maintenance", "retired",
]);

export const cartTypeEnum = pgEnum("cart_type", ["single", "double"]);

export const cartsTable = pgTable("carts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  identifier: text("identifier").notNull(),
  type: cartTypeEnum("type").notNull().default("double"),
  status: cartStatusEnum("status").notNull().default("available"),
  notes: text("notes"),
  nextServiceDue: timestamp("next_service_due", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("carts_org_identifier_unique").on(t.organizationId, t.identifier),
  index("carts_org_idx").on(t.organizationId),
]);

export const cartAssignmentsTable = pgTable("cart_assignments", {
  id: serial("id").primaryKey(),
  cartId: integer("cart_id").notNull().references(() => cartsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  bookingId: integer("booking_id").references(() => teeBookingsTable.id, { onDelete: "set null" }),
  assignedByUserId: integer("assigned_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  playerName: text("player_name"),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  expectedReturnAt: timestamp("expected_return_at", { withTimezone: true }),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  overdueAlertSentAt: timestamp("overdue_alert_sent_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("cart_assignments_cart_idx").on(t.cartId),
  index("cart_assignments_org_idx").on(t.organizationId),
  index("cart_assignments_booking_idx").on(t.bookingId),
  // Partial unique index — enforces one active assignment per cart at DB level.
  // The WHERE clause is expressed via sql`` since Drizzle partial indexes use it for the condition.
  uniqueIndex("cart_assignments_active_unique")
    .on(t.cartId)
    .where(sql`${t.returnedAt} IS NULL`),
]);

export const cartMaintenanceLogsTable = pgTable("cart_maintenance_logs", {
  id: serial("id").primaryKey(),
  cartId: integer("cart_id").notNull().references(() => cartsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  serviceDate: timestamp("service_date", { withTimezone: true }).notNull(),
  nextServiceDue: timestamp("next_service_due", { withTimezone: true }),
  notes: text("notes").notNull(),
  loggedByUserId: integer("logged_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("cart_maintenance_logs_cart_idx").on(t.cartId),
  index("cart_maintenance_logs_org_idx").on(t.organizationId),
]);

export type Cart = typeof cartsTable.$inferSelect;
export type CartAssignment = typeof cartAssignmentsTable.$inferSelect;
export type CartMaintenanceLog = typeof cartMaintenanceLogsTable.$inferSelect;

// ─── TASK #118: CLUB NOTICE BOARD & CONTENT MANAGEMENT ───────────────────────

export const noticeBoardArticleStatusEnum = pgEnum("notice_board_article_status", [
  "draft", "scheduled", "published", "archived",
]);

export const noticeBoardCategoriesTable = pgTable("notice_board_categories", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color").notNull().default("#C9A84C"),
  icon: text("icon").notNull().default("newspaper"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("notice_board_categories_org_idx").on(t.organizationId),
]);

export const noticeBoardArticlesTable = pgTable("notice_board_articles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => noticeBoardCategoriesTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  imageUrl: text("image_url"),
  isPinned: boolean("is_pinned").notNull().default(false),
  isImportant: boolean("is_important").notNull().default(false),
  isSponsored: boolean("is_sponsored").notNull().default(false),
  sponsorUrl: text("sponsor_url"),
  status: noticeBoardArticleStatusEnum("status").notNull().default("draft"),
  publishAt: timestamp("publish_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  authorUserId: integer("author_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  authorName: text("author_name"),
  attachments: jsonb("attachments").$type<{ name: string; url: string; type: string }[]>().notNull().default([]),
  viewCount: integer("view_count").notNull().default(0),
  clickCount: integer("click_count").notNull().default(0),
  notificationSent: boolean("notification_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("notice_board_articles_org_idx").on(t.organizationId),
  index("notice_board_articles_status_idx").on(t.status),
  index("notice_board_articles_pinned_idx").on(t.isPinned),
  index("notice_board_articles_publish_at_idx").on(t.publishAt),
]);

export const noticeBoardReadsTable = pgTable("notice_board_reads", {
  id: serial("id").primaryKey(),
  articleId: integer("article_id").notNull().references(() => noticeBoardArticlesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("notice_board_reads_unique").on(t.articleId, t.userId),
  index("notice_board_reads_user_idx").on(t.userId),
]);

export type NoticeBoardCategory = typeof noticeBoardCategoriesTable.$inferSelect;
export type NoticeBoardArticle = typeof noticeBoardArticlesTable.$inferSelect;
export type NoticeBoardRead = typeof noticeBoardReadsTable.$inferSelect;

// ─── TASK #81: FANTASY GOLF LEAGUE ──────────────────────────────────────────

export const fantasyLeagueStatusEnum = pgEnum("fantasy_league_status", [
  "setup", "drafting", "active", "completed",
]);

export const fantasyLeagueFormatEnum = pgEnum("fantasy_league_format", [
  "overall_standings", "head_to_head",
]);

export const fantasyDraftTypeEnum = pgEnum("fantasy_draft_type", [
  "snake", "simultaneous",
]);

/**
 * A fantasy league is tied to an existing real (golf) league or a tournament.
 * Members form fantasy teams by drafting real tournament players and earn
 * fantasy points based on actual scoring outcomes.
 */
export const fantasyLeaguesTable = pgTable("fantasy_leagues", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "set null" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  status: fantasyLeagueStatusEnum("status").notNull().default("setup"),
  format: fantasyLeagueFormatEnum("format").notNull().default("overall_standings"),
  draftType: fantasyDraftTypeEnum("draft_type").notNull().default("snake"),
  rosterSize: integer("roster_size").notNull().default(5),
  maxTeams: integer("max_teams"),
  draftDeadlineAt: timestamp("draft_deadline_at", { withTimezone: true }),
  rosterLockAt: timestamp("roster_lock_at", { withTimezone: true }),
  inviteCode: text("invite_code").unique(),
  commissionerUserId: integer("commissioner_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fantasy_leagues_org_idx").on(t.organizationId),
  index("fantasy_leagues_league_idx").on(t.leagueId),
  index("fantasy_leagues_tournament_idx").on(t.tournamentId),
]);

/**
 * A fantasy scoring rule maps a real golf event (birdie, eagle, etc.) to fantasy points.
 * Each fantasy league can configure its own point values.
 */
export const fantasyScoreEventEnum = pgEnum("fantasy_score_event", [
  "hole_in_one", "eagle", "birdie", "par", "bogey", "double_bogey", "triple_bogey_plus",
  "finish_1st", "finish_2nd", "finish_3rd", "finish_top5", "finish_top10",
  "under_par_round", "par_round",
]);

export const fantasyScoringRulesTable = pgTable("fantasy_scoring_rules", {
  id: serial("id").primaryKey(),
  fantasyLeagueId: integer("fantasy_league_id").notNull().references(() => fantasyLeaguesTable.id, { onDelete: "cascade" }),
  event: fantasyScoreEventEnum("event").notNull(),
  points: integer("points").notNull().default(0),
}, (t) => [
  uniqueIndex("fantasy_scoring_rule_unique").on(t.fantasyLeagueId, t.event),
]);

/**
 * A fantasy team belongs to one fantasy league, owned by a club member/user.
 * draftOrder is assigned when the draft begins (snake or simultaneous).
 */
export const fantasyTeamsTable = pgTable("fantasy_teams", {
  id: serial("id").primaryKey(),
  fantasyLeagueId: integer("fantasy_league_id").notNull().references(() => fantasyLeaguesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  draftOrder: integer("draft_order"),
  totalFantasyPoints: integer("total_fantasy_points").notNull().default(0),
  position: integer("position"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("fantasy_team_user_league_unique").on(t.fantasyLeagueId, t.userId),
  index("fantasy_teams_league_idx").on(t.fantasyLeagueId),
]);

/**
 * Draft picks: each pick records which fantasy team selected which real player
 * at which pick number. Supports both snake and simultaneous draft.
 */
export const fantasyDraftPicksTable = pgTable("fantasy_draft_picks", {
  id: serial("id").primaryKey(),
  fantasyLeagueId: integer("fantasy_league_id").notNull().references(() => fantasyLeaguesTable.id, { onDelete: "cascade" }),
  fantasyTeamId: integer("fantasy_team_id").notNull().references(() => fantasyTeamsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  pickNumber: integer("pick_number").notNull(),
  round: integer("round").notNull().default(1),
  pickedAt: timestamp("picked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("fantasy_pick_league_player_unique").on(t.fantasyLeagueId, t.playerId),
  uniqueIndex("fantasy_pick_number_unique").on(t.fantasyLeagueId, t.pickNumber),
  index("fantasy_picks_team_idx").on(t.fantasyTeamId),
]);

/**
 * Running fantasy points per team per drafted player.
 * Updated automatically as real tournament scores come in.
 */
export const fantasyStandingsTable = pgTable("fantasy_standings", {
  id: serial("id").primaryKey(),
  fantasyLeagueId: integer("fantasy_league_id").notNull().references(() => fantasyLeaguesTable.id, { onDelete: "cascade" }),
  fantasyTeamId: integer("fantasy_team_id").notNull().references(() => fantasyTeamsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  fantasyPoints: integer("fantasy_points").notNull().default(0),
  pointsBreakdown: jsonb("points_breakdown").$type<Record<string, number>>().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("fantasy_standing_unique").on(t.fantasyTeamId, t.playerId),
  index("fantasy_standings_league_idx").on(t.fantasyLeagueId),
]);

/**
 * Head-to-head matchups between two fantasy teams in a given round.
 */
export const fantasyMatchupsTable = pgTable("fantasy_matchups", {
  id: serial("id").primaryKey(),
  fantasyLeagueId: integer("fantasy_league_id").notNull().references(() => fantasyLeaguesTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  homeTeamId: integer("home_team_id").notNull().references(() => fantasyTeamsTable.id, { onDelete: "cascade" }),
  awayTeamId: integer("away_team_id").notNull().references(() => fantasyTeamsTable.id, { onDelete: "cascade" }),
  homePoints: integer("home_points").notNull().default(0),
  awayPoints: integer("away_points").notNull().default(0),
  winnerId: integer("winner_id").references(() => fantasyTeamsTable.id, { onDelete: "set null" }),
  isCompleted: boolean("is_completed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fantasy_matchups_league_idx").on(t.fantasyLeagueId),
]);

export type FantasyLeague = typeof fantasyLeaguesTable.$inferSelect;
export type FantasyTeam = typeof fantasyTeamsTable.$inferSelect;
export type FantasyDraftPick = typeof fantasyDraftPicksTable.$inferSelect;
export type FantasyScoringRule = typeof fantasyScoringRulesTable.$inferSelect;
export type FantasyStanding = typeof fantasyStandingsTable.$inferSelect;
export type FantasyMatchup = typeof fantasyMatchupsTable.$inferSelect;

// ─── LESSON & COACHING BOOKING (Task #87) ────────────────────────────────────

export const lessonBookingStatusEnum = pgEnum("lesson_booking_status", [
  "pending", "confirmed", "cancelled", "completed", "no_show",
]);

export const lessonPaymentStatusEnum = pgEnum("lesson_payment_status", [
  "unpaid", "pending", "paid", "refunded",
]);

// TEACHING PROS — registered coaches per org
export const teachingProsTable = pgTable("teaching_pros", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  displayName: text("display_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  bio: text("bio"),
  photoUrl: text("photo_url"),
  specialisms: jsonb("specialisms").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  cancellationWindowHours: integer("cancellation_window_hours").notNull().default(24),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("teaching_pros_org_idx").on(t.organizationId),
  index("teaching_pros_user_idx").on(t.userId),
]);

// LESSON TYPES — configurable lesson offerings per pro
export const lessonTypesTable = pgTable("lesson_types", {
  id: serial("id").primaryKey(),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  pricePaise: integer("price_paise").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("lesson_types_pro_idx").on(t.proId),
  index("lesson_types_org_idx").on(t.organizationId),
]);

// PRO AVAILABILITY — weekly recurring + one-off overrides
export const proAvailabilityTable = pgTable("pro_availability", {
  id: serial("id").primaryKey(),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  // For recurring slots: dayOfWeek 0=Sun..6=Sat, startTime/endTime in HH:MM
  dayOfWeek: integer("day_of_week"),
  startTime: text("start_time"),
  endTime: text("end_time"),
  // For one-off specific date slots (overrides recurring)
  specificDate: timestamp("specific_date", { withTimezone: true }),
  isBlocked: boolean("is_blocked").notNull().default(false),
  slotIntervalMinutes: integer("slot_interval_minutes").notNull().default(30),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("pro_availability_pro_idx").on(t.proId),
]);

// LESSON BOOKINGS — member reservations for coaching sessions
export const lessonBookingsTable = pgTable("lesson_bookings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  lessonTypeId: integer("lesson_type_id").notNull().references(() => lessonTypesTable.id, { onDelete: "restrict" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  memberName: text("member_name").notNull(),
  memberEmail: text("member_email"),
  memberPhone: text("member_phone"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  status: lessonBookingStatusEnum("status").notNull().default("pending"),
  paymentStatus: lessonPaymentStatusEnum("payment_status").notNull().default("unpaid"),
  amountPaise: integer("amount_paise").notNull().default(0),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  notes: text("notes"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByUserId: integer("cancelled_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("lesson_bookings_pro_idx").on(t.proId),
  index("lesson_bookings_user_idx").on(t.userId),
  index("lesson_bookings_org_idx").on(t.organizationId),
  index("lesson_bookings_scheduled_idx").on(t.scheduledAt),
]);

// COACHING NOTES — private post-lesson notes per booking
export const coachingNotesTable = pgTable("coaching_notes", {
  id: serial("id").primaryKey(),
  bookingId: integer("booking_id").notNull().references(() => lessonBookingsTable.id, { onDelete: "cascade" }),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("coaching_note_booking_unique").on(t.bookingId),
  index("coaching_notes_pro_idx").on(t.proId),
]);

export type TeachingPro = typeof teachingProsTable.$inferSelect;
export type LessonType = typeof lessonTypesTable.$inferSelect;
export type ProAvailability = typeof proAvailabilityTable.$inferSelect;
export type LessonBooking = typeof lessonBookingsTable.$inferSelect;
export type CoachingNote = typeof coachingNotesTable.$inferSelect;

export const lockerStatusEnum = pgEnum("locker_status", [
  "available", "occupied", "reserved", "maintenance",
]);

export const lockerAssignmentStatusEnum = pgEnum("locker_assignment_status", [
  "active", "expired", "cancelled", "pending_payment",
]);

export const lockerPaymentMethodEnum = pgEnum("locker_payment_method", [
  "account_charge", "razorpay",
]);

/** Represents a single physical locker unit in a bay. */
export const lockersTable = pgTable("lockers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  lockerNumber: text("locker_number").notNull(),
  bay: text("bay"),
  row: integer("row"),
  column: integer("column"),
  status: lockerStatusEnum("status").notNull().default("available"),
  annualFee: numeric("annual_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("locker_org_number_unique").on(t.organizationId, t.lockerNumber),
  index("lockers_org_idx").on(t.organizationId),
]);

/** Assignment of a locker to a club member with rental period details. */
export const lockerAssignmentsTable = pgTable("locker_assignments", {
  id: serial("id").primaryKey(),
  lockerId: integer("locker_id").notNull().references(() => lockersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => clubMembersTable.id, { onDelete: "restrict" }),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  expiryDate: timestamp("expiry_date", { withTimezone: true }).notNull(),
  status: lockerAssignmentStatusEnum("status").notNull().default("active"),
  annualFee: numeric("annual_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  paymentMethod: lockerPaymentMethodEnum("payment_method").notNull().default("account_charge"),
  paymentStatus: paymentStatusEnum("payment_status").notNull().default("unpaid"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  paymentLinkId: text("payment_link_id"),
  paymentLinkUrl: text("payment_link_url"),
  assignedBy: integer("assigned_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  reassignedAt: timestamp("reassigned_at", { withTimezone: true }),
  reassignedReason: text("reassigned_reason"),
  notes: text("notes"),
  reminder30SentAt: timestamp("reminder_30_sent_at", { withTimezone: true }),
  reminder7SentAt: timestamp("reminder_7_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("locker_assignments_locker_idx").on(t.lockerId),
  index("locker_assignments_member_idx").on(t.memberId),
  index("locker_assignments_expiry_idx").on(t.expiryDate),
]);

/** Audit trail for locker reassignment events. */
export const lockerAuditTable = pgTable("locker_audit", {
  id: serial("id").primaryKey(),
  lockerId: integer("locker_id").notNull().references(() => lockersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  previousMemberId: integer("previous_member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),
  newMemberId: integer("new_member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),
  performedBy: integer("performed_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("locker_audit_locker_idx").on(t.lockerId)]);

/** Waitlist for members wanting a locker when none are available. */
export const lockerWaitlistTable = pgTable("locker_waitlist", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  status: text("status").notNull().default("waiting"),
  notes: text("notes"),
}, (t) => [
  uniqueIndex("locker_waitlist_org_member_unique").on(t.organizationId, t.memberId),
  index("locker_waitlist_org_idx").on(t.organizationId),
]);

export type Locker = typeof lockersTable.$inferSelect;
export type LockerAssignment = typeof lockerAssignmentsTable.$inferSelect;
export type LockerWaitlist = typeof lockerWaitlistTable.$inferSelect;
export type LockerAudit = typeof lockerAuditTable.$inferSelect;

// ─── TASK #86: FOOD & BEVERAGE ON-COURSE ORDERING ─────────────────────────────────

export const fbOrderStatusEnum = pgEnum("fb_order_status", [
  "received", "preparing", "ready", "delivered", "cancelled",
]);

export const fbPaymentMethodEnum = pgEnum("fb_payment_method", [
  "account_charge", "card_on_delivery",
]);

export const fbFulfillmentStationsTable = pgTable("fb_fulfillment_stations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  holesServed: jsonb("holes_served").$type<number[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("fb_stations_org_idx").on(t.organizationId)]);

export const fbMenuCategoriesTable = pgTable("fb_menu_categories", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("fb_categories_org_idx").on(t.organizationId)]);

export const fbMenuItemsTable = pgTable("fb_menu_items", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").references(() => fbMenuCategoriesTable.id, { onDelete: "set null" }),
  stationId: integer("station_id").references(() => fbFulfillmentStationsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  imageUrl: text("image_url"),
  isAvailable: boolean("is_available").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  inventoryVariantId: integer("inventory_variant_id").references((): AnyPgColumn => shopProductVariantsTable.id, { onDelete: "set null" }),
  inventoryDeductQty: integer("inventory_deduct_qty").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fb_items_org_idx").on(t.organizationId),
  index("fb_items_category_idx").on(t.categoryId),
]);

// ─── F&B MODIFIERS (Toast/Square-style modifier groups & options) ────────────

export const fbModifierGroupsTable = pgTable("fb_modifier_groups", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  selectionType: text("selection_type").notNull().default("single"), // 'single' | 'multiple'
  isRequired: boolean("is_required").notNull().default(false),
  minSelections: integer("min_selections").notNull().default(0),
  maxSelections: integer("max_selections"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("fb_mod_groups_org_idx").on(t.organizationId)]);

export const fbModifierOptionsTable = pgTable("fb_modifier_options", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => fbModifierGroupsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  priceDelta: numeric("price_delta", { precision: 10, scale: 2 }).notNull().default("0"),
  isAvailable: boolean("is_available").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("fb_mod_options_group_idx").on(t.groupId)]);

export const fbMenuItemModifierGroupsTable = pgTable("fb_menu_item_modifier_groups", {
  id: serial("id").primaryKey(),
  menuItemId: integer("menu_item_id").notNull().references(() => fbMenuItemsTable.id, { onDelete: "cascade" }),
  groupId: integer("group_id").notNull().references(() => fbModifierGroupsTable.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [
  uniqueIndex("fb_item_mod_group_unique").on(t.menuItemId, t.groupId),
]);

// ─── F&B SERVICE PERIODS (breakfast / lunch / dinner / etc.) ──────────────────

export const fbServicePeriodsTable = pgTable("fb_service_periods", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startTime: text("start_time").notNull(), // 'HH:MM' (24h)
  endTime: text("end_time").notNull(),
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull().default([0,1,2,3,4,5,6]), // 0=Sun..6=Sat
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("fb_service_periods_org_idx").on(t.organizationId)]);

export const fbMenuItemServicePeriodsTable = pgTable("fb_menu_item_service_periods", {
  id: serial("id").primaryKey(),
  menuItemId: integer("menu_item_id").notNull().references(() => fbMenuItemsTable.id, { onDelete: "cascade" }),
  servicePeriodId: integer("service_period_id").notNull(),
}, (t) => [
  uniqueIndex("fb_item_period_unique").on(t.menuItemId, t.servicePeriodId),
  foreignKey({ name: "fb_menu_item_service_periods_service_period_id_fk", columns: [t.servicePeriodId], foreignColumns: [fbServicePeriodsTable.id] }).onDelete("cascade"),
]);

// ─── F&B TABS (table service) ─────────────────────────────────────────────────

export const fbTabStatusEnum = pgEnum("fb_tab_status", ["open", "closed", "voided"]);

export const fbTabsTable = pgTable("fb_tabs", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tableLabel: text("table_label").notNull(),
  guestName: text("guest_name"),
  partySize: integer("party_size").notNull().default(1),
  status: fbTabStatusEnum("status").notNull().default("open"),
  serverUserId: integer("server_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  clubMemberId: integer("club_member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedByUserId: integer("closed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  closedPaymentMethod: text("closed_payment_method"), // 'cash' | 'card' | 'member_account'
  closedTotal: numeric("closed_total", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fb_tabs_org_idx").on(t.organizationId),
  index("fb_tabs_status_idx").on(t.status),
]);

export const fbOrderTypeEnum = pgEnum("fb_order_type", ["counter", "table", "on_course"]);

export const fbOrdersTable = pgTable("fb_orders", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  stationId: integer("station_id").references(() => fbFulfillmentStationsTable.id, { onDelete: "set null" }),
  tabId: integer("tab_id").references(() => fbTabsTable.id, { onDelete: "set null" }),
  serverUserId: integer("server_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  orderType: fbOrderTypeEnum("order_type").notNull().default("on_course"),
  tableLabel: text("table_label"),
  holeNumber: integer("hole_number"),
  status: fbOrderStatusEnum("status").notNull().default("received"),
  paymentMethod: fbPaymentMethodEnum("payment_method").notNull().default("card_on_delivery"),
  paymentStatus: text("payment_status").notNull().default("pending"),
  paymentReference: text("payment_reference"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  notes: text("notes"),
  bumpedAt: timestamp("bumped_at", { withTimezone: true }),
  recalledAt: timestamp("recalled_at", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fb_orders_org_idx").on(t.organizationId),
  index("fb_orders_user_idx").on(t.userId),
  index("fb_orders_station_idx").on(t.stationId),
  index("fb_orders_status_idx").on(t.status),
  index("fb_orders_tab_idx").on(t.tabId),
  index("fb_orders_server_idx").on(t.serverUserId),
]);

export const fbOrderItemsTable = pgTable("fb_order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => fbOrdersTable.id, { onDelete: "cascade" }),
  menuItemId: integer("menu_item_id").references(() => fbMenuItemsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
  modifiers: jsonb("modifiers").$type<Array<{ groupId?: number; groupName?: string; optionId?: number; name: string; priceDelta: string }>>().default([]),
  modifierTotal: numeric("modifier_total", { precision: 10, scale: 2 }).notNull().default("0"),
  itemNotes: text("item_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("fb_order_items_order_idx").on(t.orderId)]);

export type FbFulfillmentStation = typeof fbFulfillmentStationsTable.$inferSelect;
export type FbMenuCategory = typeof fbMenuCategoriesTable.$inferSelect;
export type FbMenuItem = typeof fbMenuItemsTable.$inferSelect;
export type FbOrder = typeof fbOrdersTable.$inferSelect;
export type FbOrderItem = typeof fbOrderItemsTable.$inferSelect;
export type FbModifierGroup = typeof fbModifierGroupsTable.$inferSelect;
export type FbModifierOption = typeof fbModifierOptionsTable.$inferSelect;
export type FbServicePeriod = typeof fbServicePeriodsTable.$inferSelect;
export type FbTab = typeof fbTabsTable.$inferSelect;

// ─── CORPORATE & CHARITY GOLF EVENTS (Task #92) ───────────────────────────────

export const eventTypeEnum = pgEnum("event_type", ["standard", "corporate", "charity"]);

// CORPORATE EVENT PROFILES — branding & invoice details per corporate tournament
export const corporateEventProfilesTable = pgTable("corporate_event_profiles", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().unique().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").default("#1e4d2b"),
  secondaryColor: text("secondary_color").default("#ffffff"),
  invoiceAddress: text("invoice_address"),
  vatNumber: text("vat_number"),
  purchaseOrderRef: text("purchase_order_ref"),
  invoiceNotes: text("invoice_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("corp_profiles_tournament_idx").on(t.tournamentId),
]);

// CORPORATE TEAMS — company teams within a corporate tournament
export const corporateTeamsTable = pgTable("corporate_teams", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  teamName: text("team_name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  logoUrl: text("logo_url"),
  colour: text("colour").default("#22c55e"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("corp_teams_tournament_idx").on(t.tournamentId),
]);

// Link players to corporate teams
export const corporateTeamMembersTable = pgTable("corporate_team_members", {
  id: serial("id").primaryKey(),
  teamId: integer("team_id").notNull().references(() => corporateTeamsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
}, (t) => [
  uniqueIndex("corp_team_member_unique").on(t.teamId, t.playerId),
  index("corp_team_members_player_idx").on(t.playerId),
]);

// CHARITY CHALLENGE CONFIG — on-course challenges with donation targets
export const charityChallengesTable = pgTable("charity_challenges", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  challengeType: text("challenge_type").notNull().default("longest_drive"),
  holeNumber: integer("hole_number"),
  unit: text("unit").default("metres"),
  donationPerUnit: numeric("donation_per_unit", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("GBP"),
  fixedDonation: numeric("fixed_donation", { precision: 10, scale: 2 }),
  targetAmount: numeric("target_amount", { precision: 10, scale: 2 }),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("charity_challenges_tournament_idx").on(t.tournamentId),
]);

// CHARITY FUNDRAISING TOTALS — manual + linked donation tracking
export const charityFundraisingTotalsTable = pgTable("charity_fundraising_totals", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().unique().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  charityName: text("charity_name").notNull(),
  charityLogoUrl: text("charity_logo_url"),
  targetAmount: numeric("target_amount", { precision: 10, scale: 2 }),
  raisedAmount: numeric("raised_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("GBP"),
  justgivingUrl: text("justgiving_url"),
  gofundmeUrl: text("gofundme_url"),
  donationPageUrl: text("donation_page_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("charity_totals_tournament_idx").on(t.tournamentId),
]);

// CHARITY CHALLENGE RESULTS — per-challenge donation outcomes
export const charityChallengeResultsTable = pgTable("charity_challenge_results", {
  id: serial("id").primaryKey(),
  challengeId: integer("challenge_id").notNull().references(() => charityChallengesTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  winnerPlayerId: integer("winner_player_id").references(() => playersTable.id, { onDelete: "set null" }),
  winnerName: text("winner_name"),
  achievedValue: numeric("achieved_value", { precision: 10, scale: 2 }),
  donationAmount: numeric("donation_amount", { precision: 10, scale: 2 }),
  notes: text("notes"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("charity_results_challenge_idx").on(t.challengeId),
  index("charity_results_tournament_idx").on(t.tournamentId),
]);

export type CorporateEventProfile = typeof corporateEventProfilesTable.$inferSelect;
export type CorporateTeam = typeof corporateTeamsTable.$inferSelect;
export type CorporateTeamMember = typeof corporateTeamMembersTable.$inferSelect;
export type CharityChallenge = typeof charityChallengesTable.$inferSelect;
export type CharityFundraisingTotal = typeof charityFundraisingTotalsTable.$inferSelect;
export type CharityChallengeResult = typeof charityChallengeResultsTable.$inferSelect;

// ─── CLUB ADMINISTRATION & GOVERNANCE HUB (Task #93) ─────────────────────────

export const documentAccessEnum = pgEnum("document_access", [
  "public", "all_members", "committee_only",
]);

export const documentCategoryEnum = pgEnum("document_category", [
  "constitution", "handicap_policy", "course_rules", "committee_minutes",
  "agm_documents", "financial_reports", "bylaws", "other",
]);

export const meetingStatusEnum = pgEnum("meeting_status", [
  "scheduled", "in_progress", "completed", "cancelled",
]);

export const voteStatusEnum = pgEnum("vote_status", [
  "draft", "open", "closed", "cancelled",
]);

/** Club document metadata — actual file lives in object storage */
export const clubDocumentsTable = pgTable("club_documents", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  category: documentCategoryEnum("category").notNull().default("other"),
  access: documentAccessEnum("access").notNull().default("all_members"),
  currentVersionId: integer("current_version_id"),
  tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  uploadedBy: integer("uploaded_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("club_documents_org_idx").on(t.organizationId),
  index("club_documents_category_idx").on(t.category),
]);

/** Version history for each document */
export const documentVersionsTable = pgTable("document_versions", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => clubDocumentsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull().default(1),
  fileUrl: text("file_url").notNull(),
  fileName: text("file_name").notNull(),
  fileSizeBytes: integer("file_size_bytes"),
  mimeType: text("mime_type"),
  changeNotes: text("change_notes"),
  uploadedBy: integer("uploaded_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("document_versions_doc_idx").on(t.documentId),
  uniqueIndex("document_version_unique").on(t.documentId, t.versionNumber),
]);

/** Pinned club notices / announcements with expiry */
export const governanceNoticesTable = pgTable("governance_notices", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  isPinned: boolean("is_pinned").notNull().default(false),
  access: documentAccessEnum("access").notNull().default("all_members"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  isPublished: boolean("is_published").notNull().default(false),
  postedBy: integer("posted_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  attachmentUrl: text("attachment_url"),
  attachmentName: text("attachment_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("governance_notices_org_idx").on(t.organizationId),
  index("governance_notices_pinned_idx").on(t.isPinned),
]);

/** Committee meeting records */
export const committeeMeetingsTable = pgTable("committee_meetings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: meetingStatusEnum("status").notNull().default("scheduled"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  location: text("location"),
  chairpersonId: integer("chairperson_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  minutesPublished: boolean("minutes_published").notNull().default(false),
  minutesPublishedAt: timestamp("minutes_published_at", { withTimezone: true }),
  access: documentAccessEnum("access").notNull().default("committee_only"),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("committee_meetings_org_idx").on(t.organizationId),
  index("committee_meetings_status_idx").on(t.status),
]);

/** Meeting agenda items */
export const meetingAgendaItemsTable = pgTable("meeting_agenda_items", {
  id: serial("id").primaryKey(),
  meetingId: integer("meeting_id").notNull().references(() => committeeMeetingsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  title: text("title").notNull(),
  description: text("description"),
  duration: integer("duration"),
  documentId: integer("document_id").references(() => clubDocumentsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("agenda_items_meeting_idx").on(t.meetingId)]);

/** Meeting minutes recorded post-meeting */
export const meetingMinutesTable = pgTable("meeting_minutes", {
  id: serial("id").primaryKey(),
  meetingId: integer("meeting_id").notNull().references(() => committeeMeetingsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  attendees: jsonb("attendees").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  attachmentUrl: text("attachment_url"),
  attachmentName: text("attachment_name"),
  recordedBy: integer("recorded_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("meeting_minutes_meeting_unique").on(t.meetingId)]);

/** Committee digital votes / polls */
export const committeeVotesTable = pgTable("committee_votes", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  meetingId: integer("meeting_id").references(() => committeeMeetingsTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  description: text("description"),
  options: jsonb("options").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  status: voteStatusEnum("status").notNull().default("draft"),
  access: documentAccessEnum("access").notNull().default("committee_only"),
  deadline: timestamp("deadline", { withTimezone: true }),
  resultsVisible: boolean("results_visible").notNull().default(false),
  allowAbstain: boolean("allow_abstain").notNull().default(true),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("committee_votes_org_idx").on(t.organizationId),
  index("committee_votes_status_idx").on(t.status),
]);

/** Individual ballot submissions for a vote */
export const voteBallotsTable = pgTable("vote_ballots", {
  id: serial("id").primaryKey(),
  voteId: integer("vote_id").notNull().references(() => committeeVotesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  choice: text("choice"),
  abstained: boolean("abstained").notNull().default(false),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("vote_ballot_user_unique").on(t.voteId, t.userId),
  index("vote_ballots_vote_idx").on(t.voteId),
]);

export type ClubDocument = typeof clubDocumentsTable.$inferSelect;
export type DocumentVersion = typeof documentVersionsTable.$inferSelect;
export type GovernanceNotice = typeof governanceNoticesTable.$inferSelect;
export type CommitteeMeeting = typeof committeeMeetingsTable.$inferSelect;
export type MeetingAgendaItem = typeof meetingAgendaItemsTable.$inferSelect;
export type MeetingMinutes = typeof meetingMinutesTable.$inferSelect;
export type CommitteeVote = typeof committeeVotesTable.$inferSelect;
export type VoteBallot = typeof voteBallotsTable.$inferSelect;

// ─── TASK #94: SOCIAL WALL & CLUB FEED ──────────────────────────────────────

export const feedPostTypeEnum = pgEnum("feed_post_type", [
  "member_post",
  "achievement",
  "club_announcement",
]);

export const feedPrivacyEnum = pgEnum("feed_privacy", [
  "all_members",
  "followers_only",
]);

export const feedReportReasonEnum = pgEnum("feed_report_reason", [
  "inappropriate", "spam", "offensive", "other",
]);

/**
 * A post in the club social feed.
 * type: member_post (member-authored), achievement (auto-generated card), club_announcement (admin-pinned).
 */
export const feedPostsTable = pgTable("feed_posts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  authorUserId: integer("author_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  type: feedPostTypeEnum("type").notNull().default("member_post"),
  body: text("body").notNull(),
  privacy: feedPrivacyEnum("privacy").notNull().default("all_members"),
  isPinned: boolean("is_pinned").notNull().default(false),
  isHidden: boolean("is_hidden").notNull().default(false),
  taggedCourseId: integer("tagged_course_id").references(() => coursesTable.id, { onDelete: "set null" }),
  taggedHoleNumber: integer("tagged_hole_number"),
  taggedRoundId: integer("tagged_round_id"),
  achievementType: text("achievement_type"),
  reactionsCount: integer("reactions_count").notNull().default(0),
  commentsCount: integer("comments_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("feed_posts_org_idx").on(t.organizationId),
  index("feed_posts_author_idx").on(t.authorUserId),
  index("feed_posts_created_idx").on(t.createdAt),
]);

export const feedPostMediaTable = pgTable("feed_post_media", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => feedPostsTable.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  mimeType: text("mime_type").notNull().default("image/jpeg"),
  width: integer("width"),
  height: integer("height"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("feed_media_post_idx").on(t.postId)]);

export const feedReactionsTable = pgTable("feed_reactions", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => feedPostsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  emoji: text("emoji").notNull().default("👍"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("feed_reaction_unique").on(t.postId, t.userId),
  index("feed_reactions_post_idx").on(t.postId),
]);

export const feedCommentsTable = pgTable("feed_comments", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => feedPostsTable.id, { onDelete: "cascade" }),
  authorUserId: integer("author_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  isHidden: boolean("is_hidden").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("feed_comments_post_idx").on(t.postId),
  index("feed_comments_author_idx").on(t.authorUserId),
]);

export const feedReportsTable = pgTable("feed_reports", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").references(() => feedPostsTable.id, { onDelete: "cascade" }),
  commentId: integer("comment_id").references(() => feedCommentsTable.id, { onDelete: "cascade" }),
  reporterUserId: integer("reporter_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  reason: feedReportReasonEnum("reason").notNull().default("inappropriate"),
  notes: text("notes"),
  status: text("status").notNull().default("pending"),
  resolvedByUserId: integer("resolved_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("feed_reports_post_idx").on(t.postId),
  index("feed_reports_status_idx").on(t.status),
]);

export type FeedPost = typeof feedPostsTable.$inferSelect;
export type FeedPostMedia = typeof feedPostMediaTable.$inferSelect;
export type FeedReaction = typeof feedReactionsTable.$inferSelect;
export type FeedComment = typeof feedCommentsTable.$inferSelect;
export type FeedReport = typeof feedReportsTable.$inferSelect;

// ─── TASK #95: GOLF TRIP & AWAY DAY PLANNER ───────────────────────────────────

export const tripStatusEnum = pgEnum("trip_status", [
  "draft", "open", "confirmed", "completed", "cancelled",
]);

export const itineraryItemTypeEnum = pgEnum("itinerary_item_type", [
  "travel", "golf_round", "dinner", "accommodation", "activity", "free_time",
]);

export const tripParticipantStatusEnum = pgEnum("trip_participant_status", [
  "invited", "confirmed", "waitlisted", "cancelled",
]);

/** A golf trip or away day event organised by a club. */
export const golfTripsTable = pgTable("golf_trips", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  destination: text("destination").notNull(),
  externalCourseName: text("external_course_name").notNull(),
  description: text("description"),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  status: tripStatusEnum("status").notNull().default("draft"),
  maxParticipants: integer("max_participants"),
  depositAmount: numeric("deposit_amount", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  estimatedTotalCost: numeric("estimated_total_cost", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("golf_trips_org_idx").on(t.organizationId),
  index("golf_trips_status_idx").on(t.status),
]);

/** Day-by-day itinerary items for a golf trip. */
export const tripItineraryItemsTable = pgTable("trip_itinerary_items", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => golfTripsTable.id, { onDelete: "cascade" }),
  dayNumber: integer("day_number").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  type: itineraryItemTypeEnum("type").notNull().default("activity"),
  title: text("title").notNull(),
  location: text("location"),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("trip_itinerary_trip_idx").on(t.tripId)]);

/** Participants signed up for a golf trip. */
export const tripParticipantsTable = pgTable("trip_participants", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => golfTripsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  status: tripParticipantStatusEnum("status").notNull().default("invited"),
  depositStatus: paymentStatusEnum("deposit_status").notNull().default("unpaid"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  notes: text("notes"),
  signedUpAt: timestamp("signed_up_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("trip_participants_trip_idx").on(t.tripId),
  uniqueIndex("trip_participants_trip_user_unique").on(t.tripId, t.userId),
]);

/** Room-sharing groups for a golf trip. */
export const tripRoomsTable = pgTable("trip_rooms", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => golfTripsTable.id, { onDelete: "cascade" }),
  roomName: text("room_name").notNull(),
  roomType: text("room_type"),
  costPerNight: numeric("cost_per_night", { precision: 10, scale: 2 }),
  nights: integer("nights"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("trip_rooms_trip_idx").on(t.tripId)]);

/** Car/transport-sharing groups for a golf trip. */
export const tripCarsTable = pgTable("trip_cars", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => golfTripsTable.id, { onDelete: "cascade" }),
  carLabel: text("car_label").notNull(),
  driverParticipantId: integer("driver_participant_id").references(() => tripParticipantsTable.id, { onDelete: "set null" }),
  totalCost: numeric("total_cost", { precision: 10, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("trip_cars_trip_idx").on(t.tripId)]);

/** Assignment of a participant to a room. */
export const tripRoomAssignmentsTable = pgTable("trip_room_assignments", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id").notNull().references(() => tripRoomsTable.id, { onDelete: "cascade" }),
  participantId: integer("participant_id").notNull().references(() => tripParticipantsTable.id, { onDelete: "cascade" }),
}, (t) => [
  uniqueIndex("trip_room_assignment_unique").on(t.roomId, t.participantId),
  index("trip_room_assign_participant_idx").on(t.participantId),
]);

/** Assignment of a participant to a car. */
export const tripCarAssignmentsTable = pgTable("trip_car_assignments", {
  id: serial("id").primaryKey(),
  carId: integer("car_id").notNull().references(() => tripCarsTable.id, { onDelete: "cascade" }),
  participantId: integer("participant_id").notNull().references(() => tripParticipantsTable.id, { onDelete: "cascade" }),
}, (t) => [
  uniqueIndex("trip_car_assignment_unique").on(t.carId, t.participantId),
  index("trip_car_assign_participant_idx").on(t.participantId),
]);

/** Manually recorded tee time slots at the external course. */
export const tripTeeSlotsTable = pgTable("trip_tee_slots", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => golfTripsTable.id, { onDelete: "cascade" }),
  roundDay: integer("round_day").notNull(),
  teeTime: text("tee_time").notNull(),
  holeStart: integer("hole_start").notNull().default(1),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("trip_tee_slots_trip_idx").on(t.tripId)]);

/** Assignment of a participant to a tee slot. */
export const tripTeeSlotAssignmentsTable = pgTable("trip_tee_slot_assignments", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull().references(() => tripTeeSlotsTable.id, { onDelete: "cascade" }),
  participantId: integer("participant_id").notNull(),
}, (t) => [
  uniqueIndex("trip_tee_slot_assignment_unique").on(t.slotId, t.participantId),
  foreignKey({ name: "trip_tee_slot_assignments_participant_id_fk", columns: [t.participantId], foreignColumns: [tripParticipantsTable.id] }).onDelete("cascade"),
]);

/** Shared expenses for a golf trip (accommodation, meals, transport, etc.). */
export const tripExpensesTable = pgTable("trip_expenses", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => golfTripsTable.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  paidBy: integer("paid_by").references(() => tripParticipantsTable.id, { onDelete: "set null" }),
  splitBetween: jsonb("split_between").$type<number[]>().default([]),
  receiptUrl: text("receipt_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("trip_expenses_trip_idx").on(t.tripId)]);

export type GolfTrip = typeof golfTripsTable.$inferSelect;
export type TripItineraryItem = typeof tripItineraryItemsTable.$inferSelect;
export type TripParticipant = typeof tripParticipantsTable.$inferSelect;
export type TripRoom = typeof tripRoomsTable.$inferSelect;
export type TripCar = typeof tripCarsTable.$inferSelect;
export type TripTeeSlot = typeof tripTeeSlotsTable.$inferSelect;
export type TripExpense = typeof tripExpensesTable.$inferSelect;

// TV DISPLAY BOARD — Admin configures display settings per organization/tournament
export const displayBoardSettingsTable = pgTable("display_board_settings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  activeTournamentIds: jsonb("active_tournament_ids").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
  rotationSequence: jsonb("rotation_sequence").$type<string[]>().notNull().default(sql`'["leaderboard","tracker","sidegames","sponsor"]'::jsonb`),
  rotationIntervalSeconds: integer("rotation_interval_seconds").notNull().default(20),
  sponsorSlideDurationSeconds: integer("sponsor_slide_duration_seconds").notNull().default(10),
  showSponsorSlides: boolean("show_sponsor_slides").notNull().default(true),
  showSideGames: boolean("show_side_games").notNull().default(true),
  showTracker: boolean("show_tracker").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("display_board_settings_org_unique").on(t.organizationId)]);

// DISPLAY CODES — short code pairing a TV screen to a specific event (no login required)
export const displayCodesTable = pgTable("display_codes", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  label: text("label"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("display_codes_code_idx").on(t.code)]);

export type DisplayBoardSettings = typeof displayBoardSettingsTable.$inferSelect;
export type DisplayCode = typeof displayCodesTable.$inferSelect;

// BROADCAST OVERLAY STATES — Task #426. Per-tournament producer cue state for
// OBS/vMix browser-source overlays. Persisted so that an API server restart
// mid-broadcast does not wipe the active overlays, current group/hole/player,
// theme overrides, or lower-third text. The full state is serialised as JSON
// because the producer panel may evolve faster than schema migrations.
export const broadcastOverlayStatesTable = pgTable("broadcast_overlay_states", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }).unique(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type BroadcastOverlayStateRow = typeof broadcastOverlayStatesTable.$inferSelect;

// BROADCAST OVERLAY STATE TEMPLATES — Task #549. Named cue-sheet templates per
// tournament so producers can pre-build shows (e.g. "Sunday final round",
// "Hole 17 amen corner") and load them on demand. Multiple templates per
// tournament; the template name is unique within a tournament.
export const broadcastOverlayStateTemplatesTable = pgTable("broadcast_overlay_state_templates", {
  id: serial("id").primaryKey(),
  // FKs use explicit short names because the auto-generated 4-arg names
  // (`broadcast_overlay_state_templates_<col>_<reftable>_<refcol>_fk`)
  // exceed Postgres's 63-char identifier limit and were silently
  // truncated in the live DB, causing endless drift churn.
  tournamentId: integer("tournament_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  name: text("name").notNull(),
  state: jsonb("state").notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Task #726 — audit who last loaded this template into the live cue
  // state and when, so producers sharing a tournament can coordinate
  // ("did Sam already cue the leaderboard?") and post-event review
  // can reconstruct which template was on-air at any given moment.
  lastLoadedAt: timestamp("last_loaded_at", { withTimezone: true }),
  lastLoadedByUserId: integer("last_loaded_by_user_id"),
}, (t) => ({
  uniq: uniqueIndex("broadcast_overlay_template_tournament_name_unique").on(t.tournamentId, t.name),
  byTournament: index("broadcast_overlay_template_tournament_idx").on(t.tournamentId),
  tournamentFk: foreignKey({
    name: "broadcast_overlay_state_templates_tournament_id_fk",
    columns: [t.tournamentId],
    foreignColumns: [tournamentsTable.id],
  }).onDelete("cascade"),
  organizationFk: foreignKey({
    name: "broadcast_overlay_state_templates_organization_id_fk",
    columns: [t.organizationId],
    foreignColumns: [organizationsTable.id],
  }).onDelete("cascade"),
  createdByUserFk: foreignKey({
    name: "broadcast_overlay_state_templates_created_by_user_id_fk",
    columns: [t.createdByUserId],
    foreignColumns: [appUsersTable.id],
  }).onDelete("set null"),
  lastLoadedByUserFk: foreignKey({
    name: "broadcast_overlay_state_templates_last_loaded_by_user_id_fk",
    columns: [t.lastLoadedByUserId],
    foreignColumns: [appUsersTable.id],
  }).onDelete("set null"),
}));

export type BroadcastOverlayStateTemplateRow = typeof broadcastOverlayStateTemplatesTable.$inferSelect;

// ─── PACE OF PLAY ────────────────────────────────────────────────────────────

// HOLE PAR TIMES — admin-configured target minutes per hole per course
export const holeParTimesTable = pgTable("hole_par_times", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  parMinutes: integer("par_minutes").notNull().default(14),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("hole_par_time_unique").on(t.courseId, t.holeNumber),
  index("hole_par_times_course_idx").on(t.courseId),
]);

// PACE ALERT SETTINGS — per-tournament configurable thresholds
export const paceAlertSettingsTable = pgTable("pace_alert_settings", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }).unique(),
  warningThresholdMinutes: integer("warning_threshold_minutes").notNull().default(10),
  criticalThresholdMinutes: integer("critical_threshold_minutes").notNull().default(20),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// GROUP CHECKPOINTS — manual marshal check-ins or GPS-based position updates
// Enables marshals to explicitly log a group's position at a given hole
export const groupCheckpointsTable = pgTable("group_checkpoints", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  teeTimeId: integer("tee_time_id").notNull().references(() => teeTimesTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  holeNumber: integer("hole_number").notNull(),
  source: text("source").notNull().default("marshal"),
  recordedByUserId: integer("recorded_by_user_id").references(() => appUsersTable.id),
  latitude: text("latitude"),
  longitude: text("longitude"),
  notes: text("notes"),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("group_checkpoints_tournament_idx").on(t.tournamentId),
  index("group_checkpoints_tee_time_idx").on(t.teeTimeId),
  index("group_checkpoints_round_hole_idx").on(t.round, t.holeNumber),
]);

// GROUP PACE RECORDS — computed pace snapshot per tee-time group per round
export const groupPaceRecordsTable = pgTable("group_pace_records", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  teeTimeId: integer("tee_time_id").notNull().references(() => teeTimesTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  currentHole: integer("current_hole").notNull().default(0),
  actualElapsedMinutes: integer("actual_elapsed_minutes").notNull().default(0),
  targetElapsedMinutes: integer("target_elapsed_minutes").notNull().default(0),
  deviationMinutes: integer("deviation_minutes").notNull().default(0),
  paceStatus: text("pace_status").notNull().default("on_pace"),
  lastHoleCompletedAt: timestamp("last_hole_completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("group_pace_record_unique").on(t.teeTimeId, t.round),
  index("group_pace_records_tournament_idx").on(t.tournamentId),
]);

// PACE ALERTS — generated when a group exceeds the alert threshold
export const paceAlertsTable = pgTable("pace_alerts", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  teeTimeId: integer("tee_time_id").notNull().references(() => teeTimesTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  alertType: text("alert_type").notNull().default("warning"),
  deviationMinutes: integer("deviation_minutes").notNull(),
  currentHole: integer("current_hole").notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedByUserId: integer("acknowledged_by_user_id").references(() => appUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("pace_alerts_tournament_idx").on(t.tournamentId),
  index("pace_alerts_tee_time_idx").on(t.teeTimeId),
]);

export type HoleParTime = typeof holeParTimesTable.$inferSelect;
export type PaceAlertSettings = typeof paceAlertSettingsTable.$inferSelect;
export type GroupCheckpoint = typeof groupCheckpointsTable.$inferSelect;
export type GroupPaceRecord = typeof groupPaceRecordsTable.$inferSelect;
export type PaceAlert = typeof paceAlertsTable.$inferSelect;

// ─── TASK #98: NATIONAL & REGIONAL RANKINGS ──────────────────────────────────

export const rankingSeriesLevelEnum = pgEnum("ranking_series_level", [
  "club", "regional", "national",
]);

export const rankingSeriesStatusEnum = pgEnum("ranking_series_status", [
  "draft", "active", "archived",
]);

export const rankingCategoryEnum = pgEnum("ranking_category", [
  "open", "men", "ladies", "seniors", "juniors",
]);

export const rankingTiebreakerEnum = pgEnum("ranking_tiebreaker", [
  "most_wins", "most_runner_up", "most_top3", "head_to_head", "none",
]);

/** A ranking series (e.g. "2025 National Order of Merit") */
export const rankingSeriesTable = pgTable("ranking_series", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  level: rankingSeriesLevelEnum("level").notNull().default("club"),
  status: rankingSeriesStatusEnum("status").notNull().default("draft"),
  seasonStart: timestamp("season_start", { withTimezone: true }).notNull(),
  seasonEnd: timestamp("season_end", { withTimezone: true }).notNull(),
  tiebreaker: rankingTiebreakerEnum("tiebreaker").notNull().default("most_wins"),
  isPublic: boolean("is_public").notNull().default(true),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ranking_series_org_idx").on(t.organizationId),
  index("ranking_series_status_idx").on(t.status),
]);

/** Points awarded per finishing position for a series */
export const pointsTableTable = pgTable("points_table", {
  id: serial("id").primaryKey(),
  seriesId: integer("series_id").notNull().references(() => rankingSeriesTable.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  points: integer("points").notNull(),
}, (t) => [
  uniqueIndex("points_table_series_position_unique").on(t.seriesId, t.position),
  index("points_table_series_idx").on(t.seriesId),
]);

/** Tournaments enrolled in a ranking series */
export const seriesEventEnrollmentTable = pgTable("series_event_enrollment", {
  id: serial("id").primaryKey(),
  seriesId: integer("series_id").notNull().references(() => rankingSeriesTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  category: rankingCategoryEnum("category").notNull().default("open"),
  pointsMultiplier: numeric("points_multiplier", { precision: 4, scale: 2 }).notNull().default("1.00"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("series_event_unique").on(t.seriesId, t.tournamentId),
  index("series_enrollment_series_idx").on(t.seriesId),
  index("series_enrollment_tournament_idx").on(t.tournamentId),
]);

/** Accumulated points per player in a series */
export const rankingEntryTable = pgTable("ranking_entry", {
  id: serial("id").primaryKey(),
  seriesId: integer("series_id").notNull().references(() => rankingSeriesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  playerName: text("player_name").notNull(),
  playerEmail: text("player_email"),
  category: rankingCategoryEnum("category").notNull().default("open"),
  totalPoints: integer("total_points").notNull().default(0),
  eventsPlayed: integer("events_played").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  runnerUps: integer("runner_ups").notNull().default(0),
  top3: integer("top3").notNull().default(0),
  position: integer("position"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ranking_entry_series_user_cat_unique").on(t.seriesId, t.userId, t.category),
  index("ranking_entry_series_idx").on(t.seriesId),
  index("ranking_entry_user_idx").on(t.userId),
]);

/** Individual event points awarded to a player */
export const rankingPointsHistoryTable = pgTable("ranking_points_history", {
  id: serial("id").primaryKey(),
  seriesId: integer("series_id").notNull().references(() => rankingSeriesTable.id, { onDelete: "cascade" }),
  rankingEntryId: integer("ranking_entry_id").notNull().references(() => rankingEntryTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  basePoints: integer("base_points").notNull(),
  multiplier: numeric("multiplier", { precision: 4, scale: 2 }).notNull().default("1.00"),
  pointsAwarded: integer("points_awarded").notNull(),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ranking_history_entry_tournament_unique").on(t.rankingEntryId, t.tournamentId),
  index("ranking_history_series_idx").on(t.seriesId),
  index("ranking_history_entry_idx").on(t.rankingEntryId),
]);

/** Season-end snapshot for historical archive */
export const rankingSnapshotTable = pgTable("ranking_snapshot", {
  id: serial("id").primaryKey(),
  seriesId: integer("series_id").notNull().references(() => rankingSeriesTable.id, { onDelete: "cascade" }),
  snapshotData: jsonb("snapshot_data").$type<{
    position: number;
    playerName: string;
    userId: number | null;
    category: string;
    totalPoints: number;
    eventsPlayed: number;
    wins: number;
    runnerUps: number;
    top3: number;
  }[]>().notNull().default(sql`'[]'::jsonb`),
  archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
  archivedBy: integer("archived_by").references(() => appUsersTable.id, { onDelete: "set null" }),
}, (t) => [index("ranking_snapshot_series_idx").on(t.seriesId)]);

export type RankingSeries = typeof rankingSeriesTable.$inferSelect;
export type PointsTableEntry = typeof pointsTableTable.$inferSelect;
export type SeriesEventEnrollment = typeof seriesEventEnrollmentTable.$inferSelect;
export type RankingEntry = typeof rankingEntryTable.$inferSelect;
export type RankingPointsHistory = typeof rankingPointsHistoryTable.$inferSelect;
export type RankingSnapshot = typeof rankingSnapshotTable.$inferSelect;

// ─── TASK #99: CLUB REPAIR & FITTING TRACKER ──────────────────────────────────

export const repairJobStatusEnum = pgEnum("repair_job_status", [
  "received", "in_progress", "ready_for_pickup", "collected",
]);

export const repairJobTypeEnum = pgEnum("repair_job_type", [
  "regrip", "reshaft", "loft_lie_adjustment", "cleaning", "other",
]);

export const fittingSessionStatusEnum = pgEnum("fitting_session_status", [
  "booked", "completed", "cancelled",
]);

/** A club repair job lodged at the pro shop. */
export const repairJobsTable = pgTable("repair_jobs", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  memberName: text("member_name").notNull(),
  memberEmail: text("member_email"),
  jobType: repairJobTypeEnum("job_type").notNull().default("other"),
  description: text("description").notNull(),
  status: repairJobStatusEnum("status").notNull().default("received"),
  technicianId: integer("technician_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  technicianName: text("technician_name"),
  expectedCompletionDate: timestamp("expected_completion_date", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notificationSentAt: timestamp("notification_sent_at", { withTimezone: true }),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("repair_jobs_org_idx").on(t.organizationId),
  index("repair_jobs_member_idx").on(t.memberId),
  index("repair_jobs_technician_idx").on(t.technicianId),
  index("repair_jobs_status_idx").on(t.status),
]);

/** A custom club fitting session booked at the pro shop. */
export const fittingSessionsTable = pgTable("fitting_sessions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  memberName: text("member_name").notNull(),
  memberEmail: text("member_email"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  status: fittingSessionStatusEnum("status").notNull().default("booked"),
  technicianId: integer("technician_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  technicianName: text("technician_name"),
  recommendedSpecs: jsonb("recommended_specs").$type<{
    shaftFlex?: string;
    shaftMaterial?: string;
    headType?: string;
    loft?: string;
    lie?: string;
    gripSize?: string;
    notes?: string;
  }>().default({}),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fitting_sessions_org_idx").on(t.organizationId),
  index("fitting_sessions_member_idx").on(t.memberId),
  index("fitting_sessions_status_idx").on(t.status),
]);

export type RepairJob = typeof repairJobsTable.$inferSelect;
export type FittingSession = typeof fittingSessionsTable.$inferSelect;

// ─── TASK #101: SUPPLIER & PURCHASE ORDER MANAGEMENT ─────────────────────────

export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  paymentTerms: text("payment_terms"),
  leadTimeDays: integer("lead_time_days"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("suppliers_org_idx").on(t.organizationId)]);

export const poStatusEnum = pgEnum("po_status", [
  "draft", "sent", "partially_received", "fully_received", "cancelled",
]);

export const purchaseOrdersTable = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  supplierId: integer("supplier_id").notNull().references(() => suppliersTable.id, { onDelete: "restrict" }),
  poNumber: text("po_number").notNull(),
  status: poStatusEnum("status").notNull().default("draft"),
  expectedDeliveryDate: timestamp("expected_delivery_date", { withTimezone: true }),
  notes: text("notes"),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("purchase_orders_org_idx").on(t.organizationId),
  index("purchase_orders_supplier_idx").on(t.supplierId),
  uniqueIndex("purchase_orders_po_number_org_unique").on(t.organizationId, t.poNumber),
]);

export const purchaseOrderLinesTable = pgTable("purchase_order_lines", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => shopProductsTable.id, { onDelete: "set null" }),
  variantId: integer("variant_id").references(() => shopProductVariantsTable.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  sku: text("sku"),
  quantity: integer("quantity").notNull(),
  unitCost: numeric("unit_cost", { precision: 10, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 10, scale: 2 }).notNull(),
  receivedQty: integer("received_qty").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("po_lines_po_idx").on(t.purchaseOrderId)]);

export const deliveryReceiptsTable = pgTable("delivery_receipts", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrdersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  receivedByUserId: integer("received_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("delivery_receipts_po_idx").on(t.purchaseOrderId)]);

export const deliveryReceiptLinesTable = pgTable("delivery_receipt_lines", {
  id: serial("id").primaryKey(),
  deliveryReceiptId: integer("delivery_receipt_id").notNull(),
  purchaseOrderLineId: integer("purchase_order_line_id").notNull(),
  receivedQty: integer("received_qty").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("delivery_receipt_lines_receipt_idx").on(t.deliveryReceiptId),
  foreignKey({ name: "delivery_receipt_lines_delivery_receipt_id_fk", columns: [t.deliveryReceiptId], foreignColumns: [deliveryReceiptsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "delivery_receipt_lines_purchase_order_line_id_fk", columns: [t.purchaseOrderLineId], foreignColumns: [purchaseOrderLinesTable.id] }).onDelete("cascade"),
]);

export type Supplier = typeof suppliersTable.$inferSelect;
export type PurchaseOrder = typeof purchaseOrdersTable.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLinesTable.$inferSelect;
export type DeliveryReceipt = typeof deliveryReceiptsTable.$inferSelect;
export type DeliveryReceiptLine = typeof deliveryReceiptLinesTable.$inferSelect;

// ─── TASK #100: RENTAL EQUIPMENT MANAGEMENT ───────────────────────────────────

export const rentalAssetConditionEnum = pgEnum("rental_asset_condition", [
  "excellent", "good", "fair", "poor", "damaged", "retired",
]);

export const rentalBookingStatusEnum = pgEnum("rental_booking_status", [
  "reserved", "checked_out", "returned", "cancelled",
]);

/** Categories of rental items (e.g. clubs, trolleys, GPS devices, umbrellas) */
export const rentalCategoriesTable = pgTable("rental_categories", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  dailyRate: numeric("daily_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("USD"),
  icon: text("icon").notNull().default("package"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("rental_categories_org_idx").on(t.organizationId),
]);

/** Individual rental asset records */
export const rentalAssetsTable = pgTable("rental_assets", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  categoryId: integer("category_id").notNull().references(() => rentalCategoriesTable.id, { onDelete: "cascade" }),
  assetCode: text("asset_code").notNull(),
  description: text("description"),
  condition: rentalAssetConditionEnum("condition").notNull().default("good"),
  dailyRateOverride: numeric("daily_rate_override", { precision: 10, scale: 2 }),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("rental_assets_org_code_unique").on(t.organizationId, t.assetCode),
  index("rental_assets_org_idx").on(t.organizationId),
  index("rental_assets_category_idx").on(t.categoryId),
]);

/** Rental bookings linking an asset to a member (optionally to a tee booking) */
export const rentalBookingsTable = pgTable("rental_bookings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  assetId: integer("asset_id").notNull().references(() => rentalAssetsTable.id, { onDelete: "restrict" }),
  teeBookingId: integer("tee_booking_id").references(() => teeBookingsTable.id, { onDelete: "set null" }),
  memberId: integer("member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),
  bookedByUserId: integer("booked_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  memberName: text("member_name"),
  status: rentalBookingStatusEnum("status").notNull().default("reserved"),
  rentalDate: timestamp("rental_date", { withTimezone: true }).notNull(),
  expectedReturnAt: timestamp("expected_return_at", { withTimezone: true }),
  checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
  checkedOutByUserId: integer("checked_out_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  returnedByUserId: integer("returned_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  rateCharged: numeric("rate_charged", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("USD"),
  damageReported: boolean("damage_reported").notNull().default(false),
  damageNotes: text("damage_notes"),
  damagePhotoUrls: jsonb("damage_photo_urls").$type<string[]>().notNull().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("rental_bookings_org_idx").on(t.organizationId),
  index("rental_bookings_asset_idx").on(t.assetId),
  index("rental_bookings_tee_booking_idx").on(t.teeBookingId),
  index("rental_bookings_member_idx").on(t.memberId),
  // Prevent double-allocation: one active booking per asset at a time
  uniqueIndex("rental_bookings_asset_active_unique")
    .on(t.assetId)
    .where(sql`${t.status} IN ('reserved', 'checked_out')`),
]);

// ─── TASK #80: CLUB CHAMPIONSHIP & INTERCLUB COMPETITIONS ─────────────────

// CLUB CHAMPIONSHIP — designates a tournament as the annual club championship
export const clubChampionshipTable = pgTable("club_championship", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  year: integer("year").notNull(),
  title: text("title").notNull().default("Club Championship"),
  notes: text("notes"),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("club_championship_org_year_unique").on(t.organizationId, t.year),
  index("club_championship_org_idx").on(t.organizationId),
  uniqueIndex("club_championship_tournament_unique").on(t.tournamentId),
]);

// CHAMPIONSHIP FLIGHT — named flight category within a club championship
export const championshipFlightTable = pgTable("championship_flight", {
  id: serial("id").primaryKey(),
  championshipId: integer("championship_id").notNull().references(() => clubChampionshipTable.id, { onDelete: "cascade" }),
  flightId: integer("flight_id").references(() => flightsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  scoreType: text("score_type").notNull().default("net"),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("champ_flight_championship_idx").on(t.championshipId),
]);

// CHAMPIONSHIP WINNER — historical record of winners per year and flight
export const championshipWinnerTable = pgTable("championship_winner", {
  id: serial("id").primaryKey(),
  championshipId: integer("championship_id").notNull().references(() => clubChampionshipTable.id, { onDelete: "cascade" }),
  flightId: integer("flight_id").references(() => championshipFlightTable.id, { onDelete: "set null" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  playerName: text("player_name").notNull(),
  score: text("score"),
  notes: text("notes"),
  position: integer("position").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("champ_winner_championship_idx").on(t.championshipId),
  index("champ_winner_flight_idx").on(t.flightId),
]);

// INTERCLUB SEASON — groups interclub fixtures into a competitive season
export const interclubSeasonTable = pgTable("interclub_season", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  year: integer("year").notNull(),
  description: text("description"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("interclub_season_org_idx").on(t.organizationId),
]);

// INTERCLUB FIXTURE — a match against an external club/society (enhanced from existing simple table)
export const interclubFixtureFullTable = pgTable("interclub_fixture_full", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  seasonId: integer("season_id").references(() => interclubSeasonTable.id, { onDelete: "set null" }),
  opponentName: text("opponent_name").notNull(),
  opponentClub: text("opponent_club"),
  fixtureDate: timestamp("fixture_date", { withTimezone: true }),
  venue: text("venue"),
  isHome: boolean("is_home").notNull().default(true),
  format: text("format").notNull().default("matchplay"),
  status: text("status").notNull().default("scheduled"),
  homePoints: numeric("home_points", { precision: 6, scale: 1 }),
  awayPoints: numeric("away_points", { precision: 6, scale: 1 }),
  result: text("result"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("interclub_fixture_full_org_idx").on(t.organizationId),
  index("interclub_fixture_full_season_idx").on(t.seasonId),
]);


export type RentalCategory = typeof rentalCategoriesTable.$inferSelect;
export type RentalAsset = typeof rentalAssetsTable.$inferSelect;
export type RentalBooking = typeof rentalBookingsTable.$inferSelect;

// ─── CONSIGNMENT TRACKING (Task #104) ────────────────────────────────────────

export const consignmentStatusEnum = pgEnum("consignment_status", [
  "unsold", "sold", "payout_pending", "paid", "returned",
]);

export const consignmentPayoutMethodEnum = pgEnum("consignment_payout_method", [
  "cash", "bank_transfer", "cheque", "account_credit", "other",
]);

export const consignmentItemsTable = pgTable("consignment_items", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Consignor details (may be a member or an external person)
  consignorUserId: integer("consignor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  consignorName: text("consignor_name").notNull(),
  consignorEmail: text("consignor_email"),
  consignorPhone: text("consignor_phone"),
  // Item details
  title: text("title").notNull(),
  description: text("description"),
  category: text("category").notNull().default("equipment"),
  brand: text("brand"),
  condition: text("condition").notNull().default("good"),
  askingPrice: numeric("asking_price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  commissionRate: numeric("commission_rate", { precision: 5, scale: 2 }).notNull().default("20"),
  imageUrls: jsonb("image_urls").$type<string[]>().notNull().default([]),
  // Sale details (populated when sold)
  status: consignmentStatusEnum("status").notNull().default("unsold"),
  salePrice: numeric("sale_price", { precision: 10, scale: 2 }),
  soldAt: timestamp("sold_at", { withTimezone: true }),
  shopProductId: integer("shop_product_id").references(() => shopProductsTable.id, { onDelete: "set null" }),
  listedInShop: boolean("listed_in_shop").notNull().default(false),
  // Payout details
  commissionAmount: numeric("commission_amount", { precision: 10, scale: 2 }),
  payoutAmount: numeric("payout_amount", { precision: 10, scale: 2 }),
  payoutMethod: consignmentPayoutMethodEnum("payout_method"),
  payoutReference: text("payout_reference"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidByUserId: integer("paid_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  // Return details
  returnedAt: timestamp("returned_at", { withTimezone: true }),
  notes: text("notes"),
  lookupToken: text("lookup_token").notNull().unique(),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("consignment_items_org_idx").on(t.organizationId),
  index("consignment_items_status_idx").on(t.status),
  index("consignment_items_consignor_user_idx").on(t.consignorUserId),
]);

export type ConsignmentItem = typeof consignmentItemsTable.$inferSelect;

// ─── TASK #102: GIFT CARDS & STORE CREDIT ────────────────────────────────────

export const giftCardStatusEnum = pgEnum("gift_card_status", [
  "active", "redeemed", "expired", "cancelled",
]);

export const giftCardTypeEnum = pgEnum("gift_card_type", [
  "physical", "digital",
]);

export const storeCreditTransactionTypeEnum = pgEnum("store_credit_transaction_type", [
  "issue", "redeem", "expire", "adjustment",
]);

/**
 * Gift cards — physical or digital vouchers with a fixed value and unique code.
 * Purchasable by anyone (member or non-member) and redeemable at POS, shop, or bookings.
 */
export const giftCardsTable = pgTable("gift_cards", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  type: giftCardTypeEnum("type").notNull().default("digital"),
  status: giftCardStatusEnum("status").notNull().default("active"),
  initialBalancePaise: integer("initial_balance_paise").notNull(),
  currentBalancePaise: integer("current_balance_paise").notNull(),
  currency: text("currency").notNull().default("INR"),
  purchaserName: text("purchaser_name"),
  purchaserEmail: text("purchaser_email"),
  recipientName: text("recipient_name"),
  recipientEmail: text("recipient_email"),
  recipientPhone: text("recipient_phone"),
  message: text("message"),
  issuedByUserId: integer("issued_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  linkedMemberId: integer("linked_member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  isPurchasedOnline: boolean("is_purchased_online").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("gift_cards_org_code_unique").on(t.organizationId, t.code),
  index("gift_cards_org_idx").on(t.organizationId),
  index("gift_cards_code_idx").on(t.code),
  index("gift_cards_status_idx").on(t.status),
  index("gift_cards_recipient_email_idx").on(t.recipientEmail),
]);

/**
 * Ledger of every gift card redemption (partial or full).
 */
export const giftCardRedemptionsTable = pgTable("gift_card_redemptions", {
  id: serial("id").primaryKey(),
  giftCardId: integer("gift_card_id").notNull().references(() => giftCardsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  amountPaise: integer("amount_paise").notNull(),
  balanceBeforePaise: integer("balance_before_paise").notNull(),
  balanceAfterPaise: integer("balance_after_paise").notNull(),
  redeemedByUserId: integer("redeemed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  posTransactionId: integer("pos_transaction_id"),
  shopOrderId: integer("shop_order_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("gift_card_redemptions_card_idx").on(t.giftCardId),
  index("gift_card_redemptions_org_idx").on(t.organizationId),
]);

/**
 * Store credit accounts — one per member per org.
 * Credit can be issued by admins (refunds, promotions) or earned through purchases.
 */
export const storeCreditAccountsTable = pgTable("store_credit_accounts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  memberId: integer("member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  balancePaise: integer("balance_paise").notNull().default(0),
  currency: text("currency").notNull().default("INR"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("store_credit_org_member_unique").on(t.organizationId, t.memberId),
  index("store_credit_org_idx").on(t.organizationId),
  index("store_credit_member_idx").on(t.memberId),
]);

/**
 * Ledger entry for every store credit issue, redemption, or adjustment.
 */
export const storeCreditTransactionsTable = pgTable("store_credit_transactions", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  type: storeCreditTransactionTypeEnum("type").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  balanceBeforePaise: integer("balance_before_paise").notNull(),
  balanceAfterPaise: integer("balance_after_paise").notNull(),
  performedByUserId: integer("performed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  posTransactionId: integer("pos_transaction_id"),
  shopOrderId: integer("shop_order_id"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("store_credit_tx_account_idx").on(t.accountId),
  index("store_credit_tx_org_idx").on(t.organizationId),
  foreignKey({ name: "store_credit_transactions_account_id_fk", columns: [t.accountId], foreignColumns: [storeCreditAccountsTable.id] }).onDelete("cascade"),
]);

export type GiftCard = typeof giftCardsTable.$inferSelect;
export type GiftCardRedemption = typeof giftCardRedemptionsTable.$inferSelect;
export type StoreCreditAccount = typeof storeCreditAccountsTable.$inferSelect;
export type StoreCreditTransaction = typeof storeCreditTransactionsTable.$inferSelect;

// ─── TASK #103: LOYALTY & REWARDS PROGRAM ─────────────────────────────────────

export const loyaltyTierEnum = pgEnum("loyalty_tier", [
  "none", "silver", "gold", "platinum",
]);

export const loyaltyTransactionTypeEnum = pgEnum("loyalty_transaction_type", [
  "earn", "redeem", "expire", "adjust",
]);

export const loyaltyServiceCategoryEnum = pgEnum("loyalty_service_category", [
  "pos", "fb", "lesson", "tee_booking", "tee_time", "general",
]);

/** Per-org loyalty programme configuration (one row per org) */
export const loyaltyProgramTable = pgTable("loyalty_program", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }).unique(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  pointsName: text("points_name").notNull().default("Points"),
  /** Base earn rate in points per currency unit (e.g. 1 point per 100 INR) */
  baseEarnRate: numeric("base_earn_rate", { precision: 8, scale: 4 }).notNull().default("1"),
  /** Earn rates per service category (JSON: { pos: 1, fb: 2, lesson: 3, ... }) */
  categoryRates: jsonb("category_rates").$type<Record<string, number>>().notNull().default({}),
  /** Minimum spend amount to earn points (in currency units) */
  minSpendToEarn: numeric("min_spend_to_earn", { precision: 10, scale: 2 }).notNull().default("0"),
  pointsExpireDays: integer("points_expire_days"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("loyalty_program_org_idx").on(t.organizationId),
]);

/** Tier definitions (silver/gold/platinum) per org */
export const loyaltyTiersTable = pgTable("loyalty_tiers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tier: loyaltyTierEnum("tier").notNull(),
  label: text("label").notNull(),
  /** Rolling 12-month points threshold to qualify */
  minPoints: integer("min_points").notNull(),
  /** Multiplier applied to future points earning (e.g. 1.5 = 50% bonus) */
  multiplier: numeric("multiplier", { precision: 4, scale: 2 }).notNull().default("1"),
  /** JSON array of perk descriptions */
  perks: jsonb("perks").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  badgeIcon: text("badge_icon"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("loyalty_tiers_org_tier_unique").on(t.organizationId, t.tier),
  index("loyalty_tiers_org_idx").on(t.organizationId),
]);

/** Member loyalty account (one per member per org) */
export const loyaltyAccountsTable = pgTable("loyalty_accounts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  currentTier: loyaltyTierEnum("current_tier").notNull().default("none"),
  pointsBalance: integer("points_balance").notNull().default(0),
  /** Total lifetime points earned */
  lifetimePoints: integer("lifetime_points").notNull().default(0),
  /** Points earned in rolling 12 months (used for tier calculation) */
  rollingYearPoints: integer("rolling_year_points").notNull().default(0),
  lastTierCalculatedAt: timestamp("last_tier_calculated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("loyalty_accounts_org_user_unique").on(t.organizationId, t.userId),
  index("loyalty_accounts_org_idx").on(t.organizationId),
  index("loyalty_accounts_user_idx").on(t.userId),
]);

/** Every point earn/redeem/expire event */
export const loyaltyTransactionsTable = pgTable("loyalty_transactions", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").notNull().references(() => loyaltyAccountsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  type: loyaltyTransactionTypeEnum("type").notNull(),
  points: integer("points").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  serviceCategory: loyaltyServiceCategoryEnum("service_category"),
  /** Reference ID of the source transaction (POS, order, booking, etc.) */
  referenceId: text("reference_id"),
  description: text("description"),
  /** Reward redeemed (if type=redeem) */
  rewardId: integer("reward_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("loyalty_txn_account_idx").on(t.accountId),
  index("loyalty_txn_org_idx").on(t.organizationId),
  index("loyalty_txn_user_idx").on(t.userId),
  index("loyalty_txn_created_idx").on(t.createdAt),
]);

export const rewardTypeEnum = pgEnum("loyalty_reward_type", [
  "discount_percent", "discount_fixed", "free_round", "voucher", "product", "other",
]);

/** Admin-defined rewards that members can redeem */
export const loyaltyRewardsTable = pgTable("loyalty_rewards", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  rewardType: rewardTypeEnum("reward_type").notNull().default("other"),
  pointsCost: integer("points_cost").notNull(),
  /** For discount rewards: percentage or fixed amount */
  discountValue: numeric("discount_value", { precision: 10, scale: 2 }),
  /** Minimum tier required to redeem */
  minTier: loyaltyTierEnum("min_tier").notNull().default("none"),
  isActive: boolean("is_active").notNull().default(true),
  /** Total stock (null = unlimited) */
  stock: integer("stock"),
  /** How many times this reward has been redeemed */
  redeemedCount: integer("redeemed_count").notNull().default(0),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("loyalty_rewards_org_idx").on(t.organizationId),
  index("loyalty_rewards_active_idx").on(t.organizationId, t.isActive),
]);

export type LoyaltyProgram = typeof loyaltyProgramTable.$inferSelect;
export type LoyaltyTier = typeof loyaltyTiersTable.$inferSelect;
export type LoyaltyAccount = typeof loyaltyAccountsTable.$inferSelect;
export type LoyaltyTransaction = typeof loyaltyTransactionsTable.$inferSelect;
export type LoyaltyReward = typeof loyaltyRewardsTable.$inferSelect;

// ─── TASK #105: STAFF COMMISSION TRACKING ─────────────────────────────────────

export const commissionTypeEnum = pgEnum("commission_type", [
  "percentage",   // % of line total
  "flat_per_sale", // fixed amount per completed sale / lesson
]);

export const commissionSourceEnum = pgEnum("commission_source", [
  "pos",      // Pro-shop POS transaction
  "lesson",   // Lesson booking
]);

export const commissionPayoutStatusEnum = pgEnum("commission_payout_status", [
  "pending", "approved", "paid", "cancelled",
]);

/**
 * Commission rules per staff member, optionally scoped to a product category.
 * Supports tiered rules: a rule with `tierThresholdAmount` only kicks in once the
 * staff member's sales (within the pay period) exceed that threshold.
 */
export const commissionRulesTable = pgTable("commission_rules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  staffUserId: integer("staff_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  /** Null = applies to all categories */
  category: text("category"),
  commissionType: commissionTypeEnum("commission_type").notNull().default("percentage"),
  /** For percentage: 0-100. For flat_per_sale: fixed amount in org currency. */
  rate: numeric("rate", { precision: 10, scale: 4 }).notNull(),
  source: commissionSourceEnum("source").notNull(),
  /** Monthly/period sales threshold above which THIS rate kicks in (tiering) */
  tierThresholdAmount: numeric("tier_threshold_amount", { precision: 10, scale: 2 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("commission_rules_org_idx").on(t.organizationId),
  index("commission_rules_staff_idx").on(t.staffUserId),
]);

/**
 * Pay-period commission payout records.
 * Once approved/paid, the linked attributions are locked.
 *
 * Defined before `salesAttributionsTable` / `commissionAdjustmentsTable`
 * so those tables can reference `commissionPayoutsTable.id` directly in
 * their `foreignKey({ ... })` extras (which evaluate eagerly).
 */
export const commissionPayoutsTable = pgTable("commission_payouts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  staffUserId: integer("staff_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  totalSales: numeric("total_sales", { precision: 10, scale: 2 }).notNull().default("0"),
  totalCommission: numeric("total_commission", { precision: 10, scale: 2 }).notNull().default("0"),
  totalAdjustments: numeric("total_adjustments", { precision: 10, scale: 2 }).notNull().default("0"),
  netPayout: numeric("net_payout", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  status: commissionPayoutStatusEnum("status").notNull().default("pending"),
  notes: text("notes"),
  approvedByUserId: integer("approved_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("commission_payouts_org_idx").on(t.organizationId),
  index("commission_payouts_staff_idx").on(t.staffUserId),
  index("commission_payouts_period_idx").on(t.periodStart, t.periodEnd),
]);

/**
 * Individual sale/lesson events attributed to a staff member, with the
 * commission amount computed at the time of attribution.
 */
export const salesAttributionsTable = pgTable("sales_attributions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  staffUserId: integer("staff_user_id").notNull().references(() => appUsersTable.id, { onDelete: "set null" }),
  source: commissionSourceEnum("source").notNull(),
  /** FK to pos_transactions.id (null for lessons) */
  posTransactionId: integer("pos_transaction_id").references(() => posTransactionsTable.id, { onDelete: "set null" }),
  /** FK to lesson_bookings.id (null for POS) */
  lessonBookingId: integer("lesson_booking_id").references(() => lessonBookingsTable.id, { onDelete: "set null" }),
  /** Sale total used as the commission base */
  saleAmount: numeric("sale_amount", { precision: 10, scale: 2 }).notNull(),
  category: text("category"),
  commissionRuleId: integer("commission_rule_id").references(() => commissionRulesTable.id, { onDelete: "set null" }),
  commissionAmount: numeric("commission_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  /** Linked to a payout once processed */
  payoutId: integer("payout_id"),
  attributedAt: timestamp("attributed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("sales_attributions_org_idx").on(t.organizationId),
  index("sales_attributions_staff_idx").on(t.staffUserId),
  index("sales_attributions_date_idx").on(t.attributedAt),
  index("sales_attributions_payout_idx").on(t.payoutId),
  foreignKey({
    name: "sales_attributions_payout_fk",
    columns: [t.payoutId],
    foreignColumns: [commissionPayoutsTable.id],
  }).onDelete("set null"),
]);

/** Manual positive or negative adjustments to a staff member's commission */
export const commissionAdjustmentsTable = pgTable("commission_adjustments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  staffUserId: integer("staff_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  reason: text("reason").notNull(),
  payoutId: integer("payout_id"),
  adjustedByUserId: integer("adjusted_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("commission_adjustments_org_idx").on(t.organizationId),
  index("commission_adjustments_staff_idx").on(t.staffUserId),
  foreignKey({
    name: "commission_adjustments_payout_fk",
    columns: [t.payoutId],
    foreignColumns: [commissionPayoutsTable.id],
  }).onDelete("set null"),
]);

export type CommissionRule = typeof commissionRulesTable.$inferSelect;
export type SalesAttribution = typeof salesAttributionsTable.$inferSelect;
export type CommissionAdjustment = typeof commissionAdjustmentsTable.$inferSelect;
export type CommissionPayout = typeof commissionPayoutsTable.$inferSelect;

// ─── CADDIE MANAGEMENT & BOOKING (Task #106) ─────────────────────────────────

export const caddieExperienceLevelEnum = pgEnum("caddie_experience_level", [
  "trainee", "junior", "standard", "senior", "master",
]);

export const caddieAssignmentStatusEnum = pgEnum("caddie_assignment_status", [
  "requested", "assigned", "confirmed", "in_progress", "completed", "cancelled", "no_show",
]);

/** Caddie roster for an organisation */
export const caddieProfilesTable = pgTable("caddie_profiles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  /** Optional link to an app_user account (for caddie portal login) */
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  photoUrl: text("photo_url"),
  experienceLevel: caddieExperienceLevelEnum("experience_level").notNull().default("standard"),
  yearsExperience: integer("years_experience").notNull().default(0),
  /** Languages the caddie speaks, e.g. ["en","hi","ta"] */
  languages: jsonb("languages").$type<string[]>().notNull().default([]),
  bio: text("bio"),
  phone: text("phone"),
  email: text("email"),
  /** Base fee per round charged to the member */
  feePerRound: numeric("fee_per_round", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  isActive: boolean("is_active").notNull().default(true),
  /** Average rating out of 5 (recomputed on each new rating) */
  averageRating: numeric("average_rating", { precision: 3, scale: 2 }),
  totalRatings: integer("total_ratings").notNull().default(0),
  totalRounds: integer("total_rounds").notNull().default(0),
  totalEarnings: numeric("total_earnings", { precision: 12, scale: 2 }).notNull().default("0"),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("caddie_profiles_org_idx").on(t.organizationId),
  index("caddie_profiles_user_idx").on(t.userId),
]);

/** Per-day availability for a caddie (admin can block out days or mark available) */
export const caddieAvailabilityTable = pgTable("caddie_availability", {
  id: serial("id").primaryKey(),
  caddieId: integer("caddie_id").notNull().references(() => caddieProfilesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  /** Date in YYYY-MM-DD format */
  date: text("date").notNull(),
  isAvailable: boolean("is_available").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("caddie_availability_caddie_date_unique").on(t.caddieId, t.date),
  index("caddie_availability_org_date_idx").on(t.organizationId, t.date),
]);

/** Caddie assignments — links a caddie to a tee booking */
export const caddieAssignmentsTable = pgTable("caddie_assignments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  teeBookingId: integer("tee_booking_id").notNull().references(() => teeBookingsTable.id, { onDelete: "cascade" }),
  caddieId: integer("caddie_id").notNull().references(() => caddieProfilesTable.id, { onDelete: "restrict" }),
  /** The member who requested/was assigned this caddie (null = group booking with one caddie for all) */
  memberId: integer("member_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  status: caddieAssignmentStatusEnum("status").notNull().default("assigned"),
  feeCharged: numeric("fee_charged", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  /** True when the fee has been added to the member's booking bill */
  feeAddedToBooking: boolean("fee_added_to_booking").notNull().default(false),
  /** Tip amount submitted by the member post-round */
  tipAmount: numeric("tip_amount", { precision: 10, scale: 2 }),
  tipRecordedAt: timestamp("tip_recorded_at", { withTimezone: true }),
  notes: text("notes"),
  assignedByUserId: integer("assigned_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancellationReason: text("cancellation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("caddie_assignments_org_idx").on(t.organizationId),
  index("caddie_assignments_booking_idx").on(t.teeBookingId),
  index("caddie_assignments_caddie_idx").on(t.caddieId),
  uniqueIndex("caddie_assignments_booking_caddie_unique").on(t.teeBookingId, t.caddieId),
]);

/** Post-round rating submitted by a member for their caddie */
export const caddieRatingsTable = pgTable("caddie_ratings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  assignmentId: integer("assignment_id").notNull().references(() => caddieAssignmentsTable.id, { onDelete: "cascade" }),
  caddieId: integer("caddie_id").notNull().references(() => caddieProfilesTable.id, { onDelete: "cascade" }),
  ratedByUserId: integer("rated_by_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  /** 1–5 star rating */
  rating: integer("rating").notNull(),
  comment: text("comment"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("caddie_ratings_assignment_user_unique").on(t.assignmentId, t.ratedByUserId),
  index("caddie_ratings_caddie_idx").on(t.caddieId),
]);

export type CaddieProfile = typeof caddieProfilesTable.$inferSelect;
export type CaddieAvailability = typeof caddieAvailabilityTable.$inferSelect;
export type CaddieAssignment = typeof caddieAssignmentsTable.$inferSelect;
export type CaddieRating = typeof caddieRatingsTable.$inferSelect;

// ─── COURSE MAINTENANCE & GREENKEEPER LOGS (Task #108) ───────────────────────

export const courseAreaEnum = pgEnum("course_area", [
  "hole_1", "hole_2", "hole_3", "hole_4", "hole_5", "hole_6", "hole_7", "hole_8", "hole_9",
  "hole_10", "hole_11", "hole_12", "hole_13", "hole_14", "hole_15", "hole_16", "hole_17", "hole_18",
  "driving_range", "practice_green", "clubhouse_surrounds", "car_park", "general",
]);

export const conditionRatingEnum = pgEnum("condition_rating", [
  "excellent", "good", "fair", "poor", "closed",
]);

export const maintenanceTaskStatusEnum = pgEnum("maintenance_task_status", [
  "pending", "in_progress", "completed", "overdue", "cancelled",
]);

export const maintenanceTaskPriorityEnum = pgEnum("maintenance_task_priority", [
  "low", "medium", "high", "urgent",
]);

export const equipmentTypeEnum = pgEnum("equipment_type", [
  "mower_fairway", "mower_green", "mower_rough", "mower_tee",
  "irrigation_pump", "irrigation_controller", "aerator", "scarifier",
  "topdresser", "sprayer", "tractor", "utility_vehicle", "other",
]);

export const noticeTypeEnum = pgEnum("course_notice_type", [
  "closure", "gur", "preferred_lies", "temporary_green", "hazard", "general",
]);

/** Daily condition report per area/hole logged by greenkeeper */
export const courseConditionReportsTable = pgTable("course_condition_reports", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  reportedById: integer("reported_by_id").notNull().references(() => appUsersTable.id),
  area: courseAreaEnum("area").notNull(),
  greenSpeed: numeric("green_speed", { precision: 4, scale: 1 }),
  fairwayCondition: conditionRatingEnum("fairway_condition"),
  greenCondition: conditionRatingEnum("green_condition"),
  teeCondition: conditionRatingEnum("tee_condition"),
  roughCondition: conditionRatingEnum("rough_condition"),
  bunkerCondition: conditionRatingEnum("bunker_condition"),
  notes: text("notes"),
  photoUrls: jsonb("photo_urls").$type<string[]>().default([]),
  reportDate: timestamp("report_date", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("cond_reports_org_idx").on(t.organizationId),
  index("cond_reports_date_idx").on(t.organizationId, t.reportDate),
  index("cond_reports_area_idx").on(t.organizationId, t.area),
]);

/** Maintenance tasks assigned to grounds staff */
export const maintenanceTasksTable = pgTable("maintenance_tasks", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  createdById: integer("created_by_id").notNull().references(() => appUsersTable.id),
  assignedToId: integer("assigned_to_id").references(() => appUsersTable.id),
  title: text("title").notNull(),
  description: text("description"),
  area: courseAreaEnum("area"),
  priority: maintenanceTaskPriorityEnum("priority").notNull().default("medium"),
  status: maintenanceTaskStatusEnum("status").notNull().default("pending"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completionNotes: text("completion_notes"),
  photoUrls: jsonb("photo_urls").$type<string[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("maint_tasks_org_idx").on(t.organizationId),
  index("maint_tasks_status_idx").on(t.organizationId, t.status),
  index("maint_tasks_assigned_idx").on(t.assignedToId),
  index("maint_tasks_due_idx").on(t.dueDate),
]);

/** Equipment service/maintenance log */
export const equipmentRecordsTable = pgTable("equipment_records", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  equipmentType: equipmentTypeEnum("equipment_type").notNull(),
  serialNumber: text("serial_number"),
  make: text("make"),
  model: text("model"),
  purchaseDate: timestamp("purchase_date", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("equipment_org_idx").on(t.organizationId),
]);

/** Individual service log entries for a piece of equipment */
export const equipmentServiceLogsTable = pgTable("equipment_service_logs", {
  id: serial("id").primaryKey(),
  equipmentId: integer("equipment_id").notNull().references(() => equipmentRecordsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  loggedById: integer("logged_by_id").notNull().references(() => appUsersTable.id),
  serviceType: text("service_type").notNull(),
  description: text("description"),
  hoursAtService: numeric("hours_at_service", { precision: 8, scale: 1 }),
  nextServiceHours: numeric("next_service_hours", { precision: 8, scale: 1 }),
  nextServiceDate: timestamp("next_service_date", { withTimezone: true }),
  cost: numeric("cost", { precision: 10, scale: 2 }),
  photoUrls: jsonb("photo_urls").$type<string[]>().default([]),
  serviceDate: timestamp("service_date", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("equip_service_log_equip_idx").on(t.equipmentId),
  index("equip_service_log_org_idx").on(t.organizationId),
  index("equip_service_log_date_idx").on(t.serviceDate),
]);

/** Course notices published to members (closures, GUR, etc.) */
export const courseNoticesTable = pgTable("course_notices", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  createdById: integer("created_by_id").notNull().references(() => appUsersTable.id),
  title: text("title").notNull(),
  body: text("body").notNull(),
  noticeType: noticeTypeEnum("notice_type").notNull().default("general"),
  area: courseAreaEnum("area"),
  isPublished: boolean("is_published").notNull().default(false),
  isPinned: boolean("is_pinned").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("course_notices_org_idx").on(t.organizationId),
  index("course_notices_published_idx").on(t.organizationId, t.isPublished),
]);

export type CourseConditionReport = typeof courseConditionReportsTable.$inferSelect;
export type MaintenanceTask = typeof maintenanceTasksTable.$inferSelect;
export type EquipmentRecord = typeof equipmentRecordsTable.$inferSelect;
export type EquipmentServiceLog = typeof equipmentServiceLogsTable.$inferSelect;
export type CourseNotice = typeof courseNoticesTable.$inferSelect;

// ─── TASK #109: EVENT & BANQUET / FUNCTION MANAGEMENT ─────────────────────────

export const functionSpaceLayoutEnum = pgEnum("function_space_layout", [
  "theatre", "classroom", "banquet", "cabaret", "boardroom", "cocktail", "u_shape", "hollow_square",
]);

export const eventEnquiryStatusEnum = pgEnum("event_enquiry_status", [
  "enquiry", "quote_sent", "confirmed", "invoiced", "paid", "cancelled",
]);

export const eventInvoiceStatusEnum = pgEnum("event_invoice_status", [
  "draft", "sent", "paid", "overdue", "cancelled",
]);

/**
 * Defines the physical function spaces available at the club
 * (rooms, marquees, terraces, etc.)
 */
export const functionSpacesTable = pgTable("function_spaces", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /** Max guests depending on layout */
  capacitySeated: integer("capacity_seated"),
  capacityStanding: integer("capacity_standing"),
  facilities: jsonb("facilities").$type<string[]>().default([]),
  /** AV equipment: projector, PA system, etc. */
  avEquipment: jsonb("av_equipment").$type<string[]>().default([]),
  /** Base hire price per day / session in org currency */
  basePricePerDay: numeric("base_price_per_day", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  photoUrls: jsonb("photo_urls").$type<string[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("function_spaces_org_idx").on(t.organizationId),
]);

/**
 * Catering & beverage packages that can be attached to bookings
 */
export const eventCateringPackagesTable = pgTable("event_catering_packages", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /** Per-person price */
  pricePerHead: numeric("price_per_head", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  /** Menu items as array of strings (structured list) */
  menuItems: jsonb("menu_items").$type<{ category: string; items: string[] }[]>().default([]),
  /** drink packages, dietary options, etc. */
  inclusions: jsonb("inclusions").$type<string[]>().default([]),
  minimumGuests: integer("minimum_guests"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("event_catering_packages_org_idx").on(t.organizationId),
]);

/**
 * Event enquiries / bookings pipeline
 */
export const eventBookingsTable = pgTable("event_bookings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  functionSpaceId: integer("function_space_id").references(() => functionSpacesTable.id, { onDelete: "set null" }),
  cateringPackageId: integer("catering_package_id"),
  /** Pipeline status */
  status: eventEnquiryStatusEnum("status").notNull().default("enquiry"),
  /** Event organiser contact details */
  organiserName: text("organiser_name").notNull(),
  organiserEmail: text("organiser_email").notNull(),
  organiserPhone: text("organiser_phone"),
  organiserCompany: text("organiser_company"),
  /** Event details */
  eventName: text("event_name").notNull(),
  eventType: text("event_type"), // wedding, corporate, award dinner, society, etc.
  eventDate: timestamp("event_date", { withTimezone: true }).notNull(),
  startTime: text("start_time"), // "14:00"
  endTime: text("end_time"),   // "23:00"
  expectedGuests: integer("expected_guests"),
  /** Confirmed guest count (updated closer to event) */
  finalGuestCount: integer("final_guest_count"),
  layout: functionSpaceLayoutEnum("layout"),
  /** Catering & AV requirements as free text + structured notes */
  cateringNotes: text("catering_notes"),
  avRequirements: text("av_requirements"),
  specialRequirements: text("special_requirements"),
  /** Financial */
  spaceHireAmount: numeric("space_hire_amount", { precision: 10, scale: 2 }),
  cateringAmount: numeric("catering_amount", { precision: 10, scale: 2 }),
  /** Extra line items (decorations, staffing, etc.) as JSON */
  extras: jsonb("extras").$type<{ description: string; amount: number }[]>().default([]),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }),
  depositAmount: numeric("deposit_amount", { precision: 10, scale: 2 }),
  depositPaid: boolean("deposit_paid").notNull().default(false),
  currency: text("currency").notNull().default("INR"),
  /** Admin notes / internal comments */
  internalNotes: text("internal_notes"),
  /** Assigned to which admin user */
  assignedToUserId: integer("assigned_to_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("event_bookings_org_idx").on(t.organizationId),
  index("event_bookings_status_idx").on(t.organizationId, t.status),
  index("event_bookings_date_idx").on(t.organizationId, t.eventDate),
  index("event_bookings_space_idx").on(t.functionSpaceId, t.eventDate),
  foreignKey({ name: "event_bookings_catering_package_id_fk", columns: [t.cateringPackageId], foreignColumns: [eventCateringPackagesTable.id] }).onDelete("set null"),
]);

/**
 * Invoices for event bookings
 */
export const eventInvoicesTable = pgTable("event_invoices", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  bookingId: integer("booking_id").notNull().references(() => eventBookingsTable.id, { onDelete: "cascade" }),
  invoiceNumber: text("invoice_number").notNull(),
  status: eventInvoiceStatusEnum("status").notNull().default("draft"),
  lineItems: jsonb("line_items").$type<{ description: string; quantity: number; unitPrice: number; total: number }[]>().notNull().default([]),
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull().default("0"),
  taxRate: numeric("tax_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  taxAmount: numeric("tax_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  notes: text("notes"),
  /** Email delivery tracking */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("event_invoices_org_idx").on(t.organizationId),
  index("event_invoices_booking_idx").on(t.bookingId),
  uniqueIndex("event_invoices_number_org_uidx").on(t.organizationId, t.invoiceNumber),
]);

export type FunctionSpace = typeof functionSpacesTable.$inferSelect;
export type EventCateringPackage = typeof eventCateringPackagesTable.$inferSelect;
export type EventBooking = typeof eventBookingsTable.$inferSelect;
export type EventInvoice = typeof eventInvoicesTable.$inferSelect;

// ─── STAFF SCHEDULING & ROSTER MANAGEMENT (Task #110) ────────────────────────

export const staffDepartmentEnum = pgEnum("staff_department", [
  "pro_shop", "food_and_beverage", "grounds", "reception", "administration", "security", "maintenance", "other",
]);

export const shiftStatusEnum = pgEnum("shift_status", [
  "draft", "published", "confirmed", "cancelled",
]);

export const leaveTypeEnum = pgEnum("leave_type", [
  "annual", "sick", "unpaid", "personal", "bereavement", "public_holiday",
]);

export const leaveStatusEnum = pgEnum("leave_status", [
  "pending", "approved", "rejected", "cancelled",
]);

export const rosterPeriodEnum = pgEnum("roster_period", [
  "weekly", "fortnightly",
]);

/** Staff HR profile — one per employee per organisation */
export const staffProfilesTable = pgTable("staff_profiles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  department: staffDepartmentEnum("department").notNull().default("pro_shop"),
  position: text("position"),
  employmentType: text("employment_type").notNull().default("full_time"),
  pin: text("pin"),
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  annualLeaveBalance: numeric("annual_leave_balance", { precision: 6, scale: 2 }).notNull().default("0"),
  sickLeaveBalance: numeric("sick_leave_balance", { precision: 6, scale: 2 }).notNull().default("0"),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("staff_profiles_org_idx").on(t.organizationId),
  index("staff_profiles_user_idx").on(t.userId),
]);

/** A named roster covering a date range (weekly or fortnightly) */
export const rostersTable = pgTable("rosters", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  department: staffDepartmentEnum("department"),
  period: rosterPeriodEnum("period").notNull().default("weekly"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  isPublished: boolean("is_published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedByUserId: integer("published_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("rosters_org_idx").on(t.organizationId),
  index("rosters_dates_idx").on(t.startDate, t.endDate),
]);

/** Individual shift within a roster */
export const shiftsTable = pgTable("shifts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  rosterId: integer("roster_id").references(() => rostersTable.id, { onDelete: "cascade" }),
  staffProfileId: integer("staff_profile_id").notNull().references(() => staffProfilesTable.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time").notNull(),
  department: staffDepartmentEnum("department").notNull().default("pro_shop"),
  role: text("role"),
  status: shiftStatusEnum("status").notNull().default("draft"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shifts_org_idx").on(t.organizationId),
  index("shifts_roster_idx").on(t.rosterId),
  index("shifts_staff_idx").on(t.staffProfileId),
  index("shifts_date_idx").on(t.date),
]);

/** Leave requests from staff */
export const leaveRequestsTable = pgTable("leave_requests", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  staffProfileId: integer("staff_profile_id").notNull().references(() => staffProfilesTable.id, { onDelete: "cascade" }),
  leaveType: leaveTypeEnum("leave_type").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  totalDays: numeric("total_days", { precision: 4, scale: 1 }).notNull(),
  reason: text("reason"),
  status: leaveStatusEnum("status").notNull().default("pending"),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNotes: text("review_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("leave_requests_org_idx").on(t.organizationId),
  index("leave_requests_staff_idx").on(t.staffProfileId),
]);

/** Clock-in / clock-out records */
export const timesheetEntriesTable = pgTable("timesheet_entries", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  staffProfileId: integer("staff_profile_id").notNull().references(() => staffProfilesTable.id, { onDelete: "cascade" }),
  shiftId: integer("shift_id").references(() => shiftsTable.id, { onDelete: "set null" }),
  date: text("date").notNull(),
  clockIn: text("clock_in"),
  clockOut: text("clock_out"),
  breakMinutes: integer("break_minutes").notNull().default(0),
  totalMinutes: integer("total_minutes"),
  regularMinutes: integer("regular_minutes"),
  overtimeMinutes: integer("overtime_minutes"),
  isManualEntry: boolean("is_manual_entry").notNull().default(false),
  isApproved: boolean("is_approved").notNull().default(false),
  approvedByUserId: integer("approved_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("timesheet_entries_org_idx").on(t.organizationId),
  index("timesheet_entries_staff_idx").on(t.staffProfileId),
  index("timesheet_entries_date_idx").on(t.date),
]);

/** Overtime/penalty rate configuration rules per org */
export const overtimeRulesTable = pgTable("overtime_rules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  regularHoursPerDay: numeric("regular_hours_per_day", { precision: 4, scale: 2 }).notNull().default("8"),
  regularHoursPerWeek: numeric("regular_hours_per_week", { precision: 5, scale: 2 }).notNull().default("40"),
  overtimeMultiplier: numeric("overtime_multiplier", { precision: 4, scale: 2 }).notNull().default("1.5"),
  doubleTimeMultiplier: numeric("double_time_multiplier", { precision: 4, scale: 2 }).notNull().default("2.0"),
  weekendPenaltyMultiplier: numeric("weekend_penalty_multiplier", { precision: 4, scale: 2 }).notNull().default("1.25"),
  publicHolidayMultiplier: numeric("public_holiday_multiplier", { precision: 4, scale: 2 }).notNull().default("2.5"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("overtime_rules_org_idx").on(t.organizationId),
]);

export type StaffProfile = typeof staffProfilesTable.$inferSelect;
export type Roster = typeof rostersTable.$inferSelect;
export type Shift = typeof shiftsTable.$inferSelect;
export type LeaveRequest = typeof leaveRequestsTable.$inferSelect;
export type TimesheetEntry = typeof timesheetEntriesTable.$inferSelect;
export type OvertimeRule = typeof overtimeRulesTable.$inferSelect;

// ─── TASK #112: GUEST & VISITOR PASS MANAGEMENT ──────────────────────────────

export const guestPassStatusEnum = pgEnum("guest_pass_status", [
  "pending", "confirmed", "checked_in", "no_show", "cancelled",
]);

export const guestFeeSettlementEnum = pgEnum("guest_fee_settlement", [
  "member_account", "guest_online", "pay_at_desk",
]);

/** Guest pass attached to a tee booking — one row per guest player */
export const guestPassesTable = pgTable("guest_passes", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  teeBookingId: integer("tee_booking_id").references(() => teeBookingsTable.id, { onDelete: "set null" }),
  teeBookingPlayerId: integer("tee_booking_player_id").references(() => teeBookingPlayersTable.id, { onDelete: "set null" }),
  invitedByUserId: integer("invited_by_user_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  guestName: text("guest_name").notNull(),
  guestEmail: text("guest_email"),
  guestPhone: text("guest_phone"),
  playDate: timestamp("play_date", { withTimezone: true }).notNull(),
  greenFee: numeric("green_fee", { precision: 10, scale: 2 }).notNull().default("0"),
  feeSettlement: guestFeeSettlementEnum("fee_settlement").notNull().default("pay_at_desk"),
  status: guestPassStatusEnum("status").notNull().default("pending"),
  qrToken: text("qr_token").notNull().unique(),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  checkedInByUserId: integer("checked_in_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("guest_passes_org_idx").on(t.organizationId),
  index("guest_passes_booking_idx").on(t.teeBookingId),
  index("guest_passes_invited_by_idx").on(t.invitedByUserId),
  index("guest_passes_play_date_idx").on(t.playDate),
]);

/** Visitor day passes purchased directly by non-members */
export const visitorPassStatusEnum = pgEnum("visitor_pass_status", [
  "pending_payment", "paid", "checked_in", "no_show", "cancelled", "refunded",
]);

export const visitorPassesTable = pgTable("visitor_passes", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  visitorName: text("visitor_name").notNull(),
  visitorEmail: text("visitor_email").notNull(),
  visitorPhone: text("visitor_phone"),
  playDate: timestamp("play_date", { withTimezone: true }).notNull(),
  greenFee: numeric("green_fee", { precision: 10, scale: 2 }).notNull(),
  status: visitorPassStatusEnum("status").notNull().default("pending_payment"),
  qrToken: text("qr_token").notNull().unique(),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  checkedInByUserId: integer("checked_in_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("visitor_passes_org_idx").on(t.organizationId),
  index("visitor_passes_play_date_idx").on(t.playDate),
]);

/** Visitor pricing rules — extends teePricingRulesTable with per-category/day config */
export const visitorPricingRulesTable = pgTable("visitor_pricing_rules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  description: text("description"),
  weekdayRate: numeric("weekday_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  weekendRate: numeric("weekend_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  twilightRate: numeric("twilight_rate", { precision: 10, scale: 2 }),
  reciprocalRate: numeric("reciprocal_rate", { precision: 10, scale: 2 }),
  /** Day-of-week overrides: JSON map { "0": "2000", "6": "2500" } (0=Sun) */
  dayOverrides: jsonb("day_overrides").$type<Record<string, string>>().default({}),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("visitor_pricing_org_idx").on(t.organizationId),
]);

/** Per-org guest limits policy */
export const guestPolicyTable = pgTable("guest_policy", {
  organizationId: integer("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  maxGuestsPerMemberPerMonth: integer("max_guests_per_member_per_month").notNull().default(10),
  maxGuestsPerMemberPerYear: integer("max_guests_per_member_per_year").notNull().default(60),
  allowMemberAccountSettlement: boolean("allow_member_account_settlement").notNull().default(true),
  allowGuestOnlinePayment: boolean("allow_guest_online_payment").notNull().default(true),
  allowPayAtDesk: boolean("allow_pay_at_desk").notNull().default(true),
  requireGuestEmail: boolean("require_guest_email").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GuestPass = typeof guestPassesTable.$inferSelect;
export type VisitorPass = typeof visitorPassesTable.$inferSelect;
export type VisitorPricingRule = typeof visitorPricingRulesTable.$inferSelect;
export type GuestPolicy = typeof guestPolicyTable.$inferSelect;

// ─── ANNUAL DUES & BILLING ────────────────────────────────────────────────────

export const billingCycleEnum = pgEnum("billing_cycle", [
  "annual", "semi_annual", "quarterly", "monthly",
]);

export const duesInvoiceStatusEnum = pgEnum("dues_invoice_status", [
  "draft", "sent", "paid", "overdue", "cancelled", "void",
]);

export const duesPaymentMethodEnum = pgEnum("dues_payment_method", [
  "online", "bank_transfer", "account_credit", "cash", "cheque",
]);

/** Per-membership-category billing schedule configured by admin */
export const billingSchedulesTable = pgTable("billing_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tierId: integer("tier_id").references(() => membershipTiersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  billingCycle: billingCycleEnum("billing_cycle").notNull().default("annual"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  gracePeriodDays: integer("grace_period_days").notNull().default(14),
  suspendAfterDays: integer("suspend_after_days").notNull().default(30),
  reminderDaysBefore: jsonb("reminder_days_before").$type<number[]>().default([7, 1]),
  autoGenerate: boolean("auto_generate").notNull().default(true),
  nextRunDate: timestamp("next_run_date", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("billing_schedules_org_idx").on(t.organizationId)]);

/** Member dues invoices */
export const memberInvoicesTable = pgTable("member_invoices", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  scheduleId: integer("schedule_id").references(() => billingSchedulesTable.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number").notNull(),
  status: duesInvoiceStatusEnum("status").notNull().default("draft"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paidAmount: numeric("paid_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  paymentMethod: duesPaymentMethodEnum("payment_method"),
  razorpayPaymentLinkId: text("razorpay_payment_link_id"),
  razorpayPaymentLinkUrl: text("razorpay_payment_link_url"),
  razorpayPaymentId: text("razorpay_payment_id"),
  /** When reminders were sent (array of ISO timestamps) */
  remindersSentAt: jsonb("reminders_sent_at").$type<string[]>().default([]),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_invoices_org_idx").on(t.organizationId),
  index("member_invoices_member_idx").on(t.clubMemberId),
  uniqueIndex("member_invoice_number_org_uidx").on(t.organizationId, t.invoiceNumber),
]);

/** Line items on a member invoice (dues, levies, locker fees, joining bonds, etc.) */
export const invoiceLineItemsTable = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => memberInvoicesTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 8, scale: 2 }).notNull().default("1"),
  unitAmount: numeric("unit_amount", { precision: 10, scale: 2 }).notNull(),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }).notNull(),
  lineType: text("line_type").notNull().default("dues"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("invoice_line_items_invoice_idx").on(t.invoiceId)]);

/** Payment records against member invoices */
export const duesPaymentsTable = pgTable("dues_payments", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => memberInvoicesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  method: duesPaymentMethodEnum("method").notNull().default("online"),
  reference: text("reference"),
  razorpayPaymentId: text("razorpay_payment_id"),
  notes: text("notes"),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("dues_payments_invoice_idx").on(t.invoiceId)]);

export type BillingSchedule = typeof billingSchedulesTable.$inferSelect;
export type MemberInvoice = typeof memberInvoicesTable.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItemsTable.$inferSelect;
export type DuesPayment = typeof duesPaymentsTable.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNTING & FINANCE — Task #114
// ─────────────────────────────────────────────────────────────────────────────

export const accountingPlatformEnum = pgEnum("accounting_platform", [
  "xero", "quickbooks",
]);

export const accountingSyncStatusEnum = pgEnum("accounting_sync_status", [
  "pending", "synced", "failed", "skipped",
]);

export const ledgerEventTypeEnum = pgEnum("ledger_event_type", [
  "pos_sale", "booking_fee", "membership_due", "lesson_fee", "fb_order",
  "event_fee", "rental_fee", "commission", "gift_card_sale", "gift_card_redemption",
  "refund", "other",
]);

/** OAuth connection to an external accounting platform (Xero / QuickBooks) */
export const accountingConnectionsTable = pgTable("accounting_connections", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  platform: accountingPlatformEnum("platform").notNull(),
  tenantId: text("tenant_id"),
  tenantName: text("tenant_name"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastSyncStatus: text("last_sync_status"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("accounting_connections_org_idx").on(t.organizationId),
  unique("accounting_connections_org_platform").on(t.organizationId, t.platform),
]);

/** Maps a club revenue category to a chart-of-accounts code in the connected platform */
export const accountingCoaMapTable = pgTable("accounting_coa_map", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  eventType: ledgerEventTypeEnum("event_type").notNull(),
  accountCode: text("account_code").notNull(),
  accountName: text("account_name"),
  taxCode: text("tax_code"),
  taxRate: numeric("tax_rate", { precision: 5, scale: 4 }).default("0"),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("accounting_coa_map_org_idx").on(t.organizationId),
  unique("accounting_coa_map_org_type").on(t.organizationId, t.eventType),
]);

/** Unified financial ledger — every revenue event across all modules */
export const financialLedgerTable = pgTable("financial_ledger", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  eventType: ledgerEventTypeEnum("event_type").notNull(),
  sourceModule: text("source_module").notNull(),
  sourceId: integer("source_id"),
  sourceRef: text("source_ref"),
  memberId: integer("member_id"),
  memberName: text("member_name"),
  description: text("description").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  taxCode: text("tax_code"),
  accountCode: text("account_code"),
  transactionDate: text("transaction_date").notNull(),
  syncStatus: accountingSyncStatusEnum("sync_status").notNull().default("pending"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  externalRef: text("external_ref"),
  syncError: text("sync_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("financial_ledger_org_idx").on(t.organizationId),
  index("financial_ledger_date_idx").on(t.transactionDate),
  index("financial_ledger_sync_idx").on(t.syncStatus),
  index("financial_ledger_event_type_idx").on(t.eventType),
]);

export type AccountingConnection = typeof accountingConnectionsTable.$inferSelect;
export type AccountingCoaMap = typeof accountingCoaMapTable.$inferSelect;
export type FinancialLedger = typeof financialLedgerTable.$inferSelect;

// ─── TASK #83: DRIVING RANGE & BAY BOOKING ──────────────────────────────────

export const rangeBookingStatusEnum = pgEnum("range_booking_status", [
  "pending", "confirmed", "cancelled", "completed", "no_show",
]);

export const rangePlayerTypeEnum = pgEnum("range_player_type", ["member", "visitor"]);

export const rangeBayTable = pgTable("range_bays", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  bayNumber: integer("bay_number").notNull(),
  label: text("label"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("range_bay_org_number_unique").on(t.organizationId, t.bayNumber),
  index("range_bay_org_idx").on(t.organizationId),
]);

export const rangeConfigTable = pgTable("range_config", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().unique().references(() => organizationsTable.id, { onDelete: "cascade" }),
  slotDurationMinutes: integer("slot_duration_minutes").notNull().default(30),
  firstSlotTime: text("first_slot_time").notNull().default("06:00"),
  lastSlotTime: text("last_slot_time").notNull().default("21:00"),
  memberRate: numeric("member_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  visitorRate: numeric("visitor_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  peakMemberRate: numeric("peak_member_rate", { precision: 10, scale: 2 }),
  peakVisitorRate: numeric("peak_visitor_rate", { precision: 10, scale: 2 }),
  peakStartTime: text("peak_start_time"),
  peakEndTime: text("peak_end_time"),
  ballsPerBucket: integer("balls_per_bucket").notNull().default(50),
  bucketsIncluded: integer("buckets_included").notNull().default(1),
  cancellationCutoffHours: integer("cancellation_cutoff_hours").notNull().default(2),
  paymentModel: text("payment_model").notNull().default("pay_at_checkin"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rangeBlackoutTable = pgTable("range_blackouts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("range_blackout_org_idx").on(t.organizationId)]);

export const rangeSlotStatusEnum = pgEnum("range_slot_status", [
  "open", "blocked", "booked",
]);

export const rangeSlotTable = pgTable("range_slots", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  bayId: integer("bay_id").notNull().references(() => rangeBayTable.id, { onDelete: "cascade" }),
  slotDate: timestamp("slot_date", { withTimezone: true }).notNull(),
  slotTime: text("slot_time").notNull(),
  status: rangeSlotStatusEnum("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("range_slot_bay_date_time_unique").on(t.bayId, t.slotDate, t.slotTime),
  index("range_slot_org_date_idx").on(t.organizationId, t.slotDate),
]);

export const rangeBookingTable = pgTable("range_bookings", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  bayId: integer("bay_id").notNull().references(() => rangeBayTable.id, { onDelete: "restrict" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  playerType: rangePlayerTypeEnum("player_type").notNull().default("member"),
  guestName: text("guest_name"),
  guestEmail: text("guest_email"),
  slotDate: timestamp("slot_date", { withTimezone: true }).notNull(),
  slotTime: text("slot_time").notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  status: rangeBookingStatusEnum("status").notNull().default("confirmed"),
  totalAmount: numeric("total_amount", { precision: 10, scale: 2 }),
  currency: text("currency").notNull().default("INR"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  qrToken: text("qr_token").unique(),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
  checkedInByUserId: integer("checked_in_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  cancellationReason: text("cancellation_reason"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  rescheduledFromId: integer("rescheduled_from_id"),
  emailSent: boolean("email_sent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("range_booking_bay_slot_unique").on(t.bayId, t.slotDate, t.slotTime),
  index("range_booking_org_idx").on(t.organizationId),
  index("range_booking_user_idx").on(t.userId),
  index("range_booking_date_idx").on(t.slotDate),
]);

export const ballTokenCreditTable = pgTable("ball_token_credits", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  bookingId: integer("booking_id").references(() => rangeBookingTable.id, { onDelete: "set null" }),
  bucketsCount: integer("buckets_count").notNull().default(0),
  ballsPerBucket: integer("balls_per_bucket").notNull().default(50),
  usedAt: timestamp("used_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ball_token_credits_user_idx").on(t.userId),
  index("ball_token_credits_org_idx").on(t.organizationId),
]);

export type RangeBay = typeof rangeBayTable.$inferSelect;
export type RangeConfig = typeof rangeConfigTable.$inferSelect;
export type RangeBlackout = typeof rangeBlackoutTable.$inferSelect;
export type RangeSlot = typeof rangeSlotTable.$inferSelect;
export type RangeBooking = typeof rangeBookingTable.$inferSelect;
export type BallTokenCredit = typeof ballTokenCreditTable.$inferSelect;

// ─── MEMBER FEEDBACK & SURVEYS ────────────────────────────────────────────────

export const surveyStatusEnum = pgEnum("survey_status", [
  "draft", "active", "closed",
]);

export const surveyTriggerEnum = pgEnum("survey_trigger", [
  "manual", "post_round", "post_event", "post_tournament",
]);

export const questionTypeEnum = pgEnum("question_type", [
  "rating", "multiple_choice", "free_text", "nps",
]);

/** Survey definitions created by admin */
export const surveysTable = pgTable("surveys", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  status: surveyStatusEnum("status").notNull().default("draft"),
  trigger: surveyTriggerEnum("trigger").notNull().default("manual"),
  isAnonymous: boolean("is_anonymous").notNull().default(false),
  targetSegment: text("target_segment"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("surveys_org_idx").on(t.organizationId),
  index("surveys_status_idx").on(t.status),
]);

/** Questions belonging to a survey */
export const surveyQuestionsTable = pgTable("survey_questions", {
  id: serial("id").primaryKey(),
  surveyId: integer("survey_id").notNull().references(() => surveysTable.id, { onDelete: "cascade" }),
  type: questionTypeEnum("type").notNull(),
  questionText: text("question_text").notNull(),
  isRequired: boolean("is_required").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  options: jsonb("options").$type<string[]>().default([]),
  ratingMin: integer("rating_min").default(1),
  ratingMax: integer("rating_max").default(5),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("survey_questions_survey_idx").on(t.surveyId),
]);

/** One response record per member per survey */
export const surveyResponsesTable = pgTable("survey_responses", {
  id: serial("id").primaryKey(),
  surveyId: integer("survey_id").notNull().references(() => surveysTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  respondentUserId: integer("respondent_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  respondentEmail: text("respondent_email"),
  isAnonymous: boolean("is_anonymous").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("survey_responses_survey_idx").on(t.surveyId),
  index("survey_responses_user_idx").on(t.respondentUserId),
]);

/** Individual answer per question per response */
export const surveyResponseItemsTable = pgTable("survey_response_items", {
  id: serial("id").primaryKey(),
  responseId: integer("response_id").notNull().references(() => surveyResponsesTable.id, { onDelete: "cascade" }),
  questionId: integer("question_id").notNull().references(() => surveyQuestionsTable.id, { onDelete: "cascade" }),
  ratingValue: integer("rating_value"),
  choiceValue: text("choice_value"),
  textValue: text("text_value"),
  npsScore: integer("nps_score"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("survey_response_items_response_idx").on(t.responseId),
  index("survey_response_items_question_idx").on(t.questionId),
]);

export type Survey = typeof surveysTable.$inferSelect;
export type SurveyQuestion = typeof surveyQuestionsTable.$inferSelect;
export type SurveyResponse = typeof surveyResponsesTable.$inferSelect;
export type SurveyResponseItem = typeof surveyResponseItemsTable.$inferSelect;

// INTERCLUB ROSTER — home/away player roster for a fixture
export const interclubRosterTable = pgTable("interclub_roster", {
  id: serial("id").primaryKey(),
  fixtureId: integer("fixture_id").notNull().references(() => interclubFixtureFullTable.id, { onDelete: "cascade" }),
  side: text("side").notNull().default("home"),
  playerName: text("player_name").notNull(),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("interclub_roster_fixture_idx").on(t.fixtureId),
]);

// INTERCLUB MATCH — individual match result within a fixture
export const interclubMatchTable = pgTable("interclub_match", {
  id: serial("id").primaryKey(),
  fixtureId: integer("fixture_id").notNull().references(() => interclubFixtureFullTable.id, { onDelete: "cascade" }),
  matchNumber: integer("match_number").notNull().default(1),
  homePlayerName: text("home_player_name").notNull(),
  homePlayerId: integer("home_player_id").references(() => interclubRosterTable.id, { onDelete: "set null" }),
  awayPlayerName: text("away_player_name").notNull(),
  awayPlayerId: integer("away_player_id").references(() => interclubRosterTable.id, { onDelete: "set null" }),
  result: text("result").notNull().default("pending"),
  homePoints: numeric("home_points", { precision: 4, scale: 1 }),
  awayPoints: numeric("away_points", { precision: 4, scale: 1 }),
  holesPlayed: integer("holes_played"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("interclub_match_fixture_idx").on(t.fixtureId),
]);

export type ClubChampionship = typeof clubChampionshipTable.$inferSelect;
export type ChampionshipFlight = typeof championshipFlightTable.$inferSelect;
export type ChampionshipWinner = typeof championshipWinnerTable.$inferSelect;
export type InterclubSeason = typeof interclubSeasonTable.$inferSelect;
export type InterclubFixtureFull = typeof interclubFixtureFullTable.$inferSelect;
export type InterclubRoster = typeof interclubRosterTable.$inferSelect;
export type InterclubMatch = typeof interclubMatchTable.$inferSelect;

// ─── JUNIOR GOLF PROGRAMS ─────────────────────────────────────────────────────

export const juniorAgeCategoryEnum = pgEnum("junior_age_category", [
  "under_8", "under_10", "under_12", "under_14", "under_16", "under_18",
]);

export const juniorPathwayLevelEnum = pgEnum("junior_pathway_level", [
  "beginner", "intermediate", "advanced", "elite",
]);

export const juniorAwardTypeEnum = pgEnum("junior_award_type", [
  "monthly_winner", "most_improved", "best_attendance", "spirit_award", "custom",
]);

// Junior profiles — one per junior golfer, linked to their app user account
export const juniorProfilesTable = pgTable("junior_profiles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  dateOfBirth: timestamp("date_of_birth", { withTimezone: true }).notNull(),
  ageCategory: juniorAgeCategoryEnum("age_category").notNull(),
  pathwayLevel: juniorPathwayLevelEnum("pathway_level").notNull().default("beginner"),
  handicapIndex: numeric("handicap_index", { precision: 4, scale: 1 }),
  preferredTeeBox: teeBoxEnum("preferred_tee_box").default("red"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("junior_profiles_org_idx").on(t.organizationId),
  index("junior_profiles_user_idx").on(t.userId),
]);

// Guardian links — parent/guardian accounts linked to junior profiles
export const guardianLinksTable = pgTable("guardian_links", {
  id: serial("id").primaryKey(),
  juniorProfileId: integer("junior_profile_id").notNull().references(() => juniorProfilesTable.id, { onDelete: "cascade" }),
  guardianUserId: integer("guardian_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  guardianName: text("guardian_name").notNull(),
  guardianEmail: text("guardian_email"),
  guardianPhone: text("guardian_phone"),
  relationship: text("relationship").notNull().default("parent"),
  isPrimary: boolean("is_primary").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("guardian_links_junior_idx").on(t.juniorProfileId),
  index("guardian_links_user_idx").on(t.guardianUserId),
]);

// Development pathways — org-defined progression framework
export const developmentPathwaysTable = pgTable("development_pathways", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("dev_pathways_org_idx").on(t.organizationId)]);

// Pathway levels — individual steps within a development pathway
export const pathwayLevelsTable = pgTable("pathway_levels", {
  id: serial("id").primaryKey(),
  pathwayId: integer("pathway_id").notNull().references(() => developmentPathwaysTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  level: juniorPathwayLevelEnum("level").notNull().default("beginner"),
  description: text("description"),
  criteria: text("criteria"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("pathway_levels_pathway_idx").on(t.pathwayId)]);

// Junior pathway progress — tracks each junior's progression through levels
export const juniorPathwayProgressTable = pgTable("junior_pathway_progress", {
  id: serial("id").primaryKey(),
  juniorProfileId: integer("junior_profile_id").notNull().references(() => juniorProfilesTable.id, { onDelete: "cascade" }),
  pathwayId: integer("pathway_id").notNull().references(() => developmentPathwaysTable.id, { onDelete: "cascade" }),
  currentLevelId: integer("current_level_id").references(() => pathwayLevelsTable.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastProgressedAt: timestamp("last_progressed_at", { withTimezone: true }),
  notes: text("notes"),
}, (t) => [
  uniqueIndex("junior_pathway_unique").on(t.juniorProfileId, t.pathwayId),
  index("junior_pathway_progress_junior_idx").on(t.juniorProfileId),
]);

// Junior programs — e.g. "Summer Academy 2026"
export const juniorProgramsTable = pgTable("junior_programs", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  maxParticipants: integer("max_participants"),
  ageCategories: jsonb("age_categories").$type<string[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("junior_programs_org_idx").on(t.organizationId)]);

// Program participants — juniors enrolled in a program
export const programParticipantsTable = pgTable("program_participants", {
  id: serial("id").primaryKey(),
  programId: integer("program_id").notNull().references(() => juniorProgramsTable.id, { onDelete: "cascade" }),
  juniorProfileId: integer("junior_profile_id").notNull().references(() => juniorProfilesTable.id, { onDelete: "cascade" }),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
}, (t) => [
  uniqueIndex("program_participant_unique").on(t.programId, t.juniorProfileId),
  index("program_participants_program_idx").on(t.programId),
  index("program_participants_junior_idx").on(t.juniorProfileId),
]);

// Program sessions — individual training/practice sessions within a program
export const programSessionsTable = pgTable("program_sessions", {
  id: serial("id").primaryKey(),
  programId: integer("program_id").notNull().references(() => juniorProgramsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  durationMinutes: integer("duration_minutes").notNull().default(60),
  location: text("location"),
  coachName: text("coach_name"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("program_sessions_program_idx").on(t.programId),
  index("program_sessions_date_idx").on(t.scheduledAt),
]);

// Program attendance — tracks which juniors attended each session
export const programAttendanceTable = pgTable("program_attendance", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => programSessionsTable.id, { onDelete: "cascade" }),
  juniorProfileId: integer("junior_profile_id").notNull().references(() => juniorProfilesTable.id, { onDelete: "cascade" }),
  attended: boolean("attended").notNull().default(false),
  notes: text("notes"),
  markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("program_attendance_unique").on(t.sessionId, t.juniorProfileId),
  index("program_attendance_session_idx").on(t.sessionId),
  index("program_attendance_junior_idx").on(t.juniorProfileId),
]);

// Age-group awards — monthly winner, most improved, etc.
export const juniorAwardsTable = pgTable("junior_awards", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  programId: integer("program_id").references(() => juniorProgramsTable.id, { onDelete: "set null" }),
  juniorProfileId: integer("junior_profile_id").notNull().references(() => juniorProfilesTable.id, { onDelete: "cascade" }),
  awardType: juniorAwardTypeEnum("award_type").notNull(),
  ageCategory: juniorAgeCategoryEnum("age_category"),
  awardLabel: text("award_label").notNull(),
  description: text("description"),
  awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow(),
  awardedByUserId: integer("awarded_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
}, (t) => [
  index("junior_awards_org_idx").on(t.organizationId),
  index("junior_awards_junior_idx").on(t.juniorProfileId),
  index("junior_awards_program_idx").on(t.programId),
]);

export type JuniorProfile = typeof juniorProfilesTable.$inferSelect;
export type GuardianLink = typeof guardianLinksTable.$inferSelect;
export type DevelopmentPathway = typeof developmentPathwaysTable.$inferSelect;
export type PathwayLevel = typeof pathwayLevelsTable.$inferSelect;
export type JuniorPathwayProgress = typeof juniorPathwayProgressTable.$inferSelect;
export type JuniorProgram = typeof juniorProgramsTable.$inferSelect;
export type ProgramParticipant = typeof programParticipantsTable.$inferSelect;
export type ProgramSession = typeof programSessionsTable.$inferSelect;
export type ProgramAttendance = typeof programAttendanceTable.$inferSelect;
export type JuniorAward = typeof juniorAwardsTable.$inferSelect;
// ─── TASK #90: EVENT DAY STAFFING — CADDIES & VOLUNTEERS/MARSHALS ───────────
// Note: caddieExperienceLevelEnum is reused from Task #106 (defined above).

export const caddieFeeModeEnum = pgEnum("caddie_fee_mode", [
  "cash", "account",
]);

export const volunteersRoleTypeEnum = pgEnum("volunteer_role_type", [
  "starter", "marshal", "scorer", "registration", "first_aid", "transport", "other",
]);

/** Simple event-day caddie roster (distinct from the full caddie profile in Task #106) */
export const caddiesTable = pgTable("caddies", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  phone: text("phone"),
  email: text("email"),
  experienceLevel: caddieExperienceLevelEnum("experience_level").notNull().default("junior"),
  notes: text("notes"),
});

// ─── TASK #116: CLUB MARKETING & EMAIL CAMPAIGN TOOLS ────────────────────────

export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft", "scheduled", "sending", "sent", "cancelled", "paused",
]);

export const campaignTypeEnum = pgEnum("campaign_type", [
  "one_off", "drip",
]);

export const campaignChannelEnum = pgEnum("campaign_channel", [
  "email", "push",
]);

export const segmentRuleOperatorEnum = pgEnum("segment_rule_operator", [
  "eq", "neq", "gt", "lt", "gte", "lte", "contains", "not_contains", "in", "not_in",
]);

/** Email / push campaign */
export const marketingCampaignsTable = pgTable("marketing_campaigns", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  subject: text("subject"),
  subjectVariantB: text("subject_variant_b"),
  previewText: text("preview_text"),
  bodyHtml: text("body_html").notNull().default(""),
  bodyText: text("body_text"),
  channels: text("channels").array().notNull().default(sql`ARRAY['email']::text[]`),
  status: campaignStatusEnum("status").notNull().default("draft"),
  type: campaignTypeEnum("type").notNull().default("one_off"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  segmentId: integer("segment_id"),
  dripSeriesId: integer("drip_series_id"),
  dripDelayDays: integer("drip_delay_days").notNull().default(0),
  dripOrder: integer("drip_order").notNull().default(0),
  abWinner: text("ab_winner"),
  totalSent: integer("total_sent").notNull().default(0),
  totalOpened: integer("total_opened").notNull().default(0),
  totalClicked: integer("total_clicked").notNull().default(0),
  totalUnsubscribed: integer("total_unsubscribed").notNull().default(0),
  totalBounced: integer("total_bounced").notNull().default(0),
  // Task #1786 — per-campaign push delivery counters. Bumped by
  // `dispatchCampaign` after each `sendPushToUsers` call is classified
  // through `classifyPushDelivery`. Surfaced on the campaign stats page
  // so admins can spot a broken push pipeline (Expo down, all tokens
  // invalid) without trawling logs. Mirrors the email counters above
  // for shape; "no_address" outcomes are intentionally not counted as
  // failures (Task #1070's classification rule).
  totalPushSent: integer("total_push_sent").notNull().default(0),
  totalPushFailed: integer("total_push_failed").notNull().default(0),
  // Task #1555 — when this campaign was built from a saved template
  // in the library, record which one. Lets the dispatcher attach
  // `Metadata.templateId` to every outbound send so the Postmark
  // bounce webhook can attribute suppressions back to the originating
  // template (not just the campaign), and admins can spot a misworded
  // template that's bouncing across multiple campaigns. Forward FK to
  // `email_templates_marketing.id` resolved via the trailing constraint
  // block below because the templates table is declared further down
  // this file.
  templateId: integer("template_id"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("mktg_campaigns_org_idx").on(t.organizationId),
  index("mktg_campaigns_status_idx").on(t.status),
  index("mktg_campaigns_drip_series_idx").on(t.dripSeriesId),
  // Task #1555 — surface "every campaign that used this template"
  // queries. Org-prefixed so we always have an org-scoped seek path.
  index("mktg_campaigns_template_idx").on(t.organizationId, t.templateId),
  // Task #1555 — explicit short FK name. Drizzle's auto-name
  // ("marketing_campaigns_template_id_email_templates_marketing_id_fk")
  // is 67 chars, over Postgres's 63-char identifier limit, so name it
  // explicitly. ON DELETE SET NULL: deleting an old template should
  // not erase historical campaigns that referenced it.
  foreignKey({
    name: "marketing_campaigns_template_id_fk",
    columns: [t.templateId],
    foreignColumns: [emailTemplatesMarketingTable.id],
  }).onDelete("set null"),
]);

/** Drip series (groups a set of drip campaigns into a sequence) */
export const dripSeriesTable = pgTable("drip_series", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  trigger: text("trigger").notNull().default("new_member"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("caddies_org_idx").on(t.organizationId),
  index("drip_series_org_idx").on(t.organizationId),
]);

// Distinct from Task #106's caddieAssignmentsTable (tee-booking assignments).
// This table records caddie assignment to a tournament event for event-day staffing.
export const caddieEventAssignmentsTable = pgTable("caddie_event_assignments", {
  id: serial("id").primaryKey(),
  caddieId: integer("caddie_id").notNull().references(() => caddiesTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  playerName: text("player_name"),
  teeTimeId: integer("tee_time_id").references(() => teeTimesTable.id, { onDelete: "set null" }),
  agreedFee: numeric("agreed_fee", { precision: 10, scale: 2 }),
  feeMode: caddieFeeModeEnum("fee_mode").notNull().default("cash"),
  feePaid: boolean("fee_paid").notNull().default(false),
  feePaidAt: timestamp("fee_paid_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("caddie_event_assignments_caddie_idx").on(t.caddieId),
  index("caddie_event_assignments_tournament_idx").on(t.tournamentId),
  index("caddie_event_assignments_org_idx").on(t.organizationId),
  uniqueIndex("caddie_event_assignments_caddie_tournament_unique").on(t.caddieId, t.tournamentId),
]);

export const volunteerRolesTable = pgTable("volunteer_roles", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  roleType: volunteersRoleTypeEnum("role_type").notNull().default("marshal"),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  maxVolunteers: integer("max_volunteers").notNull().default(1),
  qrToken: text("qr_token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("volunteer_roles_tournament_idx").on(t.tournamentId),
  index("volunteer_roles_org_idx").on(t.organizationId),
]);

export const volunteerAssignmentsTable = pgTable("volunteer_assignments", {
  id: serial("id").primaryKey(),
  roleId: integer("role_id").notNull().references(() => volunteerRolesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("volunteer_assignments_role_idx").on(t.roleId),
  index("volunteer_assignments_tournament_idx").on(t.tournamentId),
  index("volunteer_assignments_org_idx").on(t.organizationId),
]);

export const staffCheckinTypeEnum = pgEnum("staff_checkin_type", ["caddie", "volunteer"]);

export const staffCheckinsTable = pgTable("staff_checkins", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  checkinType: staffCheckinTypeEnum("checkin_type").notNull(),
  caddieAssignmentId: integer("caddie_assignment_id"),
  volunteerAssignmentId: integer("volunteer_assignment_id"),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(),
  checkedInByUserId: integer("checked_in_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  method: text("method").notNull().default("qr"),
  noShow: boolean("no_show").notNull().default(false),
  noShowMarkedAt: timestamp("no_show_marked_at", { withTimezone: true }),
}, (t) => [
  index("staff_checkins_tournament_idx").on(t.tournamentId),
  index("staff_checkins_org_idx").on(t.organizationId),
  foreignKey({ name: "staff_checkins_caddie_assignment_id_fk", columns: [t.caddieAssignmentId], foreignColumns: [caddieEventAssignmentsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "staff_checkins_volunteer_assignment_id_fk", columns: [t.volunteerAssignmentId], foreignColumns: [volunteerAssignmentsTable.id] }).onDelete("cascade"),
]);

/** Member segment — saved dynamic list of recipients */
export const memberSegmentsTable = pgTable("member_segments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /** JSON array of rule objects: { field, operator, value } */
  rules: jsonb("rules").$type<Array<{ field: string; operator: string; value: string | string[] | number }>>().notNull().default([]),
  /** Cached member count — refreshed on save / preview */
  estimatedCount: integer("estimated_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_segments_org_idx").on(t.organizationId),
]);

/** Per-recipient campaign send record + event tracking */
export const campaignRecipientsTable = pgTable("campaign_recipients", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => marketingCampaignsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  email: text("email"),
  name: text("name"),
  /** Which subject variant was sent ("a" or "b") */
  abVariant: text("ab_variant").notNull().default("a"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  clickedAt: timestamp("clicked_at", { withTimezone: true }),
  unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  /** Unique per-recipient tracking token (for open pixel + click links) */
  trackingToken: text("tracking_token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("campaign_recipients_campaign_idx").on(t.campaignId),
  index("campaign_recipients_user_idx").on(t.userId),
  index("campaign_recipients_token_idx").on(t.trackingToken),
]);

/** Global email unsubscribe / suppression list */
export const emailSuppressionsTable = pgTable("email_suppressions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  reason: text("reason").notNull().default("unsubscribed"),
  // Postmark `Type` field for bounce events (e.g. "HardBounce", "BadMailbox",
  // "Blocked", "SpamComplaint"). Null for manual suppressions or non-bounce
  // events. Surfaced in the admin Suppressions tab so admins can tell *why*
  // an address bounced — Task #1138.
  bounceType: text("bounce_type"),
  // Postmark MessageID of the original send that triggered the suppression.
  // Lets admins click through to Postmark for the full delivery log.
  messageId: text("message_id"),
  // Short human-readable description of the suppression reason, e.g.
  // "The recipient's mailbox does not exist" for BadMailbox bounces.
  description: text("description"),
  // Task #1310 — origin of the bouncing send.
  // `triggeredByCampaignId` is set when the bouncing message was a
  // marketing campaign (forwarded as `Metadata.campaignId` on the
  // outbound Postmark request, then read back from the Postmark bounce
  // webhook). Lets the Suppressions tab link straight to the campaign
  // that produced the typo, so admins can fix it at source.
  // ON DELETE SET NULL because deleting an old marketing campaign
  // should not erase the historical suppression row — admins still
  // need to see the bounce.
  triggeredByCampaignId: integer("triggered_by_campaign_id"),
  // `triggeredByFlow` is the short transactional flow name (e.g.
  // "dues_receipt", "tournament_invite", "password_reset") captured
  // from the Postmark `Tag` field or `Metadata.flow` on the original
  // send. Lets admins pinpoint a misconfigured transactional template
  // without scanning logs. Null for manual suppressions and for sends
  // that did not carry any flow tag.
  triggeredByFlow: text("triggered_by_flow"),
  // Task #1555 — when the bouncing message was sent from a campaign
  // built off a saved template (or a transactional send that named
  // the template explicitly), record the template id. Lets the
  // Suppressions tab render a clickable Template badge that opens
  // the template editor so admins can fix the typo at source — one
  // click instead of "find every campaign that used this template".
  // Forwarded as `Metadata.templateId` from the outbound mailer and
  // read back by the Postmark webhook with an org-ownership check
  // (defence in depth — the suppression row is only linked when the
  // claimed template is owned by the resolved org OR is a global
  // template marked `is_global=true`).
  // ON DELETE SET NULL because deleting a template should not erase
  // historical suppressions that referenced it.
  triggeredByTemplateId: integer("triggered_by_template_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("email_suppressions_org_email_idx").on(t.organizationId, t.email),
  uniqueIndex("email_suppressions_unique").on(t.organizationId, t.email),
  index("email_suppressions_triggered_campaign_idx").on(t.organizationId, t.triggeredByCampaignId),
  index("email_suppressions_triggered_flow_idx").on(t.organizationId, t.triggeredByFlow),
  // Task #1555 — same access pattern as the campaign/flow indexes:
  // "show every suppression triggered by template X for org Y".
  index("email_suppressions_triggered_template_idx").on(t.organizationId, t.triggeredByTemplateId),
  // Task #1310 — explicit short FK name to stay under Postgres's 63-char
  // identifier limit (auto-name "email_suppressions_triggered_by_campaign_id_marketing_campaigns_id_fk" is 69 chars).
  foreignKey({
    name: "email_suppressions_triggered_by_campaign_id_fk",
    columns: [t.triggeredByCampaignId],
    foreignColumns: [marketingCampaignsTable.id],
  }).onDelete("set null"),
  // Task #1555 — explicit short FK name (auto-name
  // "email_suppressions_triggered_by_template_id_email_templates_marketing_id_fk"
  // is 76 chars, over the 63-char limit).
  foreignKey({
    name: "email_suppressions_triggered_by_template_id_fk",
    columns: [t.triggeredByTemplateId],
    foreignColumns: [emailTemplatesMarketingTable.id],
  }).onDelete("set null"),
]);

/** Pre-built email template library */
export const emailTemplatesMarketingTable = pgTable("email_templates_marketing", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category").notNull().default("general"),
  bodyHtml: text("body_html").notNull(),
  bodyText: text("body_text"),
  isGlobal: boolean("is_global").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("email_templates_mktg_org_idx").on(t.organizationId),
]);

export type Caddie = typeof caddiesTable.$inferSelect;
export type CaddieEventAssignment = typeof caddieEventAssignmentsTable.$inferSelect;
export type VolunteerRole = typeof volunteerRolesTable.$inferSelect;
export type VolunteerAssignment = typeof volunteerAssignmentsTable.$inferSelect;
export type StaffCheckin = typeof staffCheckinsTable.$inferSelect;
export type MarketingCampaign = typeof marketingCampaignsTable.$inferSelect;
export type DripSeries = typeof dripSeriesTable.$inferSelect;
export type MemberSegment = typeof memberSegmentsTable.$inferSelect;
export type CampaignRecipient = typeof campaignRecipientsTable.$inferSelect;
export type EmailSuppression = typeof emailSuppressionsTable.$inferSelect;
export type EmailTemplateMarketing = typeof emailTemplatesMarketingTable.$inferSelect;

// ─── VENDOR OPERATOR PRO SHOP MANAGEMENT (Task #119) ─────────────────────────

export const vendorBillingModelEnum = pgEnum("vendor_billing_model", [
  "fixed", "revenue_share", "hybrid",
]);

export const vendorBillingFrequencyEnum = pgEnum("vendor_billing_frequency", [
  "monthly", "annual",
]);

export const vendorContractStatusEnum = pgEnum("vendor_contract_status", [
  "active", "expired", "terminated", "draft",
]);

export const vendorInvoiceStatusEnum = pgEnum("vendor_invoice_status", [
  "unpaid", "paid", "overdue", "cancelled",
]);

export const vendorFacilityTypeEnum = pgEnum("vendor_facility_type", [
  "pro_shop", "f_and_b", "driving_range", "other",
]);

/** A third-party vendor operator who leases a facility at the club */
export const vendorOperatorsTable = pgTable("vendor_operators", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  address: text("address"),
  gstin: text("gstin"),
  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankIfsc: text("bank_ifsc"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("vendor_operators_org_idx").on(t.organizationId),
]);

/** Assignment of a vendor operator to a specific facility */
export const vendorFacilityAssignmentsTable = pgTable("vendor_facility_assignments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  vendorOperatorId: integer("vendor_operator_id").notNull(),
  facilityType: vendorFacilityTypeEnum("facility_type").notNull().default("pro_shop"),
  facilityName: text("facility_name"),
  isActive: boolean("is_active").notNull().default(true),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  unassignedAt: timestamp("unassigned_at", { withTimezone: true }),
}, (t) => [
  index("vendor_facility_assignments_org_idx").on(t.organizationId),
  index("vendor_facility_assignments_vendor_idx").on(t.vendorOperatorId),
  foreignKey({ name: "vendor_facility_assignments_vendor_operator_id_fk", columns: [t.vendorOperatorId], foreignColumns: [vendorOperatorsTable.id] }).onDelete("cascade"),
]);

/** A vendor contract capturing all billing terms */
export const vendorContractsTable = pgTable("vendor_contracts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  vendorOperatorId: integer("vendor_operator_id").notNull().references(() => vendorOperatorsTable.id, { onDelete: "cascade" }),
  /** Link to the contract this one replaces (for renewal history) */
  previousContractId: integer("previous_contract_id"),
  billingModel: vendorBillingModelEnum("billing_model").notNull().default("fixed"),
  fixedFeeAmount: numeric("fixed_fee_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  revenueSharePct: numeric("revenue_share_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  /** For hybrid: revenue share applies above this gross sales threshold per period */
  revenueShareThreshold: numeric("revenue_share_threshold", { precision: 12, scale: 2 }),
  billingFrequency: vendorBillingFrequencyEnum("billing_frequency").notNull().default("monthly"),
  contractStartDate: timestamp("contract_start_date", { withTimezone: true }).notNull(),
  contractEndDate: timestamp("contract_end_date", { withTimezone: true }),
  noticePeriodDays: integer("notice_period_days").notNull().default(30),
  autoRenewal: boolean("auto_renewal").notNull().default(false),
  status: vendorContractStatusEnum("status").notNull().default("active"),
  terminationReason: text("termination_reason"),
  terminatedAt: timestamp("terminated_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("vendor_contracts_org_idx").on(t.organizationId),
  index("vendor_contracts_vendor_idx").on(t.vendorOperatorId),
]);

/** A billing period record for a vendor */
export const vendorBillingCyclesTable = pgTable("vendor_billing_cycles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  vendorOperatorId: integer("vendor_operator_id").notNull().references(() => vendorOperatorsTable.id, { onDelete: "cascade" }),
  vendorContractId: integer("vendor_contract_id").notNull().references(() => vendorContractsTable.id, { onDelete: "restrict" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  grossSales: numeric("gross_sales", { precision: 12, scale: 2 }).notNull().default("0"),
  memberChargesTotal: numeric("member_charges_total", { precision: 12, scale: 2 }).notNull().default("0"),
  revenueShareAmount: numeric("revenue_share_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  fixedFeeAmount: numeric("fixed_fee_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  netAmountDue: numeric("net_amount_due", { precision: 12, scale: 2 }).notNull().default("0"),
  currency: text("currency").notNull().default("INR"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("vendor_billing_cycles_org_idx").on(t.organizationId),
  index("vendor_billing_cycles_vendor_idx").on(t.vendorOperatorId),
]);

/** Invoice sent to vendor for a billing cycle */
export const vendorInvoicesTable = pgTable("vendor_invoices", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  vendorOperatorId: integer("vendor_operator_id").notNull().references(() => vendorOperatorsTable.id, { onDelete: "cascade" }),
  vendorBillingCycleId: integer("vendor_billing_cycle_id"),
  invoiceNumber: text("invoice_number").notNull(),
  status: vendorInvoiceStatusEnum("status").notNull().default("unpaid"),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  paymentMethod: text("payment_method"),
  paymentReference: text("payment_reference"),
  razorpayPaymentLinkId: text("razorpay_payment_link_id"),
  razorpayPaymentLinkUrl: text("razorpay_payment_link_url"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  notes: text("notes"),
  lineItems: jsonb("line_items").$type<Array<{
    description: string;
    amount: number;
  }>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("vendor_invoices_org_idx").on(t.organizationId),
  index("vendor_invoices_vendor_idx").on(t.vendorOperatorId),
  uniqueIndex("vendor_invoices_invoice_number_org_unique").on(t.organizationId, t.invoiceNumber),
  foreignKey({ name: "vendor_invoices_vendor_billing_cycle_id_fk", columns: [t.vendorBillingCycleId], foreignColumns: [vendorBillingCyclesTable.id] }).onDelete("set null"),
]);

/** Renewal / expiry alert events for vendor contracts */
export const vendorContractAlertsTable = pgTable("vendor_contract_alerts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  vendorContractId: integer("vendor_contract_id").notNull(),
  alertType: text("alert_type").notNull(),
  daysBeforeExpiry: integer("days_before_expiry"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("vendor_contract_alerts_contract_idx").on(t.vendorContractId),
  foreignKey({ name: "vendor_contract_alerts_vendor_contract_id_fk", columns: [t.vendorContractId], foreignColumns: [vendorContractsTable.id] }).onDelete("cascade"),
]);

export type VendorOperator = typeof vendorOperatorsTable.$inferSelect;
export type VendorFacilityAssignment = typeof vendorFacilityAssignmentsTable.$inferSelect;
export type VendorContract = typeof vendorContractsTable.$inferSelect;
export type VendorBillingCycle = typeof vendorBillingCyclesTable.$inferSelect;
export type VendorInvoice = typeof vendorInvoicesTable.$inferSelect;
export type VendorContractAlert = typeof vendorContractAlertsTable.$inferSelect;

// ─── GST INVOICE SEQUENCES ────────────────────────────────────────────────────

/**
 * Sequential invoice counters per org and channel.
 * Thread-safe via SELECT FOR UPDATE in the generation function.
 */
export const invoiceSequencesTable = pgTable("invoice_sequences", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  prefix: text("prefix").notNull().default("INV"),
  lastSeq: integer("last_seq").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("invoice_sequences_org_channel_unique").on(t.organizationId, t.channel),
]);

// ─── GST INVOICES ─────────────────────────────────────────────────────────────

export const gstInvoiceChannelEnum = pgEnum("gst_invoice_channel", [
  "shop", "pos", "tournament", "league",
]);

export const gstInvoiceRoutingEnum = pgEnum("gst_invoice_routing", [
  "cgst_sgst", "igst", "zero_rated",
]);

/**
 * Unified GST-compliant invoice record for shop orders, POS transactions,
 * tournament entry fees, and league entry fees.
 */
export const gstInvoicesTable = pgTable("gst_invoices", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  invoiceNumber: text("invoice_number").notNull(),
  channel: gstInvoiceChannelEnum("channel").notNull(),

  shopOrderId: integer("shop_order_id").references(() => shopOrdersTable.id, { onDelete: "set null" }),
  posTransactionId: integer("pos_transaction_id").references(() => posTransactionsTable.id, { onDelete: "set null" }),
  tournamentPlayerId: integer("tournament_player_id").references(() => playersTable.id, { onDelete: "set null" }),
  leagueMemberId: integer("league_member_id").references(() => leagueMembersTable.id, { onDelete: "set null" }),

  buyerName: text("buyer_name").notNull(),
  buyerEmail: text("buyer_email"),
  buyerGstin: text("buyer_gstin"),
  buyerAddress: text("buyer_address"),
  buyerState: text("buyer_state"),
  buyerStateCode: text("buyer_state_code"),
  buyerCountry: text("buyer_country").notNull().default("IN"),

  sellerGstin: text("seller_gstin"),
  sellerName: text("seller_name"),
  sellerAddress: text("seller_address"),
  sellerState: text("seller_state"),
  sellerStateCode: text("seller_state_code"),

  lineItems: jsonb("line_items").notNull().$type<Array<{
    description: string;
    hsnSacCode?: string;
    quantity: number;
    unitPrice: number;
    taxableValue: number;
    gstRate: number;
    cgst?: number;
    sgst?: number;
    igst?: number;
    lineTotal: number;
  }>>(),

  taxableAmount: numeric("taxable_amount", { precision: 12, scale: 2 }).notNull(),
  cgstAmount: numeric("cgst_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  sgstAmount: numeric("sgst_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  igstAmount: numeric("igst_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),

  gstRouting: gstInvoiceRoutingEnum("gst_routing").notNull().default("igst"),
  stateOfSupply: text("state_of_supply"),
  lut: text("lut"),

  status: text("status").notNull().default("issued"),
  pdfPath: text("pdf_path"),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),

  invoiceDate: timestamp("invoice_date", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("gst_invoices_number_org_unique").on(t.organizationId, t.invoiceNumber),
  index("gst_invoices_org_idx").on(t.organizationId),
  index("gst_invoices_channel_idx").on(t.channel),
  uniqueIndex("gst_invoices_shop_order_unique").on(t.organizationId, t.shopOrderId).where(sql`${t.shopOrderId} IS NOT NULL`),
  uniqueIndex("gst_invoices_pos_txn_unique").on(t.organizationId, t.posTransactionId).where(sql`${t.posTransactionId} IS NOT NULL`),
  uniqueIndex("gst_invoices_tournament_player_unique").on(t.organizationId, t.tournamentPlayerId).where(sql`${t.tournamentPlayerId} IS NOT NULL`),
  uniqueIndex("gst_invoices_league_member_unique").on(t.organizationId, t.leagueMemberId).where(sql`${t.leagueMemberId} IS NOT NULL`),
]);

export type GstInvoice = typeof gstInvoicesTable.$inferSelect;
export type InvoiceSequence = typeof invoiceSequencesTable.$inferSelect;

// ─── TASK #133: INVENTORY, MULTI-LOCATION STOCK & BARCODE SCANNING ────────────

/** Physical stock locations within a club (e.g. Pro Shop, Halfway House, Driving Range Kiosk) */
export const shopLocationsTable = pgTable("shop_locations", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull().default("pro_shop"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_locations_org_idx").on(t.organizationId),
]);

/** Per-location stock level for each product variant */
export const shopVariantStockTable = pgTable("shop_variant_stock", {
  id: serial("id").primaryKey(),
  variantId: integer("variant_id").notNull().references(() => shopProductVariantsTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").notNull().references(() => shopLocationsTable.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(0),
  reorderPoint: integer("reorder_point"),
  reorderQty: integer("reorder_qty"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("shop_variant_stock_unique").on(t.variantId, t.locationId),
  index("shop_variant_stock_location_idx").on(t.locationId),
]);

/** Audit log of all stock changes (sales, receipts, manual adjustments, transfers) */
export const shopStockAdjustmentsTable = pgTable("shop_stock_adjustments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").notNull().references(() => shopProductVariantsTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").references(() => shopLocationsTable.id, { onDelete: "set null" }),
  qtyDelta: integer("qty_delta").notNull(),
  type: text("type").notNull(),
  reason: text("reason"),
  referenceId: text("reference_id"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_stock_adj_org_idx").on(t.organizationId),
  index("shop_stock_adj_variant_idx").on(t.variantId),
]);

/** Stock transfers between locations */
export const shopStockTransfersTable = pgTable("shop_stock_transfers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  fromLocationId: integer("from_location_id").notNull().references(() => shopLocationsTable.id, { onDelete: "restrict" }),
  toLocationId: integer("to_location_id").notNull().references(() => shopLocationsTable.id, { onDelete: "restrict" }),
  variantId: integer("variant_id").notNull().references(() => shopProductVariantsTable.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull(),
  notes: text("notes"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_stock_transfers_org_idx").on(t.organizationId),
]);

/** A stocktake (inventory count) session per location */
export const shopStocktakeSessionsTable = pgTable("shop_stocktake_sessions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  locationId: integer("location_id").notNull().references(() => shopLocationsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("open"),
  notes: text("notes"),
  startedByUserId: integer("started_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_stocktake_sessions_org_idx").on(t.organizationId),
]);

/** Items scanned/counted during a stocktake session */
export const shopStocktakeItemsTable = pgTable("shop_stocktake_items", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => shopStocktakeSessionsTable.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").notNull().references(() => shopProductVariantsTable.id, { onDelete: "cascade" }),
  expectedQty: integer("expected_qty").notNull().default(0),
  countedQty: integer("counted_qty").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("shop_stocktake_items_unique").on(t.sessionId, t.variantId),
  index("shop_stocktake_items_session_idx").on(t.sessionId),
]);

export type ShopLocation = typeof shopLocationsTable.$inferSelect;
export type ShopVariantStock = typeof shopVariantStockTable.$inferSelect;
export type ShopStockAdjustment = typeof shopStockAdjustmentsTable.$inferSelect;
export type ShopStockTransfer = typeof shopStockTransfersTable.$inferSelect;
export type ShopStocktakeSession = typeof shopStocktakeSessionsTable.$inferSelect;
export type ShopStocktakeItem = typeof shopStocktakeItemsTable.$inferSelect;

// ─── TASK #131: PROMOTIONS, DISCOUNTS & AFFILIATE ENGINE ───────────────────────

export const promotionTypeEnum = pgEnum("promotion_type", [
  "percentage",   // Percentage off order/item
  "fixed",        // Fixed amount off
]);

export const promotionScopeEnum = pgEnum("promotion_scope", [
  "all",          // All products
  "category",     // Specific category
  "product",      // Specific product IDs
]);

/** Promo / coupon codes created by admins */
export const promotionsTable = pgTable("promotions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  description: text("description"),
  discountType: promotionTypeEnum("discount_type").notNull().default("percentage"),
  discountValue: numeric("discount_value", { precision: 10, scale: 2 }).notNull(),
  minOrderValue: numeric("min_order_value", { precision: 10, scale: 2 }).notNull().default("0"),
  /** null = unlimited uses */
  usageLimit: integer("usage_limit"),
  usedCount: integer("used_count").notNull().default(0),
  /** null = all categories/products */
  scope: promotionScopeEnum("scope").notNull().default("all"),
  /** JSON array of category strings or product IDs depending on scope */
  scopeValues: jsonb("scope_values").$type<string[]>(),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  /** Is this a single-use code (one use per user) */
  singleUsePerUser: boolean("single_use_per_user").notNull().default(false),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("promotions_org_code_unique").on(t.organizationId, t.code),
  index("promotions_org_idx").on(t.organizationId),
]);

/** Tracks each use of a promo code */
export const promotionRedemptionsTable = pgTable("promotion_redemptions", {
  id: serial("id").primaryKey(),
  promotionId: integer("promotion_id").notNull().references(() => promotionsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  orderId: integer("order_id").references(() => shopOrdersTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("promo_redemptions_promo_idx").on(t.promotionId),
  index("promo_redemptions_org_idx").on(t.organizationId),
  uniqueIndex("promo_redemptions_promo_order_unique").on(t.promotionId, t.orderId),
]);

/** Affiliate / referral codes for tracking referrals and commissions */
export const affiliateCodesTable = pgTable("affiliate_codes", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  description: text("description"),
  /** User who owns this affiliate code (member or external affiliate) */
  ownerUserId: integer("owner_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  ownerName: text("owner_name"),
  ownerEmail: text("owner_email"),
  /** Commission type paid to the affiliate */
  commissionType: promotionTypeEnum("commission_type").notNull().default("percentage"),
  commissionValue: numeric("commission_value", { precision: 10, scale: 2 }).notNull().default("0"),
  /** Discount given to the buyer (percentage or fixed) */
  buyerDiscountType: promotionTypeEnum("buyer_discount_type").notNull().default("percentage"),
  buyerDiscountValue: numeric("buyer_discount_value", { precision: 10, scale: 2 }).notNull().default("0"),
  totalOrders: integer("total_orders").notNull().default(0),
  totalDiscountGiven: numeric("total_discount_given", { precision: 12, scale: 2 }).notNull().default("0"),
  totalCommissionEarned: numeric("total_commission_earned", { precision: 12, scale: 2 }).notNull().default("0"),
  isActive: boolean("is_active").notNull().default(true),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("affiliate_codes_org_code_unique").on(t.organizationId, t.code),
  index("affiliate_codes_org_idx").on(t.organizationId),
  index("affiliate_codes_owner_idx").on(t.ownerUserId),
]);

/** Tracks each use of an affiliate code (order-level) */
export const affiliateRedemptionsTable = pgTable("affiliate_redemptions", {
  id: serial("id").primaryKey(),
  affiliateCodeId: integer("affiliate_code_id").notNull().references(() => affiliateCodesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  orderId: integer("order_id").references(() => shopOrdersTable.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  orderAmount: numeric("order_amount", { precision: 10, scale: 2 }).notNull(),
  discountAmount: numeric("discount_amount", { precision: 10, scale: 2 }).notNull(),
  commissionAmount: numeric("commission_amount", { precision: 10, scale: 2 }).notNull(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("affiliate_redemptions_code_idx").on(t.affiliateCodeId),
  index("affiliate_redemptions_org_idx").on(t.organizationId),
  uniqueIndex("affiliate_redemptions_code_order_unique").on(t.affiliateCodeId, t.orderId),
]);

/** Bundle deals: "Buy A+B, get X% off" or "Buy N from category Z, get cheapest free" */
export const bundleDealsTable = pgTable("bundle_deals", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /**
   * "multi_product": buy specific product IDs together → get discount
   * "category_quantity": buy N items from category → get cheapest free or % off
   */
  dealType: text("deal_type").notNull().default("multi_product"),
  /** For multi_product: list of required product IDs */
  requiredProductIds: jsonb("required_product_ids").$type<number[]>(),
  /** For category_quantity: category name */
  targetCategory: text("target_category"),
  /** For category_quantity: minimum quantity needed */
  minQuantity: integer("min_quantity").notNull().default(2),
  /** Discount type applied when bundle condition is met */
  discountType: promotionTypeEnum("discount_type").notNull().default("percentage"),
  /** Discount value; ignored when dealType is category_quantity + freeItem */
  discountValue: numeric("discount_value", { precision: 10, scale: 2 }).notNull().default("0"),
  /** If true, cheapest item in bundle becomes free (overrides discountValue) */
  cheapestItemFree: boolean("cheapest_item_free").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  validFrom: timestamp("valid_from", { withTimezone: true }),
  validTo: timestamp("valid_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("bundle_deals_org_idx").on(t.organizationId),
]);

export type Promotion = typeof promotionsTable.$inferSelect;
export type PromotionRedemption = typeof promotionRedemptionsTable.$inferSelect;
export type AffiliateCode = typeof affiliateCodesTable.$inferSelect;
export type AffiliateRedemption = typeof affiliateRedemptionsTable.$inferSelect;
export type BundleDeal = typeof bundleDealsTable.$inferSelect;

// ─── TASK #139: TOURNAMENT MERCHANDISE ────────────────────────────────────────
/** Links specific shop products to a tournament as "event merchandise" */
export const tournamentMerchandiseTable = pgTable("tournament_merchandise", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "cascade" }),
  displayOrder: integer("display_order").notNull().default(0),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tournament_merchandise_tournament_product_unique").on(t.tournamentId, t.productId),
  index("tournament_merchandise_tournament_idx").on(t.tournamentId),
]);

export type TournamentMerchandise = typeof tournamentMerchandiseTable.$inferSelect;

// ─── TASK #139: PRODUCT WAITLIST ──────────────────────────────────────────────
/** Members who want to be notified when an out-of-stock variant is restocked */
export const productWaitlistTable = pgTable("product_waitlist", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").references(() => shopProductVariantsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  email: text("email").notNull(),
  name: text("name"),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("product_waitlist_variant_user_unique").on(t.organizationId, t.variantId, t.userId),
  index("product_waitlist_product_idx").on(t.productId),
  index("product_waitlist_variant_idx").on(t.variantId),
]);

export type ProductWaitlist = typeof productWaitlistTable.$inferSelect;

// ─── TASK #139: PRODUCT BUNDLES ───────────────────────────────────────────────
/** A bundle SKU sold as one item (e.g. "Tournament Package: Entry + Shirt + Cart") */
export const shopBundlesTable = pgTable("shop_bundles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  sku: text("sku"),
  imageUrl: text("image_url"),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_bundles_org_idx").on(t.organizationId),
]);

/** Individual component variants within a bundle */
export const shopBundleComponentsTable = pgTable("shop_bundle_components", {
  id: serial("id").primaryKey(),
  bundleId: integer("bundle_id").notNull().references(() => shopBundlesTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => shopProductsTable.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").references(() => shopProductVariantsTable.id, { onDelete: "set null" }),
  quantity: integer("quantity").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("shop_bundle_components_bundle_idx").on(t.bundleId),
]);

export type ShopBundle = typeof shopBundlesTable.$inferSelect;
export type ShopBundleComponent = typeof shopBundleComponentsTable.$inferSelect;

// ─── TASK #149: OUTBOUND WEBHOOKS ─────────────────────────────────────────────

export const webhookEndpointsTable = pgTable("webhook_endpoints", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  subscribedEvents: text("subscribed_events").array().notNull().default(sql`'{}'::text[]`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("webhook_endpoints_org_idx").on(t.organizationId),
]);

export const webhookDeliveryLogTable = pgTable("webhook_delivery_log", {
  id: serial("id").primaryKey(),
  endpointId: integer("endpoint_id").notNull().references(() => webhookEndpointsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  statusCode: integer("status_code"),
  responseTimeMs: integer("response_time_ms"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("webhook_delivery_log_endpoint_idx").on(t.endpointId),
  index("webhook_delivery_log_event_idx").on(t.eventType),
]);

export type WebhookEndpoint = typeof webhookEndpointsTable.$inferSelect;
export type WebhookDeliveryLog = typeof webhookDeliveryLogTable.$inferSelect;

// ─── TASK #147: DOCUMENT LIBRARY ──────────────────────────────────────────────
/** Operational document library — local rules, pace-of-play, policy docs, etc.
 *  Separate from the governance clubDocumentsTable (constitution, minutes, bylaws).
 */
export const operationalDocumentsTable = pgTable("operational_documents", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  category: text("category").notNull().default("general"),
  objectPath: text("object_path").notNull(),
  filename: text("filename"),
  contentType: text("content_type"),
  fileSize: integer("file_size"),
  visibility: text("visibility").notNull().default("public"),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("operational_documents_org_idx").on(t.organizationId),
]);

export type OperationalDocument = typeof operationalDocumentsTable.$inferSelect;

/** Junction table linking operational documents to events (tournaments or leagues) */
export const eventDocumentsTable = pgTable("event_documents", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => operationalDocumentsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  eventId: integer("event_id").notNull(),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("event_documents_doc_event_unique").on(t.documentId, t.eventType, t.eventId),
  index("event_documents_event_idx").on(t.eventType, t.eventId),
]);

export type EventDocument = typeof eventDocumentsTable.$inferSelect;

// ─── TASK #148: SAVED REPORTS ─────────────────────────────────────────────────

export const savedReportsTable = pgTable("saved_reports", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  dataSource: text("data_source").notNull(),
  columns: jsonb("columns").$type<{ key: string; label: string }[]>().notNull().default([]),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull().default({}),
  sortConfig: jsonb("sort_config").$type<{ column: string; direction: "asc" | "desc" } | null>(),
  isTemplate: boolean("is_template").notNull().default(false),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("saved_reports_org_idx").on(t.organizationId),
]);

export type SavedReport = typeof savedReportsTable.$inferSelect;
export type NewSavedReport = typeof savedReportsTable.$inferInsert;

// ─── TASK #142: CUSTOM REGISTRATION FORMS & POST-EVENT SURVEYS ────────────────

export const registrationFormFieldTypeEnum = pgEnum("reg_form_field_type", [
  "short_text",
  "long_text",
  "dropdown",
  "checkbox",
  "file_upload",
  "terms_acceptance",
]);

export const registrationFormEventTypeEnum = pgEnum("reg_form_event_type", [
  "tournament",
  "league",
]);

/** Custom fields added by admin to tournament/league registration */
export const registrationFormFieldsTable = pgTable("registration_form_fields", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  eventId: integer("event_id").notNull(),
  eventType: registrationFormEventTypeEnum("event_type").notNull(),
  fieldType: registrationFormFieldTypeEnum("field_type").notNull(),
  label: text("label").notNull(),
  placeholder: text("placeholder"),
  helpText: text("help_text"),
  /** JSON array of option strings for dropdown/checkbox-group fields */
  options: jsonb("options").$type<string[]>(),
  required: boolean("required").notNull().default(false),
  /** Field id that must be checked/selected for this field to appear (conditional show) */
  conditionalOnFieldId: integer("conditional_on_field_id"),
  /** Value the conditional field must equal to trigger visibility */
  conditionalOnValue: text("conditional_on_value"),
  /** Terms text for terms_acceptance fields */
  termsText: text("terms_text"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("reg_form_fields_event_idx").on(t.eventId, t.eventType),
  index("reg_form_fields_org_idx").on(t.organizationId),
]);

/** Answers submitted by players at registration time */
export const registrationFormResponsesTable = pgTable("registration_form_responses", {
  id: serial("id").primaryKey(),
  fieldId: integer("field_id").notNull(),
  /** For tournaments: player id; for leagues: league_member id */
  entryId: integer("entry_id").notNull(),
  eventType: registrationFormEventTypeEnum("event_type").notNull(),
  /** Stored as text; file uploads store the URL */
  value: text("value"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("reg_form_responses_field_idx").on(t.fieldId),
  index("reg_form_responses_entry_idx").on(t.entryId, t.eventType),
  uniqueIndex("reg_form_responses_unique").on(t.fieldId, t.entryId, t.eventType),
  foreignKey({ name: "registration_form_responses_field_id_fk", columns: [t.fieldId], foreignColumns: [registrationFormFieldsTable.id] }).onDelete("cascade"),
]);

/** Post-event survey configuration per event */
export const eventSurveyFormsTable = pgTable("event_survey_forms", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  eventId: integer("event_id").notNull(),
  eventType: registrationFormEventTypeEnum("event_type").notNull(),
  title: text("title").notNull().default("Post-Event Survey"),
  description: text("description"),
  /** Hours after event completion to send the survey (0 = immediate) */
  sendDelayHours: integer("send_delay_hours").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  /** Tracks whether survey emails have been enqueued */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("event_survey_forms_event_unique").on(t.eventId, t.eventType),
  index("event_survey_forms_org_idx").on(t.organizationId),
]);

/** Fields/questions within a post-event survey (same field types as registration form) */
export const eventSurveyFieldsTable = pgTable("event_survey_fields", {
  id: serial("id").primaryKey(),
  surveyId: integer("survey_id").notNull().references(() => eventSurveyFormsTable.id, { onDelete: "cascade" }),
  fieldType: registrationFormFieldTypeEnum("field_type").notNull(),
  label: text("label").notNull(),
  placeholder: text("placeholder"),
  helpText: text("help_text"),
  options: jsonb("options").$type<string[]>(),
  required: boolean("required").notNull().default(false),
  termsText: text("terms_text"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("event_survey_fields_survey_idx").on(t.surveyId),
]);

/** One row per respondent per survey; token is used as the unique URL param */
export const eventSurveyRespondentsTable = pgTable("event_survey_respondents", {
  id: serial("id").primaryKey(),
  surveyId: integer("survey_id").notNull().references(() => eventSurveyFormsTable.id, { onDelete: "cascade" }),
  /** For tournaments: player id; for leagues: league_member id */
  entryId: integer("entry_id").notNull(),
  eventType: registrationFormEventTypeEnum("event_type").notNull(),
  respondentName: text("respondent_name"),
  respondentEmail: text("respondent_email"),
  /** UUID used in the survey response URL (no login needed) */
  token: text("token").notNull(),
  emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("event_survey_respondents_token_unique").on(t.token),
  uniqueIndex("event_survey_respondents_unique").on(t.surveyId, t.entryId, t.eventType),
  index("event_survey_respondents_survey_idx").on(t.surveyId),
]);

/** Individual answer values per respondent per survey field */
export const eventSurveyResponseItemsTable = pgTable("event_survey_response_items", {
  id: serial("id").primaryKey(),
  respondentId: integer("respondent_id").notNull(),
  fieldId: integer("field_id").notNull().references(() => eventSurveyFieldsTable.id, { onDelete: "cascade" }),
  value: text("value"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("event_survey_response_items_respondent_idx").on(t.respondentId),
  uniqueIndex("event_survey_response_items_unique").on(t.respondentId, t.fieldId),
  foreignKey({ name: "event_survey_response_items_respondent_id_fk", columns: [t.respondentId], foreignColumns: [eventSurveyRespondentsTable.id] }).onDelete("cascade"),
]);

export type RegistrationFormField = typeof registrationFormFieldsTable.$inferSelect;
export type RegistrationFormResponse = typeof registrationFormResponsesTable.$inferSelect;
export type EventSurveyForm = typeof eventSurveyFormsTable.$inferSelect;
export type EventSurveyField = typeof eventSurveyFieldsTable.$inferSelect;
export type EventSurveyRespondent = typeof eventSurveyRespondentsTable.$inferSelect;
export type EventSurveyResponseItem = typeof eventSurveyResponseItemsTable.$inferSelect;

// ─── TASK #145: AUTOMATION RULES ─────────────────────────────────────────────

export const automationRulesTable = pgTable("automation_rules", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(),
  triggerParams: jsonb("trigger_params").$type<{ value?: number; unit?: "days" | "hours" }>(),
  channel: text("channel").notNull().default("email"),
  audienceFilter: jsonb("audience_filter").$type<{ type: "all_registrants" | "unpaid_registrants" | "specific_flight" | "all_members"; flightId?: number }>(),
  subject: text("subject"),
  body: text("body").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("automation_rules_org_idx").on(t.orgId),
  index("automation_rules_tournament_idx").on(t.tournamentId),
  index("automation_rules_league_idx").on(t.leagueId),
]);

export const automationRuleLogsTable = pgTable("automation_rule_logs", {
  id: serial("id").primaryKey(),
  ruleId: integer("rule_id").notNull().references(() => automationRulesTable.id, { onDelete: "cascade" }),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  audienceSize: integer("audience_size").notNull().default(0),
  deliveredCount: integer("delivered_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  status: text("status").notNull().default("completed"),
  errorMessage: text("error_message"),
}, (t) => [
  index("automation_rule_logs_rule_idx").on(t.ruleId),
]);

export type AutomationRule = typeof automationRulesTable.$inferSelect;
export type AutomationRuleLog = typeof automationRuleLogsTable.$inferSelect;

// CLUB CARRY DISTANCES — manual carry distance overrides per user per club
export const clubCarryDistancesTable = pgTable("club_carry_distances", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  club: text("club").notNull(),
  carryYards: integer("carry_yards").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("club_carry_distances_user_club_unique").on(t.userId, t.club),
]);

export type ClubCarryDistance = typeof clubCarryDistancesTable.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// AI CADDIE RECOMMENDATIONS (Task #356)
// Records each recommendation event for personalisation feedback.
// ═══════════════════════════════════════════════════════════════════════════
export const caddieRecommendationsTable = pgTable("caddie_recommendations", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  generalPlayRoundId: integer("general_play_round_id"),
  round: integer("round").notNull().default(1),
  holeNumber: integer("hole_number").notNull(),
  distanceYards: numeric("distance_yards", { precision: 8, scale: 1 }).notNull(),
  effectiveYards: numeric("effective_yards", { precision: 8, scale: 1 }),
  windSpeed: numeric("wind_speed", { precision: 6, scale: 2 }),
  windDirection: numeric("wind_direction", { precision: 6, scale: 2 }),
  windBearing: numeric("wind_bearing", { precision: 6, scale: 2 }),
  // Task #1167 — observed temperature in °C at the course at the moment of
  // the recommendation. Captured server-side from getWeather() (15-min
  // cached) so /portal/player/weather-correlation has a fresh per-round
  // temperature source even when the Open-Meteo archive lags by several
  // days. Nullable when course coords are missing or the weather fetch
  // fails — the correlation endpoint still falls back to the archive.
  temperature: numeric("temperature", { precision: 5, scale: 2 }),
  // Task #1347 — observed humidity (% relative, 0-100) and precipitation
  // (mm in the last hour) at the course at recommendation time. Captured
  // from the same getWeather() call that populates `temperature` so the
  // weather-correlation endpoint can bucket recent rounds by muggy /
  // rainy conditions in addition to wind & temperature. Nullable for the
  // same reasons as `temperature`.
  humidity: numeric("humidity", { precision: 5, scale: 2 }),
  precipitation: numeric("precipitation", { precision: 6, scale: 2 }),
  recommendedClub: text("recommended_club"),
  alternateClub: text("alternate_club"),
  rankedClubs: jsonb("ranked_clubs"),
  rationale: jsonb("rationale"),
  aimLatOffset: numeric("aim_lat_offset", { precision: 12, scale: 9 }),
  aimLngOffset: numeric("aim_lng_offset", { precision: 12, scale: 9 }),
  lateralStddevYards: numeric("lateral_stddev_yards", { precision: 6, scale: 2 }),
  usingFallback: boolean("using_fallback").notNull().default(false),
  // Task #488 — preserve the inputs that the recommendation engine adjusted for
  // so we can audit suggestions and slice acceptance/outcome stats by lie.
  elevationDeltaYards: numeric("elevation_delta_yards", { precision: 6, scale: 1 }),
  lieType: text("lie_type"),
  chosenClub: text("chosen_club"),
  accepted: boolean("accepted"),
  outcomeStrokes: integer("outcome_strokes"),
  outcomeDistanceToPin: numeric("outcome_distance_to_pin", { precision: 8, scale: 1 }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => [
  index("caddie_recommendations_user_idx").on(t.userId, t.recordedAt),
  index("caddie_recommendations_player_idx").on(t.playerId, t.tournamentId, t.round, t.holeNumber),
  index("caddie_recommendations_gp_idx").on(t.userId, t.generalPlayRoundId, t.holeNumber),
  foreignKey({ name: "caddie_recommendations_general_play_round_id_fk", columns: [t.generalPlayRoundId], foreignColumns: [generalPlayRoundsTable.id] }).onDelete("cascade"),
]);

export type CaddieRecommendation = typeof caddieRecommendationsTable.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// ROUND WEATHER CACHE (Task #1346)
// Persistent per-round historical-weather snapshot. Backfilled by the
// `backfill:round-weather-cache` script, which iterates tournament and
// general-play rounds in the trailing window, calls `getHistoricalWeather()`
// for each (course, date) and writes the resulting daily mean here so
// `computeWeatherCorrelation` can populate the Stats > Shot Analytics
// temperature chart for older rounds without re-hammering Open-Meteo's
// archive on every request.
//
// Why this is a separate table (not a synthetic caddie_recommendations row):
//   * Many older rounds have NO caddie recommendations at all (e.g. casual
//     general-play where the player never opened the caddie); we still want
//     them on the chart.
//   * Manufacturing a `caddie_recommendations` row would pollute the
//     recommendation audit/aggregation queries with rows that never
//     represented an actual recommendation.
//
// One row per (tournament_id|general_play_round_id, round). The two
// partial unique indexes prevent duplicates per round while letting
// either FK be NULL.
// ═══════════════════════════════════════════════════════════════════════════
export const roundWeatherCacheTable = pgTable("round_weather_cache", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  // FK with an explicit short name — the auto-generated name (table_col_table_id_fk)
  // would exceed Postgres's 63-char identifier limit (Task #805).
  generalPlayRoundId: integer("general_play_round_id"),
  round: integer("round").notNull().default(1),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "set null" }),
  // YYYY-MM-DD as resolved by the backfill (UTC) — kept for traceability.
  observedDate: text("observed_date").notNull(),
  // Daily mean temperature in °C from the Open-Meteo archive. Nullable
  // because the archive may have no observation yet (5-day delay) or no
  // record for the location at all.
  temperatureMean: numeric("temperature_mean", { precision: 5, scale: 2 }),
  // Daily max wind at 10 m in km/h.
  windSpeedMax: numeric("wind_speed_max", { precision: 6, scale: 2 }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("round_weather_cache_tournament_unique")
    .on(t.tournamentId, t.round)
    .where(sql`${t.tournamentId} IS NOT NULL`),
  uniqueIndex("round_weather_cache_gp_unique")
    .on(t.generalPlayRoundId, t.round)
    .where(sql`${t.generalPlayRoundId} IS NOT NULL`),
  index("round_weather_cache_observed_date_idx").on(t.observedDate),
  foreignKey({
    name: "round_weather_cache_gp_round_id_fk",
    columns: [t.generalPlayRoundId],
    foreignColumns: [generalPlayRoundsTable.id],
  }).onDelete("cascade"),
]);

export type RoundWeatherCache = typeof roundWeatherCacheTable.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// AI CADDIE CHAT HISTORY (Task #843)
// One row per signed-in player. The full transcript is stored as a JSON array
// (capped client-side to ~50 turns) so it follows the player across phones,
// tablets, and the web portal. The mobile client also keeps an offline copy
// in AsyncStorage and falls back to it when the network is unreachable.
// ═══════════════════════════════════════════════════════════════════════════
export const caddieChatHistoryTable = pgTable("caddie_chat_history", {
  userId: integer("user_id").primaryKey().references(() => appUsersTable.id, { onDelete: "cascade" }),
  messages: jsonb("messages").$type<Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    context?: { shots: number; rounds: number; mode?: "shots" | "rounds"; totalTrackedShots?: number };
    error?: string;
  }>>().notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Optimistic-concurrency token: incremented on every successful PUT.
  // Clients read it back from GET/PUT and pass it as `baseVersion` on the
  // next PUT so the server can reject stale writes from a second device
  // (Task #989). Starts at 1 for the first row, 0 means "no row yet".
  version: integer("version").notNull().default(1),
});

export type CaddieChatHistoryRow = typeof caddieChatHistoryTable.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════
// MEMBER MANAGEMENT 360 (Task #166)
// Professional club platform parity (ClubV1, Jonas, Northstar, ForeTees, GG)
// ═══════════════════════════════════════════════════════════════════════════

// Extended profile attributes — referenced via 1:1 to club_members
export const memberProfileExtTable = pgTable("member_profile_ext", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Identity
  middleName: text("middle_name"),
  preferredName: text("preferred_name"),
  salutation: text("salutation"),
  gender: text("gender"),
  pronouns: text("pronouns"),
  nationality: text("nationality"),
  occupation: text("occupation"),
  employer: text("employer"),
  // Address
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country"),
  // Emergency contact
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  emergencyContactRelation: text("emergency_contact_relation"),
  // Golf prefs
  preferredTee: text("preferred_tee"),
  dominantHand: text("dominant_hand"), // right/left
  preferredCart: text("preferred_cart"), // walk/cart/caddie
  // Apparel/fitting
  shirtSize: text("shirt_size"),
  shoeSize: text("shoe_size"),
  glovesSize: text("gloves_size"),
  // KYC
  kycStatus: text("kyc_status").notNull().default("pending"), // pending, verified, expired, rejected
  kycVerifiedAt: timestamp("kyc_verified_at", { withTimezone: true }),
  kycVerifiedByUserId: integer("kyc_verified_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  // Flags
  isVip: boolean("is_vip").notNull().default(false),
  internalTags: jsonb("internal_tags").$type<string[]>().default([]),
  // Security
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  twoFactorMethod: text("two_factor_method"), // app, sms, email
  // Financial
  joiningFee: numeric("joining_fee", { precision: 12, scale: 2 }).notNull().default("0"),
  refundableDeposit: numeric("refundable_deposit", { precision: 12, scale: 2 }).notNull().default("0"),
  creditLimit: numeric("credit_limit", { precision: 12, scale: 2 }).notNull().default("0"),
  // Status (lifecycle convenience cache; authoritative log in member_lifecycle_events)
  lifecycleStatus: text("lifecycle_status").notNull().default("active"), // active, frozen, suspended, resigned, deceased, transferred
  lifecycleStatusUntil: timestamp("lifecycle_status_until", { withTimezone: true }),
  lifecycleReason: text("lifecycle_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("member_profile_ext_member_unique").on(t.clubMemberId),
  index("member_profile_ext_org_idx").on(t.organizationId),
  index("member_profile_ext_status_idx").on(t.organizationId, t.lifecycleStatus),
]);

// Documents (KYC & misc)
export const memberDocumentsTable = pgTable("member_documents", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  documentType: text("document_type").notNull(), // id_proof, address_proof, photo, contract, waiver, medical, other
  title: text("title").notNull(),
  fileUrl: text("file_url").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isVerified: boolean("is_verified").notNull().default(false),
  verifiedByUserId: integer("verified_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  // Rejection (Task 209) — staff can reject a pending document with a reason.
  // Rejected docs are kept (not deleted) so members and staff have an audit
  // trail of why a previous upload was sent back, and are excluded from the
  // pending-verification queue + count badge.
  isRejected: boolean("is_rejected").notNull().default(false),
  rejectedByUserId: integer("rejected_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_documents_member_idx").on(t.clubMemberId),
  index("member_documents_type_idx").on(t.organizationId, t.documentType),
]);

// Append-only history of replaced member-document files. A new row is written
// every time a member (or staff) replaces the file backing an existing
// member_documents row, so admins can review what was previously on file.
export const memberDocumentVersionsTable = pgTable("member_document_versions", {
  id: serial("id").primaryKey(),
  memberDocumentId: integer("member_document_id").notNull(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  fileUrl: text("file_url").notNull(),
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  replacedByUserId: integer("replaced_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
  // How this version row came to exist:
  //   "replace" — a member or staff member uploaded a new file that displaced the previous one (default, legacy rows).
  //   "restore" — staff restored an older version; the live file at that moment was snapshotted into history.
  source: text("source").notNull().default("replace"),
  // For source="restore", the id of the archived version that was promoted back to live.
  // Lets the UI link the snapshot row back to the version that was restored from.
  restoredFromVersionId: integer("restored_from_version_id"),
}, (t) => [
  index("member_document_versions_doc_idx").on(t.memberDocumentId),
  foreignKey({ name: "member_document_versions_member_document_id_fk", columns: [t.memberDocumentId], foreignColumns: [memberDocumentsTable.id] }).onDelete("cascade"),
]);

// Consents (GDPR/DPDP) — append-only history
export const memberConsentsTable = pgTable("member_consents", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  consentType: text("consent_type").notNull(), // privacy, marketing, directory, photo, third_party_share, terms
  granted: boolean("granted").notNull(),
  version: text("version"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  source: text("source"), // mobile_app, web_admin, email_link, paper
  ipAddress: text("ip_address"),
  evidenceUrl: text("evidence_url"),
  recordedByUserId: integer("recorded_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
}, (t) => [
  index("member_consents_member_idx").on(t.clubMemberId),
  index("member_consents_type_idx").on(t.organizationId, t.consentType),
]);

// Per-category communication preferences (richer than user_notification_prefs)
export const memberCommPrefsTable = pgTable("member_comm_prefs", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Categories: billing, events, tournaments, newsletters, marketing, operations, service, social,
  // and `privacy` — a regulatory category for mandatory data-protection notices
  // (GDPR/DPDP acknowledgements, status updates). Privacy notices are always
  // delivered in-app and via email; the `privacy` row controls whether the
  // member additionally receives push and SMS for those notices. Members
  // cannot opt out of the in-app/email channels for the privacy category.
  category: text("category").notNull(),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  pushEnabled: boolean("push_enabled").notNull().default(true),
  // Privacy-safe default: members must explicitly opt in to WhatsApp via
  // the member preference screens (web portal Notifications tab and the
  // mobile my-360/communications screen).
  whatsappEnabled: boolean("whatsapp_enabled").notNull().default(false),
  inAppEnabled: boolean("in_app_enabled").notNull().default(true),
  quietHoursStart: text("quiet_hours_start"), // "22:00"
  quietHoursEnd: text("quiet_hours_end"), // "07:00"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("member_comm_prefs_member_cat_unique").on(t.clubMemberId, t.category),
  index("member_comm_prefs_org_idx").on(t.organizationId),
]);

// Family / corporate links (spouse, dependents, corporate group)
export const memberFamilyLinksTable = pgTable("member_family_links", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  primaryMemberId: integer("primary_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  linkedMemberId: integer("linked_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  relationship: text("relationship").notNull(), // spouse, child, parent, sibling, corporate_employee, dependent
  isPrimaryPayer: boolean("is_primary_payer").notNull().default(false),
  canBookOnBehalf: boolean("can_book_on_behalf").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("member_family_links_pair_unique").on(t.primaryMemberId, t.linkedMemberId),
  index("member_family_links_linked_idx").on(t.linkedMemberId),
  index("member_family_links_org_idx").on(t.organizationId),
]);

// Lifecycle events (freeze, suspend, transfer, tier-change, resign, reinstate)
export const memberLifecycleEventsTable = pgTable("member_lifecycle_events", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // tier_change, freeze, unfreeze, suspend, reinstate, transfer, resign, deceased, waitlist_added, waitlist_promoted
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  reason: text("reason"),
  internalNotes: text("internal_notes"),
  feeImpact: numeric("fee_impact", { precision: 12, scale: 2 }),
  performedByUserId: integer("performed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_lifecycle_events_member_idx").on(t.clubMemberId),
  index("member_lifecycle_events_org_type_idx").on(t.organizationId, t.eventType),
]);

// Disciplinary actions
export const memberDisciplinaryTable = pgTable("member_disciplinary", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  incidentDate: timestamp("incident_date", { withTimezone: true }).notNull(),
  category: text("category").notNull(), // dress_code, conduct, slow_play, vandalism, billing, other
  severity: text("severity").notNull().default("warning"), // warning, fine, suspension, expulsion
  description: text("description").notNull(),
  fineAmount: numeric("fine_amount", { precision: 12, scale: 2 }),
  status: text("status").notNull().default("open"), // open, resolved, appealed, dismissed
  resolutionNotes: text("resolution_notes"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  recordedByUserId: integer("recorded_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_disciplinary_member_idx").on(t.clubMemberId),
  index("member_disciplinary_org_status_idx").on(t.organizationId, t.status),
]);

// Internal staff notes (private)
export const memberInternalNotesTable = pgTable("member_internal_notes", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  authorId: integer("author_id").notNull().references(() => appUsersTable.id, { onDelete: "restrict" }),
  body: text("body").notNull(),
  category: text("category"), // service, complaint, preference, billing, vip
  isPinned: boolean("is_pinned").notNull().default(false),
  visibility: text("visibility").notNull().default("staff"), // staff, committee, owner_only
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_internal_notes_member_idx").on(t.clubMemberId),
]);

// Audit log (mutations on member entities)
export const memberAuditLogTable = pgTable("member_audit_log", {
  id: serial("id").primaryKey(),
  // Nullable: org-level audits (e.g. levy_definition, saved_segment) have no member.
  clubMemberId: integer("club_member_id").references(() => clubMembersTable.id, { onDelete: "cascade" }),
  // Nullable: system-level cron dispatches (e.g. the weekly silent-failures
  // digest written by `silentAlertsDigest.ts`, Task #1663) persist their
  // dedup marker here without a natural org context. All non-system
  // callers continue to populate this column.
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  actorUserId: integer("actor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  entity: text("entity").notNull(), // profile, document, consent, lifecycle, financial, comm_prefs, family_link, levy_definition, saved_segment, etc.
  entityId: integer("entity_id"),
  action: text("action").notNull(), // create, update, delete, view_pii
  fieldChanges: jsonb("field_changes").$type<Record<string, { from: unknown; to: unknown }>>(),
  reason: text("reason"),
  // Free-form structured detail for actions where the textual `reason` is too
  // lossy. E.g. resend audits stash per-channel { status, at, error } objects
  // here so the UI can render hover tooltips without re-parsing the reason
  // string. Always optional — older rows may have null.
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_audit_member_idx").on(t.clubMemberId),
  index("member_audit_org_created_idx").on(t.organizationId, t.createdAt),
  index("member_audit_entity_idx").on(t.entity, t.entityId),
]);

// Levies (one-off charges to members or member subsets)
export const memberLeviesTable = pgTable("member_levies", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  scope: text("scope").notNull().default("all"), // all, tier, manual
  scopeFilter: jsonb("scope_filter").$type<{ tierIds?: number[]; memberIds?: number[] }>(),
  dueDate: timestamp("due_date", { withTimezone: true }),
  status: text("status").notNull().default("draft"), // draft, applied, cancelled
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  appliedByUserId: integer("applied_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_levies_org_idx").on(t.organizationId),
]);

export const memberLevyChargesTable = pgTable("member_levy_charges", {
  id: serial("id").primaryKey(),
  levyId: integer("levy_id").notNull().references(() => memberLeviesTable.id, { onDelete: "cascade" }),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  // Legacy boolean retained for back-compat with existing readers.
  // Mirrors `status === 'paid'`. New code should prefer `status` + `paidAmount`.
  paid: boolean("paid").notNull().default(false),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  // Status: unpaid | partial | paid | waived | refunded
  // - unpaid: no payments recorded
  // - partial: paidAmount > 0 and < (amount - refundedAmount)
  // - paid:    paidAmount >= (amount - refundedAmount) and refundedAmount < amount
  // - refunded: refundedAmount >= amount (fully refunded / written off)
  // - waived:  charge dismissed without payment, with reason captured
  status: text("status").notNull().default("unpaid"),
  paidAmount: numeric("paid_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  refundedAmount: numeric("refunded_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  waivedReason: text("waived_reason"),
  invoiceId: integer("invoice_id"),
  // Latest receipt-email delivery outcome for this charge (Task 222).
  // Updated whenever a payment / refund / waiver is recorded or the receipt
  // is manually resent. Null when no transaction has happened yet.
  //   'sent'    — receipt email accepted by the SMTP provider.
  //   'skipped' — best-effort skip (no email on file, billing pref off, …).
  //   'failed'  — provider raised an error (captured in lastReceiptReason).
  lastReceiptStatus: text("last_receipt_status"),
  lastReceiptReason: text("last_receipt_reason"),
  // Receipt kind matches the LevyReceiptKind union: payment, partial_payment,
  // refund, waiver. Persisted so the resend endpoint can replay the latest
  // receipt without parsing the ledger.
  lastReceiptKind: text("last_receipt_kind"),
  lastReceiptAmount: numeric("last_receipt_amount", { precision: 12, scale: 2 }),
  lastReceiptNote: text("last_receipt_note"),
  lastReceiptAt: timestamp("last_receipt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("member_levy_charges_unique").on(t.levyId, t.clubMemberId),
  index("member_levy_charges_member_idx").on(t.clubMemberId),
]);

// Itemised payment ledger for each levy charge (Task 199).
// Treasurers and auditors need to reconstruct what happened to a charge
// without parsing free-text audit reasons. Each payment, refund, or waive
// writes one row here in addition to updating the running totals on
// `member_levy_charges`. The charge row remains the source of truth for
// outstanding balance; this table is the source of truth for activity.
export const memberLevyChargeEventsTable = pgTable("member_levy_charge_events", {
  id: serial("id").primaryKey(),
  chargeId: integer("charge_id").notNull().references(() => memberLevyChargesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  // payment | refund | waive | reversal
  // 'reversal' rows are compensating entries that undo a previous event without
  // mutating it; the running totals on the charge row are recomputed from the
  // surviving (non-reversed, non-reversal) ledger so the audit trail stays honest.
  eventType: text("event_type").notNull(),
  // For 'reversal' events, the id of the original event being reversed.
  // Self-reference is set null on delete so cascades from charge deletion stay clean.
  // FK declared explicitly below so we can give it a short, untruncated name.
  reversesEventId: integer("reverses_event_id"),
  // Always non-negative. For waive events this is the remaining balance written off
  // at the moment of the event (informational; the charge row keeps paid/refunded totals).
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull().default("0"),
  // Optional payment method for payments/refunds: cash, card, bank_transfer, online, cheque, credit_note
  method: text("method"),
  // Optional gateway / bank / receipt reference (Stripe payment intent id, UPI ref, etc.)
  processorReference: text("processor_reference"),
  // Free-text note (payments) or reason (refunds, waives)
  note: text("note"),
  reason: text("reason"),
  actorUserId: integer("actor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  actorName: text("actor_name"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_levy_charge_events_charge_idx").on(t.chargeId, t.occurredAt),
  index("member_levy_charge_events_org_time_idx").on(t.organizationId, t.occurredAt),
  index("member_levy_charge_events_member_idx").on(t.clubMemberId),
  // Self-FK: explicit short name. drizzle's auto-name
  // `member_levy_charge_events_reverses_event_id_member_levy_charge_events_id_fk`
  // is 75 chars and gets truncated by Postgres to 63, which causes
  // permanent drift-check churn.
  foreignKey({ name: "member_levy_charge_events_reverses_fk", columns: [t.reversesEventId], foreignColumns: [t.id] }).onDelete("set null"),
]);

// Recurring email of the levy ledger CSV (Task #229).
// One schedule per (organization, levy). Cron picks up enabled rows whose
// next_run_at has elapsed, builds the CSV for the elapsed period, emails it
// to all configured recipients, and records a row in levy_ledger_email_runs.
export const levyLedgerEmailSchedulesTable = pgTable("levy_ledger_email_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  levyId: integer("levy_id").notNull().references(() => memberLeviesTable.id, { onDelete: "cascade" }),
  // 'weekly' | 'monthly'
  frequency: text("frequency").notNull(),
  // jsonb array of recipient email addresses (must be non-empty when enabled)
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("levy_ledger_email_schedules_unique").on(t.organizationId, t.levyId),
  index("levy_ledger_email_schedules_next_run_idx").on(t.nextRunAt),
]);

/**
 * Snapshot of a single recipient that was filtered out of a per-levy
 * (or club-wide combined) levy-ledger digest run because they were on
 * the org's `email_suppressions` list at the moment the cron evaluated.
 * Persisted on `levyLedgerEmailRunsTable.pausedRecipients` and
 * `levyLedgerEmailOrgRunsTable.pausedRecipients` so the schedule edit
 * drawer (Task #1763) can surface "who was paused on the most recent
 * run" even after the recipient has been pruned from
 * `schedule.recipients` by Task #1444's bounce-aware filter — the run
 * row is the durable source of truth, the schedule's recipients list
 * is not. Mirrors `WalletTopupRefundEmailRunPausedRecipient` (Task #1759)
 * so the React panels can share the `PausedRecipientRow` type.
 */
export interface LevyLedgerEmailRunPausedRecipient {
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
}

export const levyLedgerEmailRunsTable = pgTable("levy_ledger_email_runs", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  // 'sent' | 'failed' | 'skipped'
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  // Task #1763 — snapshot of recipients silently dropped on this run
  // because they were on the org's `email_suppressions` list at send
  // time. Stored as a JSON snapshot so the schedule's "X paused"
  // dashboard reflects what was actually pruned even after Task #1444
  // has already removed those addresses from `schedule.recipients`.
  pausedRecipients: jsonb("paused_recipients").$type<LevyLedgerEmailRunPausedRecipient[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => [
  index("levy_ledger_email_runs_schedule_idx").on(t.scheduleId, t.sentAt),
  foreignKey({ name: "levy_ledger_email_runs_schedule_id_fk", columns: [t.scheduleId], foreignColumns: [levyLedgerEmailSchedulesTable.id] }).onDelete("cascade"),
]);

// Org-level recurring email of the combined levy ledger CSV (Task #278).
// One schedule per organization (not per levy). Cron picks up enabled rows
// whose next_run_at has elapsed, builds a single CSV containing every levy's
// ledger entries for the elapsed period, emails it to all configured
// recipients, and records a row in levy_ledger_email_org_runs.
export const levyLedgerEmailOrgSchedulesTable = pgTable("levy_ledger_email_org_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  // 'weekly' | 'monthly'
  frequency: text("frequency").notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  // 'combined' | 'per_levy_zip' | 'both' (Task #322)
  deliveryFormat: text("delivery_format").notNull().default("combined"),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("levy_ledger_email_org_schedules_unique").on(t.organizationId),
  index("levy_ledger_email_org_schedules_next_run_idx").on(t.nextRunAt),
  foreignKey({ name: "levy_ledger_email_org_schedules_organization_id_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "levy_ledger_email_org_schedules_created_by_user_id_fk", columns: [t.createdByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

export const levyLedgerEmailOrgRunsTable = pgTable("levy_ledger_email_org_runs", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  levyCount: integer("levy_count").notNull().default(0),
  // 'sent' | 'failed' | 'skipped'
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  // Task #1763 — see `levyLedgerEmailRunsTable.pausedRecipients` for the
  // rationale; same shape, applied to the club-wide combined ledger
  // digest cron so the org-wide schedule editor surfaces auto-removed
  // recipients reliably even after Task #1444 has pruned them.
  pausedRecipients: jsonb("paused_recipients").$type<LevyLedgerEmailRunPausedRecipient[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => [
  index("levy_ledger_email_org_runs_schedule_idx").on(t.scheduleId, t.sentAt),
  foreignKey({ name: "levy_ledger_email_org_runs_schedule_id_fk", columns: [t.scheduleId], foreignColumns: [levyLedgerEmailOrgSchedulesTable.id] }).onDelete("cascade"),
]);

// Per-currency revenue & tax pivot CSV scheduled email (Task #669).
// Mirrors the org-level levy ledger digest pattern: one schedule per
// organization, cron picks up enabled rows whose next_run_at has elapsed,
// builds the CSV using the same SQL as `/revenue-by-currency.csv` for the
// elapsed period, emails it to the configured recipients, and records a
// row in revenue_by_currency_email_runs.
export const revenueByCurrencyEmailSchedulesTable = pgTable("revenue_by_currency_email_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  // 'weekly' | 'monthly'
  frequency: text("frequency").notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("revenue_by_currency_email_schedules_unique").on(t.organizationId),
  index("revenue_by_currency_email_schedules_next_run_idx").on(t.nextRunAt).where(sql`enabled = true`),
  foreignKey({ name: "revenue_by_currency_email_schedules_organization_id_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "revenue_by_currency_email_schedules_created_by_user_id_fk", columns: [t.createdByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

export const revenueByCurrencyEmailRunsTable = pgTable("revenue_by_currency_email_runs", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  // Explicit short FK name: the auto-generated
  // `revenue_by_currency_email_runs_organization_id_organizations_id_fk` is
  // 66 chars and would be silently truncated by Postgres. See task #805.
  organizationId: integer("organization_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  currencyCount: integer("currency_count").notNull().default(0),
  // 'sent' | 'failed' | 'skipped'
  status: text("status").notNull(),
  errorMessage: text("error_message"),
}, (t) => [
  index("revenue_by_currency_email_runs_schedule_idx").on(t.scheduleId, t.sentAt),
  foreignKey({ name: "revenue_by_currency_email_runs_schedule_id_fk", columns: [t.scheduleId], foreignColumns: [revenueByCurrencyEmailSchedulesTable.id] }).onDelete("cascade"),
  foreignKey({ name: "revenue_by_currency_email_runs_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

// Forecast accuracy weekly/monthly digest CSV (Task #1254).
// Mirrors the `revenue_by_currency_email_schedules` pattern: one schedule per
// organization. The hourly cron picks up enabled rows whose next_run_at has
// elapsed, builds the CSV that mirrors the manual download in the
// Forecast Accuracy tab (same columns) for the elapsed period, emails it to
// the configured recipients, and records a row in the runs table. The
// schedule can be disabled (paused) without losing recipients.
export const forecastAccuracyEmailSchedulesTable = pgTable("forecast_accuracy_email_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  // 'weekly' | 'monthly'
  frequency: text("frequency").notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("forecast_accuracy_email_schedules_unique").on(t.organizationId),
  index("forecast_accuracy_email_schedules_next_run_idx").on(t.nextRunAt).where(sql`enabled = true`),
  foreignKey({ name: "forecast_accuracy_email_schedules_organization_id_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "forecast_accuracy_email_schedules_created_by_user_id_fk", columns: [t.createdByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

export const forecastAccuracyEmailRunsTable = pgTable("forecast_accuracy_email_runs", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  // Explicit short FK names: the auto-generated names would exceed
  // Postgres' 63-char identifier limit and be silently truncated.
  organizationId: integer("organization_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  // Status of the dispatch: 'sent' | 'failed' | 'skipped'.
  status: text("status").notNull(),
  errorMessage: text("error_message"),
}, (t) => [
  index("forecast_accuracy_email_runs_schedule_idx").on(t.scheduleId, t.sentAt),
  foreignKey({ name: "forecast_accuracy_email_runs_schedule_fk", columns: [t.scheduleId], foreignColumns: [forecastAccuracyEmailSchedulesTable.id] }).onDelete("cascade"),
  foreignKey({ name: "forecast_accuracy_email_runs_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

// Wallet auto-refund weekly/monthly digest CSV (Task #1073).
// Org admins configure a per-org schedule that emails the same CSV the
// `/admin/wallet-topup-refunds.csv` dashboard exports to a list of finance
// recipients on a weekly or monthly cadence so reconciliation can happen
// entirely from the inbox without anyone remembering to log in.
export const walletTopupRefundEmailSchedulesTable = pgTable("wallet_topup_refund_email_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  // 'weekly' | 'monthly'
  frequency: text("frequency").notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wallet_topup_refund_email_schedules_unique").on(t.organizationId),
  index("wallet_topup_refund_email_schedules_next_run_idx").on(t.nextRunAt).where(sql`enabled = true`),
  foreignKey({ name: "wallet_topup_refund_email_schedules_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_topup_refund_email_schedules_created_by_fk", columns: [t.createdByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

/**
 * Snapshot of a single recipient that was filtered out of a wallet
 * auto-refund digest run because they were on the org's `email_suppressions`
 * list at the moment the cron evaluated. Persisted on
 * `walletTopupRefundEmailRunsTable.pausedRecipients` so the run-history
 * dashboard (Task #1759) can surface "who was paused on this specific run"
 * without re-querying the live suppression table — finance must still see
 * the truth even after the suppression is later lifted via the
 * `/email-schedule/unsuppress` route.
 */
export interface WalletTopupRefundEmailRunPausedRecipient {
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
}

/**
 * Snapshot of which language each recipient on a wallet auto-refund
 * digest run *actually* received the digest in (Task #2170). Until this
 * task the cron rendered a single org-wide language for every
 * recipient; the digest is now grouped by per-recipient
 * `appUsersTable.preferredLanguage` (with the org's resolved
 * `defaultLanguage` as fallback for external recipients) and one
 * rendered email goes out per language group. This per-row snapshot
 * records the resolved language used for each delivered recipient so
 * the run-history dashboard can attribute "who received which language"
 * even after the user later changes their `preferredLanguage`.
 */
export interface WalletTopupRefundEmailRunRecipientLanguage {
  email: string;
  language: string;
}

export const walletTopupRefundEmailRunsTable = pgTable("wallet_topup_refund_email_runs", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  currencyCount: integer("currency_count").notNull().default(0),
  // 'sent' | 'failed' | 'skipped'
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  // Task #1759 — snapshot of recipients that were silently dropped from
  // *this* run because they were on the org's `email_suppressions` list at
  // send time. Stored as a JSON snapshot (not a join) so the run history
  // remains accurate even after finance later lifts the suppression — the
  // run table answers "who was paused at the moment of this run" without
  // having to reconstruct historical suppression state. Each entry mirrors
  // the metadata the schedule-level "X paused" chip surfaces (Task #1443).
  pausedRecipients: jsonb("paused_recipients").$type<WalletTopupRefundEmailRunPausedRecipient[]>().notNull().default(sql`'[]'::jsonb`),
  // Task #2170 — per-recipient language attribution snapshot. The cron
  // now groups recipients by their resolved digest language (per-user
  // `appUsersTable.preferredLanguage` with the org's resolved
  // `defaultLanguage` as fallback for external recipients) and dispatches
  // one rendered digest per language group. We snapshot which recipient
  // received which language onto the run row so the dashboard's history
  // table can attribute "who got which translation" even after the user
  // later changes their preference.
  recipientLanguages: jsonb("recipient_languages").$type<WalletTopupRefundEmailRunRecipientLanguage[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => [
  index("wallet_topup_refund_email_runs_schedule_idx").on(t.scheduleId, t.sentAt),
  foreignKey({ name: "wallet_topup_refund_email_runs_schedule_fk", columns: [t.scheduleId], foreignColumns: [walletTopupRefundEmailSchedulesTable.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_topup_refund_email_runs_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

// Stuck side-game receipt deliveries digest (Task #1290).
// Mirrors the wallet auto-refund digest pattern (Task #1073) so org admins
// receive a daily/weekly CSV of side-game settlement receipts whose
// email/push delivery is stuck (`*RetryExhaustedAt` stamped or status
// permanently `skipped` / `no_address` / `opted_out` / `no_user`). Idempotent
// — `lastSentAt` + `nextRunAt` advance on every run so a re-poll cannot
// double-mail. The recipient list is bounce-aware: addresses that hit the
// `email_suppressions` table are pruned out and admins are alerted via
// `side_game.receipt.digest.failed` so a misconfigured inbox never silently
// swallows weeks of digests.
export const sideGameReceiptDigestSchedulesTable = pgTable("side_game_receipt_digest_schedules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  // 'daily' | 'weekly'
  frequency: text("frequency").notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  enabled: boolean("enabled").notNull().default(true),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  createdByUserId: integer("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("side_game_receipt_digest_schedules_unique").on(t.organizationId),
  index("side_game_receipt_digest_schedules_next_run_idx").on(t.nextRunAt).where(sql`enabled = true`),
  foreignKey({ name: "side_game_receipt_digest_schedules_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "side_game_receipt_digest_schedules_created_by_fk", columns: [t.createdByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

/**
 * Snapshot of a single recipient that was filtered out of a side-game
 * receipt digest run because they were on the org's `email_suppressions`
 * list at the moment the cron evaluated. Persisted on
 * `sideGameReceiptDigestRunsTable.pausedRecipients` so the run-history
 * dashboard (Task #2196) can surface "who was paused on this specific
 * run" without re-querying the live suppression table — support must
 * still see the truth even after the suppression is later lifted.
 *
 * Mirrors `WalletTopupRefundEmailRunPausedRecipient` (Task #1759) so the
 * frontend can share a chip + per-recipient breakdown component shape
 * across both digests.
 */
export interface SideGameReceiptDigestRunPausedRecipient {
  email: string;
  reason: string;
  bounceType: string | null;
  description: string | null;
}

export const sideGameReceiptDigestRunsTable = pgTable("side_game_receipt_digest_runs", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  recipients: jsonb("recipients").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  rowCount: integer("row_count").notNull().default(0),
  exhaustedCount: integer("exhausted_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  // 'sent' | 'failed' | 'skipped'
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  // Task #2196 — snapshot of recipients that were silently dropped from
  // *this* run because they were on the org's `email_suppressions` list at
  // send time. Mirrors the wallet auto-refund counterpart added in Task
  // #1759 — stored as a JSON snapshot (not a join) so the run history
  // remains accurate even after support later lifts the suppression. The
  // run table answers "who was paused at the moment of this run" without
  // having to reconstruct historical suppression state.
  pausedRecipients: jsonb("paused_recipients").$type<SideGameReceiptDigestRunPausedRecipient[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => [
  index("side_game_receipt_digest_runs_schedule_idx").on(t.scheduleId, t.sentAt),
  foreignKey({ name: "side_game_receipt_digest_runs_schedule_fk", columns: [t.scheduleId], foreignColumns: [sideGameReceiptDigestSchedulesTable.id] }).onDelete("cascade"),
  foreignKey({ name: "side_game_receipt_digest_runs_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

// Idempotency record for external-provider payments applied to a levy
// charge (Task #198). One row per provider payment, with a unique index
// on (provider, providerPaymentId) so duplicate webhook deliveries or
// double-clicks fail to insert and can be safely treated as already-applied.
// The human-readable activity feed lives in `member_levy_charge_events`;
// this table exists purely for transactional dedupe.
export const memberLevyChargePaymentsTable = pgTable("member_levy_charge_payments", {
  id: serial("id").primaryKey(),
  levyChargeId: integer("levy_charge_id").notNull(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  // Source of the payment: 'razorpay' | 'manual' | etc.
  provider: text("provider").notNull(),
  // Provider's payment id (e.g. Razorpay payment_id). NULL allowed for
  // non-provider sources (e.g. manual cash entries) — uniqueness is only
  // enforced when providerPaymentId is non-null.
  providerPaymentId: text("provider_payment_id"),
  providerOrderId: text("provider_order_id"),
  // Where the payment came from: 'admin' | 'portal' | 'webhook'
  source: text("source").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("member_levy_charge_payments_provider_unique")
    .on(t.provider, t.providerPaymentId)
    .where(sql`${t.providerPaymentId} IS NOT NULL`),
  index("member_levy_charge_payments_charge_idx").on(t.levyChargeId),
  foreignKey({ name: "member_levy_charge_payments_levy_charge_id_fk", columns: [t.levyChargeId], foreignColumns: [memberLevyChargesTable.id] }).onDelete("cascade"),
]);

// Receipt notification retry attempts (Task #247).
// Records each levy-receipt notification (one row per receipt event) so failed
// push and SMS deliveries can be re-attempted on a bounded schedule by the
// retry cron, mirroring the privacy-request retry pattern. The captured
// payload (kind, levyName, currency, transactionAmount, newBalance, note)
// is persisted at notification time so retries don't depend on the (possibly
// since-mutated) charge row to rebuild the message body.
//
// Email deliveries are intentionally not retried here because the receipt
// email path already enqueues into the mail provider's own retry queue and
// the original Task #207 helper treats email as best-effort.
export const memberLevyReceiptAttemptsTable = pgTable("member_levy_receipt_attempts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  chargeId: integer("charge_id").notNull(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  // payment | partial_payment | refund | waiver
  kind: text("kind").notNull(),
  levyName: text("levy_name").notNull(),
  currency: text("currency").notNull(),
  transactionAmount: numeric("transaction_amount", { precision: 12, scale: 2 }).notNull(),
  newBalance: numeric("new_balance", { precision: 12, scale: 2 }).notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Per-channel state. Statuses mirror LevyReceiptChannelStatus:
  //   sent | failed | no_address | no_user | opted_out | skipped
  pushStatus: text("push_status"),
  pushAttempts: integer("push_attempts").notNull().default(0),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushError: text("last_push_error"),
  lastPushRetryAt: timestamp("last_push_retry_at", { withTimezone: true }),
  pushRetryExhaustedAt: timestamp("push_retry_exhausted_at", { withTimezone: true }),
  smsStatus: text("sms_status"),
  smsAttempts: integer("sms_attempts").notNull().default(0),
  lastSmsAt: timestamp("last_sms_at", { withTimezone: true }),
  lastSmsError: text("last_sms_error"),
  lastSmsRetryAt: timestamp("last_sms_retry_at", { withTimezone: true }),
  smsRetryExhaustedAt: timestamp("sms_retry_exhausted_at", { withTimezone: true }),
  // Task #296: WhatsApp telemetry foundation. Columns mirror the SMS retry
  // pattern above so the per-surface notify helpers (added in downstream
  // tasks) can fan-out to WhatsApp and the existing retry cron can re-attempt
  // failed deliveries on a bounded schedule.
  whatsappStatus: text("whatsapp_status"),
  whatsappAttempts: integer("whatsapp_attempts").notNull().default(0),
  lastWhatsappAt: timestamp("last_whatsapp_at", { withTimezone: true }),
  lastWhatsappError: text("last_whatsapp_error"),
  lastWhatsappRetryAt: timestamp("last_whatsapp_retry_at", { withTimezone: true }),
  whatsappRetryExhaustedAt: timestamp("whatsapp_retry_exhausted_at", { withTimezone: true }),
  // Task #507: provider-issued WhatsApp message id (Twilio SID, MSG91
  // request_id) recorded at send time so the WhatsApp delivery webhook can
  // map an asynchronous status callback (delivered/failed/undelivered/
  // blocked) back to this receipt and re-flip the row to `failed` for the
  // existing levy receipt retry cron to pick up.
  lastWhatsappMessageId: text("last_whatsapp_message_id"),
  // Task #269: dedup markers for the admin alert fired when a channel's
  // retry cap is reached. Stamped exactly once per attempts row + channel.
  pushExhaustionNotifiedAt: timestamp("push_exhaustion_notified_at", { withTimezone: true }),
  smsExhaustionNotifiedAt: timestamp("sms_exhaustion_notified_at", { withTimezone: true }),
  // Task #1847 — email retry budget for the levy-receipt fan-out. Mirrors
  // the side-game / wallet-withdrawal pattern (Task #961 / #1108) so a
  // transient SMTP blip on the first attempt is re-attempted on the
  // bounded `5/10/20/40/80` minute schedule, and a hard SMTP bounce
  // (Task #1279) jumps straight to exhausted instead of consuming the
  // remaining budget.
  emailStatus: text("email_status"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  emailExhaustionNotifiedAt: timestamp("email_exhaustion_notified_at", { withTimezone: true }),
}, (t) => [
  index("member_levy_receipt_attempts_charge_idx").on(t.chargeId),
  index("member_levy_receipt_attempts_org_idx").on(t.organizationId),
  index("member_levy_receipt_attempts_member_idx").on(t.clubMemberId),
  index("member_levy_receipt_attempts_whatsapp_msg_id_idx").on(t.lastWhatsappMessageId),
  // Task #1847 — covering index for the email retry cron's WHERE clause
  // (`emailStatus='failed' AND emailAttempts < cap AND nextEmailRetryAt <= now`).
  index("member_levy_receipt_attempts_email_failed_idx").on(t.emailStatus, t.emailAttempts, t.nextEmailRetryAt),
  foreignKey({ name: "member_levy_receipt_attempts_organization_id_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "member_levy_receipt_attempts_charge_id_fk", columns: [t.chargeId], foreignColumns: [memberLevyChargesTable.id] }).onDelete("cascade"),
]);

// Task #973 — retry queue for object-storage deletions that failed during
// the account-erasure cron. Each row is one orphan file we still need to
// remove from the bucket. The retry worker drains rows whose
// `next_attempt_at` has elapsed using exponential backoff; on success the
// row is deleted, on failure the attempts counter is bumped and the next
// attempt is scheduled. An admin-visible counter (Member 360 storage
// failures endpoint) reads `COUNT(*)` so a stuck backend / IAM issue is
// surfaced proactively instead of relying on a human to read audit rows.
export const pendingStorageDeletionsTable = pgTable("pending_storage_deletions", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Nullable: the underlying club_members row may already be gone (cascade)
  // by the time we get here — we still want to retry the storage cleanup.
  clubMemberId: integer("club_member_id"),
  // Audit row that originally recorded this failure. Set null on cascade so
  // a manual audit-log purge does not orphan-block the retry queue.
  sourceAuditId: integer("source_audit_id"),
  path: text("path").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  // Task #1127 — set when the row first crosses the exhaustion threshold so
  // the org-admin alert is delivered exactly once per row regardless of how
  // many subsequent retry ticks the row sits through.
  exhaustionNotifiedAt: timestamp("exhaustion_notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({ name: "pending_storage_deletions_audit_fk", columns: [t.sourceAuditId], foreignColumns: [memberAuditLogTable.id] }).onDelete("set null"),
  index("pending_storage_deletions_next_attempt_idx").on(t.nextAttemptAt),
  index("pending_storage_deletions_org_idx").on(t.organizationId),
  index("pending_storage_deletions_member_idx").on(t.clubMemberId),
]);

// Milestones (hole-in-one register, holes-played, longest-day, etc.)
export const memberMilestonesTable = pgTable("member_milestones", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  milestoneType: text("milestone_type").notNull(), // hole_in_one, eagle, albatross, course_record, longest_drive_event, club_championship_win, anniversary
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  courseName: text("course_name"),
  holeNumber: integer("hole_number"),
  yardage: integer("yardage"),
  club: text("club"),
  witnesses: text("witnesses"),
  details: text("details"),
  verified: boolean("verified").notNull().default(false),
  verifiedByUserId: integer("verified_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_milestones_member_idx").on(t.clubMemberId),
  index("member_milestones_org_type_idx").on(t.organizationId, t.milestoneType),
]);

// RFID / NFC access cards
export const memberAccessCardsTable = pgTable("member_access_cards", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  cardType: text("card_type").notNull().default("rfid"), // rfid, nfc, qr
  cardNumber: text("card_number").notNull(),
  cardLabel: text("card_label"),
  isActive: boolean("is_active").notNull().default(true),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  deactivatedReason: text("deactivated_reason"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  issuedByUserId: integer("issued_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("member_access_cards_number_unique").on(t.organizationId, t.cardNumber),
  index("member_access_cards_member_idx").on(t.clubMemberId),
]);

export const memberAccessLogTable = pgTable("member_access_log", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  clubMemberId: integer("club_member_id").references(() => clubMembersTable.id, { onDelete: "set null" }),
  cardId: integer("card_id").references(() => memberAccessCardsTable.id, { onDelete: "set null" }),
  cardNumber: text("card_number"),
  zone: text("zone"), // gate, locker_room, range, pro_shop
  result: text("result").notNull().default("granted"), // granted, denied
  reason: text("reason"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_access_log_member_idx").on(t.clubMemberId),
  index("member_access_log_org_time_idx").on(t.organizationId, t.occurredAt),
]);

// Committee roles (richer than orgRole — multiple per member, term-bounded)
export const memberCommitteeRolesTable = pgTable("member_committee_roles", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  committee: text("committee").notNull(), // general, handicap, greens, finance, social, juniors, ladies, captain, president
  position: text("position").notNull(), // chair, vice_chair, secretary, treasurer, member
  termStart: timestamp("term_start", { withTimezone: true }).notNull(),
  termEnd: timestamp("term_end", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_committee_roles_member_idx").on(t.clubMemberId),
  index("member_committee_roles_org_idx").on(t.organizationId, t.committee),
]);

// Saved segments (admin filters)
export const memberSavedSegmentsTable = pgTable("member_saved_segments", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  ownerUserId: integer("owner_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
  isShared: boolean("is_shared").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("member_saved_segments_org_idx").on(t.organizationId),
  index("member_saved_segments_owner_idx").on(t.ownerUserId),
]);

// Direct messages from staff to a member (separate from broadcasts)
export const memberMessagesTable = pgTable("member_messages", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  senderUserId: integer("sender_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  channel: text("channel").notNull().default("in_app"), // in_app, email, sms, whatsapp
  subject: text("subject"),
  body: text("body").notNull(),
  status: text("status").notNull().default("sent"), // queued, sent, delivered, failed, read
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  // Task 192: link a message back to the entity that triggered it (e.g. a levy
  // reminder) so admins can list/retry only the failed reminders for that
  // specific entity instead of trawling the whole inbox.
  relatedEntity: text("related_entity"), // e.g. "levy"
  relatedEntityId: integer("related_entity_id"),
}, (t) => [
  index("member_messages_member_idx").on(t.clubMemberId),
  index("member_messages_org_time_idx").on(t.organizationId, t.sentAt),
  index("member_messages_related_idx").on(t.relatedEntity, t.relatedEntityId),
]);

// Privacy / data subject requests (GDPR/DPDP)
export const memberDataRequestsTable = pgTable("member_data_requests", {
  id: serial("id").primaryKey(),
  clubMemberId: integer("club_member_id").notNull().references(() => clubMembersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  requestType: text("request_type").notNull(), // export, erasure, rectification, restrict, object
  status: text("status").notNull().default("pending"), // pending, in_progress, completed, rejected
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  dueBy: timestamp("due_by", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  notes: text("notes"),
  artifactUrl: text("artifact_url"), // download link for export jobs
  handlerUserId: integer("handler_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  // Notification delivery tracking (Task 176) — privacy-request notices are mandatory
  // and are also persisted as in_app messages so a bounced email is not a gap.
  lastNotificationKind: text("last_notification_kind"), // filed | in_progress | completed | rejected
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  lastEmailStatus: text("last_email_status"), // sent | failed | no_address | skipped
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastInAppMessageId: integer("last_in_app_message_id"),
  lastInAppAt: timestamp("last_in_app_at", { withTimezone: true }),
  // Task 187: fan-out to push and SMS for opted-in members so a single bounced
  // email never becomes a regulatory gap. Status values mirror lastEmailStatus:
  //   sent | failed | no_address | no_user | opted_out | skipped
  lastPushStatus: text("last_push_status"),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushError: text("last_push_error"),
  lastSmsStatus: text("last_sms_status"),
  lastSmsAt: timestamp("last_sms_at", { withTimezone: true }),
  lastSmsError: text("last_sms_error"),
  // Task 191: bounded retry tracking for failed push/SMS deliveries. Attempt
  // counters are reset to 1 on each fresh notification (see notifyDataRequest)
  // and incremented by the retry cron until the per-channel cap is reached,
  // at which point the *_retry_exhausted_at timestamp is set so admins can
  // see (in Member 360) which notices the system has stopped re-attempting.
  pushAttempts: integer("push_attempts").notNull().default(0),
  smsAttempts: integer("sms_attempts").notNull().default(0),
  lastPushRetryAt: timestamp("last_push_retry_at", { withTimezone: true }),
  lastSmsRetryAt: timestamp("last_sms_retry_at", { withTimezone: true }),
  pushRetryExhaustedAt: timestamp("push_retry_exhausted_at", { withTimezone: true }),
  smsRetryExhaustedAt: timestamp("sms_retry_exhausted_at", { withTimezone: true }),
  // Task #296: WhatsApp telemetry foundation. Mirrors the SMS columns above
  // so the per-surface privacy-notice helper (added in a downstream task)
  // can fan-out to WhatsApp and the existing retry cron can re-attempt
  // failed deliveries on a bounded schedule.
  lastWhatsappStatus: text("last_whatsapp_status"),
  lastWhatsappAt: timestamp("last_whatsapp_at", { withTimezone: true }),
  lastWhatsappError: text("last_whatsapp_error"),
  whatsappAttempts: integer("whatsapp_attempts").notNull().default(0),
  lastWhatsappRetryAt: timestamp("last_whatsapp_retry_at", { withTimezone: true }),
  whatsappRetryExhaustedAt: timestamp("whatsapp_retry_exhausted_at", { withTimezone: true }),
  // Task 210: bounded retry tracking for failed email deliveries — email is the
  // primary regulatory channel, so transient bounces should not become a
  // regulatory gap. Mirrors the push/SMS retry counters above.
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  // Task 238: stamped the first time admins are alerted that the email-retry
  // cap was reached for this notice. Used purely for de-duplication so the
  // same exhaustion isn't announced again on subsequent cron passes.
  emailExhaustionNotifiedAt: timestamp("email_exhaustion_notified_at", { withTimezone: true }),
  // Task 261: same de-duplication marker for push and SMS retry-exhaustion
  // admin alerts so push and SMS reach parity with the email channel.
  pushExhaustionNotifiedAt: timestamp("push_exhaustion_notified_at", { withTimezone: true }),
  smsExhaustionNotifiedAt: timestamp("sms_exhaustion_notified_at", { withTimezone: true }),
  // Task 297: WhatsApp as a 4th channel for privacy notices — exhaustion
  // dedup marker. The per-attempt telemetry/retry columns are declared above
  // (Task #296) and reused here.
  whatsappExhaustionNotifiedAt: timestamp("whatsapp_exhaustion_notified_at", { withTimezone: true }),
  // Task 347: provider-issued WhatsApp message id (Twilio SID, MSG91 request_id)
  // recorded at send time so the WhatsApp delivery webhook can map an
  // asynchronous status callback (delivered/failed/undelivered/blocked) back
  // to the originating privacy notice and update lastWhatsappStatus +
  // lastWhatsappError. Failed/undelivered callbacks re-flip the row to
  // `failed` so the existing retry cron picks it up (subject to the 5-attempt
  // cap).
  lastWhatsappMessageId: text("last_whatsapp_message_id"),
  // Task #773: stamped by the daily cron when an expired access-export's
  // archive is removed from object storage and `artifactUrl` is cleared.
  // Surfaced in the member portal and controller dashboard so members and
  // admins can see *when* the file was actually purged instead of just
  // inferring "expired" from the 7-day clock against `resolvedAt`.
  purgedAt: timestamp("purged_at", { withTimezone: true }),
  // Task #922 — track when the member actually downloaded their self-serve
  // data-export archive so the "expires in 24h" reminder cron can suppress
  // the nudge for members who already have the file. Stamped by the
  // download / signed-url endpoints in `routes/portal.ts`.
  artifactDownloadedAt: timestamp("artifact_downloaded_at", { withTimezone: true }),
  // Task #922 — set by the daily reminder cron when the `export_expiring`
  // notice has been dispatched for this row, so the same archive isn't
  // re-nudged on subsequent runs even if the row stays in the eligibility
  // window for several daily passes.
  expiringNoticeSentAt: timestamp("expiring_notice_sent_at", { withTimezone: true }),
  // Task #972 — stamped by the daily purge-reminder cron when a courtesy
  // "your data export expires tomorrow" notice has been dispatched, so the
  // same archive is never re-nudged on subsequent passes. Distinct from
  // `expiringNoticeSentAt` (Task #922) so the two crons can co-exist while
  // covering slightly different eligibility surfaces (this one fires for
  // *every* access export resolved 6 days ago, not only those whose
  // `lastNotificationKind` is still `completed_export`).
  expiryNotifiedAt: timestamp("expiry_notified_at", { withTimezone: true }),
  // Task #1075 — opaque per-request token rendered as a one-click "stop
  // reminding me about this download" link in the original `completed_export`
  // ready email. Lets members who deliberately let a link expire silence the
  // 24h-before reminder without first signing back into the portal. Minted
  // by `notifyDataRequest` when the `completed_export` notice fires; consumed
  // by the public `/api/portal/data-export-reminder-unsubscribe` endpoint.
  expiringReminderUnsubToken: text("expiring_reminder_unsub_token"),
  // Task #1075 — stamped when the member opts out of the export-expiring
  // reminder for *this specific request* (either by tapping the one-click
  // link in the ready email or by hitting the explicit opt-out endpoint).
  // The reminder cron filters these rows out and counts them as `suppressed`
  // in its summary log line, distinct from `notified`/`failed`. Distinct
  // from the per-user `userNotificationPrefs.notifyDataExportExpiring`
  // global toggle so a member can silence one stray export without changing
  // their global preference.
  expiringReminderOptedOutAt: timestamp("expiring_reminder_opted_out_at", { withTimezone: true }),
  // Task #1124 — open/click telemetry for the `export_expiring` reminder.
  // The cron currently has no way to tell whether the courtesy notice is
  // actually being read before the archive is auto-purged. We mint an
  // opaque per-request token at send time, embed a 1x1 tracking pixel + a
  // click-tracking redirect for the download CTA in the email, and stamp
  // these timestamps the first time each event fires. Distinct from the
  // unsubscribe token (above) so the public open/click endpoints can never
  // be used to silence a member's reminder. The controller dashboard
  // exposes an "X% of expiring-export reminders opened" widget that reads
  // from these columns.
  expiringReminderTrackingToken: text("expiring_reminder_tracking_token"),
  expiringReminderEmailOpenedAt: timestamp("expiring_reminder_email_opened_at", { withTimezone: true }),
  expiringReminderEmailClickedAt: timestamp("expiring_reminder_email_clicked_at", { withTimezone: true }),
  // Task #1298 — separate timestamp for fetches that are *almost certainly*
  // prefetched by a privacy-protecting mail proxy (Apple Mail Privacy
  // Protection, GoogleImageProxy, YahooMailProxy, Outlook SafeLinks scanner,
  // etc.) rather than a real human opening the email. The pixel handler
  // distinguishes prefetches via User-Agent + originating-IP heuristics
  // (see `looksLikeMailPrefetch` in routes/portal.ts) and stamps this
  // column instead of `expiringReminderEmailOpenedAt`. The dashboard's
  // open-rate widget excludes these by default and exposes an admin toggle
  // to fold them back in. Distinct from `expiringReminderEmailOpenedAt`
  // so we can audit how much the heuristic actually catches without
  // permanently destroying the signal.
  expiringReminderEmailPrefetchedAt: timestamp("expiring_reminder_email_prefetched_at", { withTimezone: true }),
}, (t) => [
  index("member_data_requests_member_idx").on(t.clubMemberId),
  index("member_data_requests_org_status_idx").on(t.organizationId, t.status),
  index("member_data_requests_whatsapp_msg_id_idx").on(t.lastWhatsappMessageId),
  uniqueIndex("member_data_requests_expiring_unsub_token_unique").on(t.expiringReminderUnsubToken),
  uniqueIndex("member_data_requests_expiring_tracking_token_unique").on(t.expiringReminderTrackingToken),
  foreignKey({ name: "member_data_requests_last_in_app_message_id_fk", columns: [t.lastInAppMessageId], foreignColumns: [memberMessagesTable.id] }).onDelete("set null"),
]);

export type MemberProfileExt = typeof memberProfileExtTable.$inferSelect;
export type MemberDocument = typeof memberDocumentsTable.$inferSelect;
export type MemberConsent = typeof memberConsentsTable.$inferSelect;
export type MemberCommPref = typeof memberCommPrefsTable.$inferSelect;
export type MemberFamilyLink = typeof memberFamilyLinksTable.$inferSelect;
export type MemberLifecycleEvent = typeof memberLifecycleEventsTable.$inferSelect;
export type MemberDisciplinary = typeof memberDisciplinaryTable.$inferSelect;
export type MemberInternalNote = typeof memberInternalNotesTable.$inferSelect;
export type MemberAuditLog = typeof memberAuditLogTable.$inferSelect;
export type MemberLevy = typeof memberLeviesTable.$inferSelect;
export type MemberLevyCharge = typeof memberLevyChargesTable.$inferSelect;
export type MemberLevyChargeEvent = typeof memberLevyChargeEventsTable.$inferSelect;
export type MemberLevyReceiptAttempt = typeof memberLevyReceiptAttemptsTable.$inferSelect;
export type LevyLedgerEmailSchedule = typeof levyLedgerEmailSchedulesTable.$inferSelect;
export type LevyLedgerEmailRun = typeof levyLedgerEmailRunsTable.$inferSelect;
export type LevyLedgerEmailOrgSchedule = typeof levyLedgerEmailOrgSchedulesTable.$inferSelect;
export type LevyLedgerEmailOrgRun = typeof levyLedgerEmailOrgRunsTable.$inferSelect;
export type RevenueByCurrencyEmailSchedule = typeof revenueByCurrencyEmailSchedulesTable.$inferSelect;
export type RevenueByCurrencyEmailRun = typeof revenueByCurrencyEmailRunsTable.$inferSelect;
export type ForecastAccuracyEmailSchedule = typeof forecastAccuracyEmailSchedulesTable.$inferSelect;
export type ForecastAccuracyEmailRun = typeof forecastAccuracyEmailRunsTable.$inferSelect;
export type WalletTopupRefundEmailSchedule = typeof walletTopupRefundEmailSchedulesTable.$inferSelect;
export type WalletTopupRefundEmailRun = typeof walletTopupRefundEmailRunsTable.$inferSelect;
export type SideGameReceiptDigestSchedule = typeof sideGameReceiptDigestSchedulesTable.$inferSelect;
export type SideGameReceiptDigestRun = typeof sideGameReceiptDigestRunsTable.$inferSelect;
export type MemberMilestone = typeof memberMilestonesTable.$inferSelect;
export type MemberAccessCard = typeof memberAccessCardsTable.$inferSelect;
export type MemberAccessLog = typeof memberAccessLogTable.$inferSelect;
export type MemberCommitteeRole = typeof memberCommitteeRolesTable.$inferSelect;
export type MemberSavedSegment = typeof memberSavedSegmentsTable.$inferSelect;
export type MemberMessage = typeof memberMessagesTable.$inferSelect;
export type MemberDataRequest = typeof memberDataRequestsTable.$inferSelect;

/* ─────────────────────────────────────────────────────────────────────
 * Task #369 — Per-club marketing site builder
 *
 * One row per organization. Holds theme, hero, copy, gallery, SEO and
 * the section visibility/order map for the public mini-site rendered at
 * https://kharagolf.com/clubs/<slug>.
 *
 * `cacheVersion` is bumped on every save so the public route can serve
 * with a strong ETag and we can invalidate edge caches cheaply.
 * ───────────────────────────────────────────────────────────────────── */
export const clubMarketingSitesTable = pgTable("club_marketing_sites", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull().unique()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  theme: text("theme").notNull().default("classic"),
  heroImageUrl: text("hero_image_url"),
  heroTitle: text("hero_title"),
  heroSubtitle: text("hero_subtitle"),
  heroCtaLabel: text("hero_cta_label"),
  heroCtaHref: text("hero_cta_href"),
  aboutMarkdown: text("about_markdown"),
  servicesMarkdown: text("services_markdown"),
  // jsonb arrays — gallery is [{url, caption}], sectionOrder is [string],
  // enabledSections is { [sectionId]: boolean }.
  galleryImages: jsonb("gallery_images").$type<Array<{ url: string; caption?: string | null }>>().notNull().default(sql`'[]'::jsonb`),
  sectionOrder: jsonb("section_order").$type<string[]>().notNull().default(sql`'["hero","about","tournaments","lessons","tee_times","fb","gallery","services","contact"]'::jsonb`),
  enabledSections: jsonb("enabled_sections").$type<Record<string, boolean>>().notNull().default(sql`'{"hero":true,"about":true,"tournaments":true,"lessons":true,"tee_times":true,"fb":false,"gallery":true,"services":false,"contact":true}'::jsonb`),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  seoOgImageUrl: text("seo_og_image_url"),
  // Task #584 — per-site brand overrides layered on top of the chosen theme.
  // Null means "use the theme default". Colors are stored as #RRGGBB hex,
  // brandHeadingFont is a CSS font-family string (one of the allowed
  // FONT_OPTIONS in the editor / API validator).
  brandPrimaryColor: text("brand_primary_color"),
  brandAccentColor: text("brand_accent_color"),
  brandHeadingFont: text("brand_heading_font"),
  // Task #666 — Marketing-specific logo (shown in the public site header
  // in place of the org's generic logoUrl) and favicon (injected into the
  // public site's <head> as link rel="icon"). Null on either column means
  // "fall back to the org logo / platform default favicon".
  logoImageUrl: text("logo_image_url"),
  faviconUrl: text("favicon_url"),
  // Task #1249 — Background re-verification of saved external logo /
  // favicon URLs. Task #1089 verifies the URL at save time, but a host
  // that goes down a week later would silently break the public mini-site
  // until an admin happened to look. A daily sweep re-probes each saved
  // external URL with the same SSRF-guarded verifier and tracks a small
  // amount of state per column so we don't re-verify too often and don't
  // auto-clear on a single transient blip:
  //   - lastCheckedAt: when we last ran the verifier against the stored
  //     URL. The sweep skips rows checked within the last day so we
  //     batch progress across a large fleet.
  //   - consecutiveFailures: number of consecutive failed verifications.
  //     Resets to 0 on a successful verification or when the admin saves
  //     a new URL through the editor. Once this reaches the auto-clear
  //     threshold (3 ≈ 3 days at the daily cadence) the cron clears the
  //     URL, bumps cacheVersion so visitors stop loading the broken
  //     reference, and emails the org admins so they can paste a working
  //     URL.
  //   - lastError: human-readable error from the last failed
  //     verification (e.g. "image host returned HTTP 404"). Surfaced in
  //     the admin email so on-call has the failure mode without opening
  //     the verifier logs.
  // Internal /objects/... paths are skipped by the sweep — they live in
  // our own object storage and are validated by the editor's content-type
  // check (Task #948) instead.
  logoImageUrlLastCheckedAt: timestamp("logo_image_url_last_checked_at", { withTimezone: true }),
  logoImageUrlConsecutiveFailures: integer("logo_image_url_consecutive_failures").notNull().default(0),
  logoImageUrlLastError: text("logo_image_url_last_error"),
  faviconUrlLastCheckedAt: timestamp("favicon_url_last_checked_at", { withTimezone: true }),
  faviconUrlConsecutiveFailures: integer("favicon_url_consecutive_failures").notNull().default(0),
  faviconUrlLastError: text("favicon_url_last_error"),
  // Task #1467 — Periodic refresh of cached marketing logos / favicons.
  // Task #1250 snapshots the bytes from an admin-supplied external URL
  // into our own object storage at save time; the persisted
  // `logoImageUrl` / `faviconUrl` then points at the cached internal
  // /api/storage/... URL. But if the source image at the original URL
  // changes (e.g. the club rebrands), the cached copy goes stale.
  // We track the original external URL alongside the cached one so a
  // background job can periodically re-fetch it and rotate the cache
  // when the bytes differ. Internal /objects/... paths and direct
  // uploads have no `*SourceUrl` set and are skipped by the refresh
  // job — there is no upstream to compare against.
  //   - sourceUrl: the original http(s) URL the admin pasted in. NULL
  //     for direct uploads / internal paths or for legacy rows saved
  //     before this column existed.
  //   - sourceLastRefreshedAt: when the refresh job last attempted to
  //     re-download the source URL. The job uses this for a per-row
  //     backoff (~weekly cadence) so it can be polled aggressively
  //     without hammering third-party hosts.
  //   - sourceLastRefreshError: human-readable error from the most
  //     recent failed refresh (or NULL on success). The cached copy
  //     is preserved on failure — this column only records that we
  //     tried, so admins / on-call can see why the cache is stale.
  logoSourceUrl: text("logo_source_url"),
  logoSourceLastRefreshedAt: timestamp("logo_source_last_refreshed_at", { withTimezone: true }),
  logoSourceLastRefreshError: text("logo_source_last_refresh_error"),
  faviconSourceUrl: text("favicon_source_url"),
  faviconSourceLastRefreshedAt: timestamp("favicon_source_last_refreshed_at", { withTimezone: true }),
  faviconSourceLastRefreshError: text("favicon_source_last_refresh_error"),
  // Task #2259 — Email admins automatically when a logo / favicon source URL
  // stops refreshing. The Task #1467 refresh job preserves the cached copy
  // when the upstream source is unreachable so the public mini-site keeps
  // rendering, but admins only saw the staleness if they happened to open
  // the marketing-site editor (Task #1807). These counters mirror the
  // Task #1249 `*ConsecutiveFailures` columns: incremented on every failed
  // refresh attempt (verifier !ok, verifier throw, storage write failure)
  // and reset to 0 on a successful refresh OR when the admin pastes a new
  // URL through the editor. Once a counter reaches the notify threshold
  // (`MARKETING_IMAGE_REFRESH_NOTIFY_FAILURE_THRESHOLD`, 3 ≈ 3 weeks at
  // the weekly per-source backoff) the cron emails + pushes the org admins
  // exactly once with the failing source host and the verifier error so a
  // stale cached logo gets fixed without anyone needing to open the editor.
  // Subsequent failures keep the counter climbing but DON'T re-notify so
  // admins aren't spammed; a successful refresh (or a fresh URL through the
  // editor) re-arms the counter for the next streak.
  logoSourceConsecutiveRefreshFailures: integer("logo_source_consecutive_refresh_failures").notNull().default(0),
  faviconSourceConsecutiveRefreshFailures: integer("favicon_source_consecutive_refresh_failures").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(false),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  cacheVersion: integer("cache_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClubMarketingSite = typeof clubMarketingSitesTable.$inferSelect;

/* ─────────────────────────────────────────────────────────────────────
 * Task #579 — Marketing-site image library
 *
 * Tracks every image admins have uploaded through the marketing-site
 * editor so they can browse and reuse previously uploaded photos
 * instead of re-uploading the same file when swapping hero/gallery
 * images. One row per (organization, objectPath) — registering the
 * same upload twice is a no-op.
 * ───────────────────────────────────────────────────────────────────── */
export const clubMarketingSiteImagesTable = pgTable(
  "club_marketing_site_images",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    objectPath: text("object_path").notNull(),
    url: text("url").notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    uploadedByUserId: integer("uploaded_by_user_id").references(
      () => appUsersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    orgObjectUq: uniqueIndex("club_marketing_site_images_org_object_uq").on(
      t.organizationId,
      t.objectPath,
    ),
    orgCreatedIdx: index("club_marketing_site_images_org_created_idx").on(
      t.organizationId,
      t.createdAt,
    ),
  }),
);

export type ClubMarketingSiteImage =
  typeof clubMarketingSiteImagesTable.$inferSelect;

// ─── TASK #367: DYNAMIC PRICING & YIELD MANAGEMENT ──────────────────────────

export const teePricingTierMemberTypeEnum = pgEnum("tee_pricing_tier_member_type", [
  "any", "member", "guest",
]);

export const teePricingModifierKindEnum = pgEnum("tee_pricing_modifier_kind", [
  "utilization", "lead_time", "weather",
]);

export const teePricingAdjustmentTypeEnum = pgEnum("tee_pricing_adjustment_type", [
  "percent", "flat",
]);

/** Pricing tiers — base rates by day-of-week / time-of-day / season / member type */
export const teeDynamicPricingTiersTable = pgTable("tee_dynamic_pricing_tiers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull().default([0,1,2,3,4,5,6]),
  startTime: text("start_time"),
  endTime: text("end_time"),
  seasonStart: text("season_start"),
  seasonEnd: text("season_end"),
  memberType: teePricingTierMemberTypeEnum("member_type").notNull().default("any"),
  memberRate: numeric("member_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  guestRate: numeric("guest_rate", { precision: 10, scale: 2 }).notNull().default("0"),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_dyn_pricing_tiers_org_idx").on(t.organizationId),
  index("tee_dyn_pricing_tiers_active_idx").on(t.organizationId, t.isActive),
]);

/** Demand modifiers — utilization / lead-time / weather adjustments on top of tier */
export const teeDynamicPricingModifiersTable = pgTable("tee_dynamic_pricing_modifiers", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: teePricingModifierKindEnum("kind").notNull(),
  thresholdMin: numeric("threshold_min", { precision: 10, scale: 2 }),
  thresholdMax: numeric("threshold_max", { precision: 10, scale: 2 }),
  weatherCondition: text("weather_condition"),
  adjustmentType: teePricingAdjustmentTypeEnum("adjustment_type").notNull().default("percent"),
  adjustmentValue: numeric("adjustment_value", { precision: 10, scale: 2 }).notNull().default("0"),
  applyTo: teePricingTierMemberTypeEnum("apply_to").notNull().default("any"),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_dyn_pricing_mods_org_idx").on(t.organizationId),
  foreignKey({ name: "tee_dynamic_pricing_modifiers_organization_id_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

/** Per-org dynamic pricing config — caps/floors and feature toggle */
export const teeDynamicPricingConfigTable = pgTable("tee_dynamic_pricing_config", {
  organizationId: integer("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  priceFloorPct: numeric("price_floor_pct", { precision: 5, scale: 2 }).notNull().default("0.50"),
  priceCeilingPct: numeric("price_ceiling_pct", { precision: 5, scale: 2 }).notNull().default("2.00"),
  dealBadgeThresholdPct: numeric("deal_badge_threshold_pct", { precision: 5, scale: 2 }).notNull().default("0.85"),
  // Per-segment price-elasticity defaults — task #729 + task #730. Members
  // are typically far less price-sensitive than walk-in guests, so we store
  // (and seed) distinct defaults per segment.
  defaultMemberElasticity: numeric("default_member_elasticity", { precision: 4, scale: 2 }).notNull().default("-0.20"),
  defaultGuestElasticity: numeric("default_guest_elasticity", { precision: 4, scale: 2 }).notNull().default("-0.70"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-course elasticity overrides — Task #822. Lets admins tune the
 * price-sensitivity assumption used by the forecast on a per-course basis,
 * because resort, municipal, and members-only courses behave very
 * differently. When a forecast request supplies a `courseId` and a row
 * exists here, the saved values take precedence over the org-level default
 * (still falling back to the org default and then the system default if
 * unset). Either column may be NULL to inherit only one segment from the
 * org default while overriding the other.
 */
export const teeDynamicPricingCourseElasticityTable = pgTable("tee_dynamic_pricing_course_elasticity", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  courseId: integer("course_id").notNull(),
  memberElasticity: numeric("member_elasticity", { precision: 4, scale: 2 }),
  guestElasticity: numeric("guest_elasticity", { precision: 4, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("tee_dyn_pricing_course_elasticity_org_course_unique").on(t.organizationId, t.courseId),
  index("tee_dyn_pricing_course_elasticity_org_idx").on(t.organizationId),
  // Task #805: explicit short FK names so neither generated identifier
  // exceeds Postgres's 63-char limit (the table name alone is 38 chars).
  foreignKey({
    name: "tee_dyn_pricing_course_elasticity_org_fk",
    columns: [t.organizationId], foreignColumns: [organizationsTable.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "tee_dyn_pricing_course_elasticity_course_fk",
    columns: [t.courseId], foreignColumns: [coursesTable.id],
  }).onDelete("cascade"),
]);

/** Audit log — every activation, change, rollback, or pricing decision */
export const teeDynamicPricingAuditTable = pgTable("tee_dynamic_pricing_audit", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  actorUserId: integer("actor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  payload: jsonb("payload"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_dyn_pricing_audit_org_idx").on(t.organizationId, t.createdAt),
  index("tee_dyn_pricing_audit_entity_idx").on(t.entityType, t.entityId),
]);

export type TeeDynamicPricingTier = typeof teeDynamicPricingTiersTable.$inferSelect;
export type TeeDynamicPricingModifier = typeof teeDynamicPricingModifiersTable.$inferSelect;
export type TeeDynamicPricingConfig = typeof teeDynamicPricingConfigTable.$inferSelect;
export type TeeDynamicPricingCourseElasticity = typeof teeDynamicPricingCourseElasticityTable.$inferSelect;
export type TeeDynamicPricingAudit = typeof teeDynamicPricingAuditTable.$inferSelect;

/**
 * Task #821 — Persisted forecast snapshots so admins can compare prior
 * projections to realised revenue and judge how trustworthy the
 * forecast endpoint has been historically.
 *
 * Each row captures the projected numbers, the assumptions that
 * produced them, and the date window the forecast covered. Once that
 * window has fully elapsed we can join to `tee_bookings` to compute
 * realised revenue and an accuracy percentage.
 */
export const teePricingForecastsTable = pgTable("tee_pricing_forecasts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").references(() => coursesTable.id, { onDelete: "set null" }),
  actorUserId: integer("actor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  scenario: text("scenario").notNull().default("active"),
  label: text("label"),
  horizonDays: integer("horizon_days").notNull(),
  windowStart: date("window_start").notNull(),
  windowEnd: date("window_end").notNull(),
  projectedRevenue: numeric("projected_revenue", { precision: 14, scale: 2 }).notNull().default("0"),
  projectedAvgPrice: numeric("projected_avg_price", { precision: 12, scale: 2 }).notNull().default("0"),
  projectedSeatsBooked: integer("projected_seats_booked").notNull().default(0),
  projectedSeatsTotal: integer("projected_seats_total").notNull().default(0),
  // Task #1263 — per-day projected revenue captured at snapshot time so the
  // forecast-accuracy drill-down can compare actuals against the day-level
  // expectations the forecaster actually produced (weekends, tier overrides,
  // etc.) instead of attributing the projected total evenly across the
  // horizon. Stored as a sorted array of `{ day: 'YYYY-MM-DD', revenue }`
  // entries; days the forecaster expected no slots on are simply omitted
  // (the drill-down treats missing days as a 0 projection). Null on rows
  // written before this column existed — the drill-down falls back to the
  // legacy flat-distribution behaviour in that case.
  projectedRevenueByDay: jsonb("projected_revenue_by_day").$type<{ day: string; revenue: number }[]>(),
  assumptions: jsonb("assumptions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tee_pricing_forecasts_org_idx").on(t.organizationId, t.windowEnd),
  index("tee_pricing_forecasts_course_idx").on(t.courseId, t.windowEnd),
]);

export type TeePricingForecast = typeof teePricingForecastsTable.$inferSelect;

// ─── TASK #361: PHOTO-TO-VIDEO HIGHLIGHT REELS ───────────────────────────────

export const highlightReelStatusEnum = pgEnum("highlight_reel_status", [
  "queued", "rendering", "ready", "failed",
]);

export const highlightReelsTable = pgTable("highlight_reels", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "set null" }),
  templateId: text("template_id").notNull().default("classic"),
  title: text("title").notNull().default("Round Highlights"),
  // Free-form options the player can tweak: { caption, music, includedShotIds: number[],
  // includedMediaIds: number[], stickers: any[] }
  options: jsonb("options").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  // Snapshot of the round summary used at render time
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  status: highlightReelStatusEnum("status").notNull().default("queued"),
  errorMessage: text("error_message"),
  outputObjectPath: text("output_object_path"),
  thumbnailPath: text("thumbnail_path"),
  durationSeconds: integer("duration_seconds"),
  feedPostId: integer("feed_post_id").references(() => feedPostsTable.id, { onDelete: "set null" }),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  renderStartedAt: timestamp("render_started_at", { withTimezone: true }),
  renderCompletedAt: timestamp("render_completed_at", { withTimezone: true }),
  // Worker queue bookkeeping (Task #418): renders run in a separate worker
  // process that polls highlight_reels for status='queued' rows whose
  // next_attempt_at <= now(). `attempts` counts how many times we have tried
  // to render; failures are scheduled for exponential-backoff retry up to
  // a small cap before being marked permanently 'failed'.
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("highlight_reels_user_idx").on(t.userId),
  index("highlight_reels_org_idx").on(t.organizationId),
  index("highlight_reels_status_idx").on(t.status),
  index("highlight_reels_created_idx").on(t.createdAt),
  // Worker queue lookup: quickly find the oldest queued job ready to run.
  index("highlight_reels_queue_idx").on(t.status, t.nextAttemptAt),
]);

export type HighlightReel = typeof highlightReelsTable.$inferSelect;

// One row per render attempt (initial render + each re-render). Used for
// per-tier monthly quota enforcement so that re-renders cost quota too.
export const highlightRenderEventsTable = pgTable("highlight_render_events", {
  id: serial("id").primaryKey(),
  reelId: integer("reel_id").notNull().references(() => highlightReelsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull().default("create"), // "create" | "rerender"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("highlight_render_events_user_org_idx").on(t.userId, t.organizationId, t.createdAt),
  index("highlight_render_events_reel_idx").on(t.reelId),
]);

export type HighlightRenderEvent = typeof highlightRenderEventsTable.$inferSelect;

// Task #544 — Track which highlight reels members download or share so
// producers can see which content resonates. One row per engagement event;
// counts are derived with COUNT(*) GROUP BY reel_id at read time.
// Task #708 — also track in-feed views ("view") and re-shares from the feed
// surface ("feed_share") so producers can see the full engagement story
// (not just downloads + share-sheet hand-offs from the highlights gallery).
export const highlightReelEngagementTypeEnum = pgEnum("highlight_reel_engagement_type", [
  "download", "share", "view", "feed_share",
]);

export const highlightReelEngagementsTable = pgTable("highlight_reel_engagements", {
  id: serial("id").primaryKey(),
  reelId: integer("reel_id").notNull().references(() => highlightReelsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  // Nullable so that future, unauthenticated public-share contexts could log
  // an event without a user attached. Today the API requires auth.
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  eventType: highlightReelEngagementTypeEnum("event_type").notNull(),
  source: text("source"), // "mobile" | "web" — best-effort, client-supplied
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("highlight_reel_engagements_reel_idx").on(t.reelId),
  index("highlight_reel_engagements_reel_type_idx").on(t.reelId, t.eventType),
  index("highlight_reel_engagements_org_created_idx").on(t.organizationId, t.createdAt),
]);

export type HighlightReelEngagement = typeof highlightReelEngagementsTable.$inferSelect;

// Task #698 — Saved caption-style templates. When a player favorites an
// auto-generated caption chip in the highlight reel editor, we store the
// pattern (e.g. "Hole {hole} · {club} · {carry}y") plus the ordered list of
// token keys it expects. Future suggestions for shots that have the same
// set of tokens are rendered through the saved pattern so captions feel
// consistent with the player's preferred style.
export const highlightCaptionTemplatesTable = pgTable("highlight_caption_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  // Org context is best-effort — captions don't really care which org the
  // template was first saved from. Nullable + onDelete: set null so a
  // template survives if the player leaves an org.
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  pattern: text("pattern").notNull(),
  tokenKeys: jsonb("token_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Snapshot of the caption text at the moment it was favorited — useful
  // for showing the user a preview of "what this template looks like".
  sampleCaption: text("sample_caption").notNull(),
  useCount: integer("use_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("highlight_caption_templates_user_idx").on(t.userId),
  uniqueIndex("highlight_caption_templates_user_pattern_uniq").on(t.userId, t.pattern),
]);

export type HighlightCaptionTemplate = typeof highlightCaptionTemplatesTable.$inferSelect;

// Task #625 — Track how often members share their public profile.
// One row per share action fired by the privacy/share UI on the web
// portal and the mobile portal-privacy screen. Counts are derived with
// COUNT(*) GROUP BY method at read time. The handle is captured as
// a snapshot string so analytics survive a member later renaming or
// releasing the handle.
export const profileShareMethodEnum = pgEnum("profile_share_method", [
  "copy", "web_share", "native_share", "qr_open",
]);

export const profileShareEventsTable = pgTable("profile_share_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  handle: text("handle").notNull(),
  method: profileShareMethodEnum("method").notNull(),
  source: text("source"), // "web" | "mobile" — best-effort, client-supplied
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("profile_share_events_user_idx").on(t.userId),
  index("profile_share_events_handle_idx").on(t.handle),
  index("profile_share_events_user_method_idx").on(t.userId, t.method),
  index("profile_share_events_created_idx").on(t.createdAt),
]);

export type ProfileShareEvent = typeof profileShareEventsTable.$inferSelect;


// Task #1259 — Daily-aggregate rollup for profile_share_events.
// Mirrors the badge_share_daily_aggregates pattern (Task #1096): the raw
// `profile_share_events` table grows one row per share click and has no
// natural pruning point, so a viral handle eventually balloons it. The
// scheduled rollup (`pruneAndRollupProfileShareEvents` in the API server)
// summarises events older than the rollup window into one row per
// (user_id, method, source, day) here and then deletes the raw events.
// Read paths (public share-stats, portal share-stats, admin profile-share
// leaderboard) UNION raw events with these aggregates so totals stay
// correct after rollup. We key on user_id rather than handle because
// every read path scopes shares to a user — if a member renames their
// handle, those events keep aggregating into the same user's bucket. Day
// is at UTC midnight to match the rollup job's bucketing of `created_at`.
//
// Task #1781 — `source` is part of the primary key so the per-day rollup
// preserves the web-vs-mobile breakdown for events older than the rollup
// window. Stored as a NOT NULL text column with a sentinel `'unknown'`
// for events whose `source` was NULL on the raw table (legacy rows from
// before mobile-source tagging existed). Read paths for `bySource`
// intentionally exclude `'unknown'` so the split only reflects events
// that were actually tagged at write time.
export const profileShareDailyAggregatesTable = pgTable("profile_share_daily_aggregates", {
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  method: profileShareMethodEnum("method").notNull(),
  source: text("source").notNull().default("unknown"),
  day: timestamp("day", { withTimezone: true, mode: "date" }).notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.userId, t.method, t.day, t.source] }),
  index("profile_share_daily_aggregates_user_idx").on(t.userId),
  index("profile_share_daily_aggregates_day_idx").on(t.day),
]);

export type ProfileShareDailyAggregate = typeof profileShareDailyAggregatesTable.$inferSelect;


// Task #1474 — Last-run state for the daily profile_share rollup so the
// super-admin storage-savings panel survives API restarts (the rollup
// only writes a log line otherwise). Mirrors `badge_share_rollup_runs`
// (Task #1260) so the same panel can render both side by side. Singleton
// row keyed on `id = 1`; the rollup UPSERTs onto that PK at the end of
// every successful run.
export const profileShareRollupRunsTable = pgTable("profile_share_rollup_runs", {
  id: integer("id").primaryKey().default(1),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  rolledUpEvents: integer("rolled_up_events").notNull().default(0),
  upsertedAggregateRows: integer("upserted_aggregate_rows").notNull().default(0),
  prunedAggregateRows: integer("pruned_aggregate_rows").notNull().default(0),
});

export type ProfileShareRollupRun = typeof profileShareRollupRunsTable.$inferSelect;

// Task #2261 — Append-only audit log of every "the daily profile-share
// rollup has been silent for too long" notification email the
// auto-pager (`runProfileShareRollupStaleOpsAlertJob`, Task #1813)
// actually sent out.
//
// Two concerns rolled into one table, mirroring the
// `manual_entry_alert_page_history` (Task #1665) and
// `stripe_webhook_sweep_stale_alerts` (Task #1883) shapes:
//
//   1. Cross-restart, cross-replica debounce. The auto-pager gates on
//      the most recent `paged_at` here, so a sustained outage paged at
//      09:00 does not page again at 10:00, 11:00, ... — even across a
//      deploy that lands inside the cooldown window or across multiple
//      cron processes racing. The previous in-process timestamp gate
//      let a rolling restart re-page on-call; promoting the state to
//      the DB closes that hole. Mirrors the singleton-cooldown pattern
//      in `badge_share_rollup_ops_alerts` (Task #1814) but appends per
//      page so we also get history.
//
//   2. Operator visibility. The super-admin `/super-admin/profile-share-rollup`
//      panel reads this table to render a "Recent ops alerts" feed so a
//      super-admin can tell at a glance whether on-call has already
//      been paged about a current outage and when, mirroring the
//      sibling badge-share rollup variant.
//
// One row is inserted only when the auto-pager actually sent at least
// one email (i.e. the cooldown gate passed AND ≥1 recipient was
// reached). Skipped runs (`not_stale`, `no_raw_events`, `in_cooldown`,
// `no_recipients`, `send_failed`) leave no row, so the panel only ever
// shows real pages.
export const profileShareRollupOpsAlertsTable = pgTable("profile_share_rollup_ops_alerts", {
  id: serial("id").primaryKey(),
  pagedAt: timestamp("paged_at", { withTimezone: true }).notNull().defaultNow(),
  // Snapshot of the trigger state so a postmortem can answer "what
  // did the panel look like at the moment we paged?" without
  // back-correlating to the rollup table.
  lastRunRanAt: timestamp("last_run_ran_at", { withTimezone: true }),
  rollupAgeMs: integer("rollup_age_ms").notNull(),
  staleThresholdMs: integer("stale_threshold_ms").notNull(),
  currentRawEventCount: integer("current_raw_event_count").notNull().default(0),
  currentAggregateRowCount: integer("current_aggregate_row_count").notNull().default(0),
  // Captured cooldown so the cooldown explainer in the UI stays
  // accurate even if an admin later tweaks the env var.
  cooldownHours: numeric("cooldown_hours", { precision: 6, scale: 2 }).notNull(),
  // Aggregate fan-out + the actual recipient list so support can
  // confirm a specific address received the page without rerunning
  // the lookup.
  recipientCount: integer("recipient_count").notNull().default(0),
  recipientEmails: text("recipient_emails").array().notNull().default(sql`ARRAY[]::text[]`),
}, (t) => [
  index("profile_share_rollup_ops_alerts_paged_at_idx").on(t.pagedAt),
]);

export type ProfileShareRollupOpsAlert = typeof profileShareRollupOpsAlertsTable.$inferSelect;


// Task #926 — Track how often each individual badge is shared.
// Mirrors `profile_share_events` but identifies the badge being shared
// rather than only the profile owner. The owner is captured as a handle
// snapshot so analytics survive a member later renaming or releasing
// their handle. Anonymous viewers can fire share events too (the public
// badge page exposes copy/native share to anyone with the link), so
// there is intentionally no userId column — events are attributed to
// the badge owner via handle. Per-badge counts are derived with
// COUNT(*) GROUP BY badge_type at read time.
export const badgeShareMethodEnum = pgEnum("badge_share_method", [
  "copy", "web_share", "native_share",
]);

export const badgeShareEventsTable = pgTable("badge_share_events", {
  id: serial("id").primaryKey(),
  handle: text("handle").notNull(),
  badgeType: text("badge_type").notNull(),
  method: badgeShareMethodEnum("method").notNull(),
  source: text("source"), // "web" | "mobile" — best-effort, server-validated
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("badge_share_events_handle_idx").on(t.handle),
  index("badge_share_events_badge_idx").on(t.badgeType),
  index("badge_share_events_handle_badge_idx").on(t.handle, t.badgeType),
  index("badge_share_events_created_idx").on(t.createdAt),
]);

export type BadgeShareEvent = typeof badgeShareEventsTable.$inferSelect;


// Task #1096 — Daily-aggregate rollup for badge_share_events.
// The raw `badge_share_events` table grows one row per share click and
// has no natural pruning point: a viral badge can rack up millions of
// rows over a year. We summarise events older than the rollup window
// (see `pruneAndRollupBadgeShareEvents` in the API server) into one
// row per (handle, badge_type, method, day) here and then delete the
// raw events. Read-side queries (portal stats + admin leaderboard)
// UNION the raw events with these aggregates so totals stay correct
// after rollup. Keeping the day at UTC midnight matches how the
// rollup job buckets `created_at`.
export const badgeShareDailyAggregatesTable = pgTable("badge_share_daily_aggregates", {
  handle: text("handle").notNull(),
  badgeType: text("badge_type").notNull(),
  method: badgeShareMethodEnum("method").notNull(),
  day: timestamp("day", { withTimezone: true, mode: "date" }).notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.handle, t.badgeType, t.method, t.day] }),
  index("badge_share_daily_aggregates_handle_idx").on(t.handle),
  index("badge_share_daily_aggregates_day_idx").on(t.day),
]);

export type BadgeShareDailyAggregate = typeof badgeShareDailyAggregatesTable.$inferSelect;


// Task #1260 — Last-run state for the daily badge_share rollup so the
// super-admin storage-savings panel survives API restarts (the rollup
// only writes a log line otherwise). Singleton row keyed on `id = 1`;
// the rollup UPSERTs onto that PK at the end of every successful run.
export const badgeShareRollupRunsTable = pgTable("badge_share_rollup_runs", {
  id: integer("id").primaryKey().default(1),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  rolledUpEvents: integer("rolled_up_events").notNull().default(0),
  upsertedAggregateRows: integer("upserted_aggregate_rows").notNull().default(0),
  prunedAggregateRows: integer("pruned_aggregate_rows").notNull().default(0),
});

export type BadgeShareRollupRun = typeof badgeShareRollupRunsTable.$inferSelect;


// Task #1821 — Append-only per-run history for the badge_share rollup
// so the super-admin storage-savings panel can render a 7-day trend
// sparkline of the savings percent / compression ratio. The singleton
// `badge_share_rollup_runs` row above is overwritten on every run and
// has no history to chart from, so this table captures one row per
// successful run with the savings KPIs the panel displays.
//
// `savingsPercent` / `savingsRatio` mirror the shape of
// `ShareRollupStorageSavings` and are nullable for the same reason —
// the rollup may have run without yet collapsing any events (no
// aggregates), in which case the panel renders the point as "no data".
//
// Retention is bounded by `MAX_RUN_HISTORY_AGE_MS` in
// `badgeShareRollup.ts` (>= 30 days, well above the 7-day default
// sparkline window) so the table stays small even if the cron's
// daily cadence ever increases.
export const badgeShareRollupRunHistoryTable = pgTable("badge_share_rollup_run_history", {
  id: serial("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  currentRawEventCount: integer("current_raw_event_count").notNull().default(0),
  currentAggregateRowCount: integer("current_aggregate_row_count").notNull().default(0),
  aggregatedEventCount: integer("aggregated_event_count").notNull().default(0),
  savingsPercent: numeric("savings_percent", { precision: 6, scale: 3 }),
  savingsRatio: numeric("savings_ratio", { precision: 12, scale: 3 }),
}, (t) => [
  index("badge_share_rollup_run_history_ran_at_idx").on(t.ranAt),
]);

export type BadgeShareRollupRunHistoryEntry = typeof badgeShareRollupRunHistoryTable.$inferSelect;


// Task #1814 — Persisted cooldown / last-paged-at state for the
// `runBadgeShareRollupStaleOpsAlertJob` (Task #1478) auto-page job.
//
// The alert job previously gated repeat pages with an in-process
// timestamp, which had two problems we now fix in one place:
//   1. A process restart inside the cooldown window let the job
//      re-page on-call. Rare, but a measurable false-alarm source on
//      deploy days.
//   2. The super-admin badge-share-rollup panel had no way to show
//      whether/when the auto-pager had actually fired — admins couldn't
//      correlate the loud red banner with the email they received
//      without grepping inboxes or logs.
//
// Promoting the cooldown state to a singleton table (PK `id = 1`,
// UPSERT) closes both gaps: a single process owns the source of truth
// across restarts, and the admin summary reads `last_alerted_at` to
// render a "Last ops alert: 2h ago" line under the cooldown window.
//
// We keep this in its own table (rather than tacking a column onto
// `badge_share_rollup_runs`) because the rollup itself UPSERTs that
// row at the end of every successful run — co-locating the alert
// timestamp would mean the rollup either has to read-then-write to
// preserve it, or accidentally clobbers it. A separate singleton has
// no such coupling and mirrors the pattern used for other ops-state
// singletons in the schema.
export const badgeShareRollupOpsAlertsTable = pgTable("badge_share_rollup_ops_alerts", {
  id: integer("id").primaryKey().default(1),
  lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }).notNull(),
});

export type BadgeShareRollupOpsAlert = typeof badgeShareRollupOpsAlertsTable.$inferSelect;


// Task #1798 — Track how often a shared badge link converts into a real
// visit to the member's public-profile/badge page. The Badge Share
// Leaderboard already tells admins which badges drive the most outbound
// share clicks (`badge_share_events` — the share button being pressed),
// but until now there was no way to tell whether those shares actually
// pulled visitors back to the profile. One row is inserted per visit to
// the `/p/<handle>/badge/<type>` web page (fired client-side from the
// public-badge React component on mount, fire-and-forget). The handle
// is captured as a snapshot string so analytics survive a later rename.
//
// Columns mirror `badge_share_events` so the analytics endpoints can
// JOIN visits to share counts on `(handle, badge_type)` and compute a
// per-badge "shares → visits" conversion ratio. `source` records where
// the visit landed from:
//   - "web"          — browser hit on the public badge web page
//   - "mobile"       — in-app webview (rare today, future-proofing)
//   - "crawler"      — User-Agent matched a known social crawler — these
//                      are excluded from the conversion ratio because
//                      they are link-preview renders, not human visits
//   - "unknown"      — direct hit / unknown UA
// The badge-share-leaderboard endpoints filter `source != 'crawler'`
// so the conversion rate reflects human eyeballs only.
export const badgeShareVisitEventsTable = pgTable("badge_share_visit_events", {
  id: serial("id").primaryKey(),
  handle: text("handle").notNull(),
  badgeType: text("badge_type").notNull(),
  source: text("source").notNull().default("unknown"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("badge_share_visit_events_handle_idx").on(t.handle),
  index("badge_share_visit_events_badge_idx").on(t.badgeType),
  index("badge_share_visit_events_handle_badge_idx").on(t.handle, t.badgeType),
  index("badge_share_visit_events_created_idx").on(t.createdAt),
]);

export type BadgeShareVisitEvent = typeof badgeShareVisitEventsTable.$inferSelect;


// Task #2255 — Daily-aggregate rollup for badge_share_visit_events.
// Mirrors the badge_share_events → badge_share_daily_aggregates pattern
// (Task #1096) so the visit-event table cannot grow unbounded as
// public-badge pages keep firing one row per page view. The
// `pruneAndRollupBadgeShareVisitEvents` job in the API server
// summarises rows older than the rollup window (30 days) into one row
// per (handle, badge_type, source, day) here and then deletes the raw
// events. The badge-share-leaderboard endpoints UNION the raw events
// with these aggregates so the totals (and the conversion-rate ratio
// derived from them) stay correct after rollup. `source` is preserved
// in the bucketing key so the read-side can keep filtering out
// `source = 'crawler'` rows (link-preview renders, not human visits).
export const badgeShareVisitDailyAggregatesTable = pgTable("badge_share_visit_daily_aggregates", {
  handle: text("handle").notNull(),
  badgeType: text("badge_type").notNull(),
  source: text("source").notNull().default("unknown"),
  day: timestamp("day", { withTimezone: true, mode: "date" }).notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.handle, t.badgeType, t.source, t.day] }),
  index("badge_share_visit_daily_aggregates_handle_idx").on(t.handle),
  index("badge_share_visit_daily_aggregates_day_idx").on(t.day),
]);

export type BadgeShareVisitDailyAggregate = typeof badgeShareVisitDailyAggregatesTable.$inferSelect;


// Task #1281 — Track how often the public Year-in-Golf recap link is hit.
// One row per request to either /api/public/recap/:handle/card.png (the
// social-card PNG used as og:image and as the save-to-camera-roll
// fallback) or /api/public/recap/:handle/og (the Open-Graph HTML stub
// that crawlers and humans both land on). The handle is captured as a
// snapshot string so analytics survive a member later renaming or
// releasing the handle, and `userId` is also stored so org-scoped reads
// keep working through renames.
//
// The dimensions on each event mirror what the share URL carries
// (`year`, `period`) plus how the link was distributed (`source`):
//   - `copy`         — copy-link button on web/mobile share UI
//   - `web_share`    — Web Share API on the web portal
//   - `native_share` — native iOS/Android share sheet on mobile
//   - `qr_open`      — QR-code scan on the privacy-share screen
//   - `crawler`      — User-Agent matched a known social-media crawler
//                      (facebook, twitter, slack, whatsapp, telegram,
//                      discord, linkedin, googlebot, bingbot, …)
//   - `unknown`      — direct hit with no identifying ?via= param and
//                      no recognised crawler UA (e.g. someone pasted
//                      the link directly into the address bar)
// Counts are derived with COUNT(*) GROUP BY at read time and surfaced
// via the portal share-stats endpoint so the player can see how many
// times their public recap card has been viewed.
export const recapShareEventsTable = pgTable("recap_share_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  handle: text("handle").notNull(),
  asset: text("asset").notNull(),       // 'card_png' | 'og'
  period: text("period").notNull(),     // 'year' | 'q1' | 'q2' | 'q3' | 'q4'
  year: integer("year").notNull(),
  source: text("source").notNull().default("unknown"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("recap_share_events_user_idx").on(t.userId),
  index("recap_share_events_handle_idx").on(t.handle),
  index("recap_share_events_user_asset_idx").on(t.userId, t.asset),
  index("recap_share_events_created_idx").on(t.createdAt),
]);

export type RecapShareEvent = typeof recapShareEventsTable.$inferSelect;


// Task #1281 — Daily-aggregate rollup for `recap_share_events`. Same
// rationale as the badge / profile share rollups (Tasks #1096 / #1259):
// the raw events table grows one row per recap link hit (including
// social-media crawlers, which can fan out one share into many fetches)
// and has no natural pruning point. The scheduled rollup
// (`pruneAndRollupRecapShareEvents`) summarises events older than the
// rollup window into one row per (user_id, asset, period, year, source,
// day) here and then deletes the raw events. Read paths UNION raw
// events with these aggregates so totals stay correct across the
// rollup boundary. Day is at UTC midnight to match the rollup job's
// bucketing of `created_at`.
export const recapShareDailyAggregatesTable = pgTable("recap_share_daily_aggregates", {
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  asset: text("asset").notNull(),
  period: text("period").notNull(),
  year: integer("year").notNull(),
  source: text("source").notNull().default("unknown"),
  day: timestamp("day", { withTimezone: true, mode: "date" }).notNull(),
  count: integer("count").notNull().default(0),
}, (t) => [
  primaryKey({ name: "recap_share_daily_aggregates_pk", columns: [t.userId, t.asset, t.period, t.year, t.source, t.day] }),
  index("recap_share_daily_aggregates_user_idx").on(t.userId),
  index("recap_share_daily_aggregates_day_idx").on(t.day),
]);

export type RecapShareDailyAggregate = typeof recapShareDailyAggregatesTable.$inferSelect;


/* ────────────────────────────────────────────────────────────────────
 * TASK #380 — Coach Marketplace + Swing Video Feature
 * ────────────────────────────────────────────────────────────────── */

export const swingViewEnum = pgEnum("swing_view", ["dtl", "fo", "side", "behind", "other"]);
export const swingReviewStatusEnum = pgEnum("swing_review_status", [
  "pending_payment", "paid", "in_review", "delivered", "refunded", "expired",
]);
export const coachPayoutStatusEnum = pgEnum("coach_payout_status", [
  "pending", "processing", "paid", "failed",
]);

// Marketplace profile extending teaching_pros with public-marketplace fields
export const coachMarketplaceProfilesTable = pgTable("coach_marketplace_profiles", {
  id: serial("id").primaryKey(),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  isListed: boolean("is_listed").notNull().default(false),
  certifications: jsonb("certifications").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  yearsExperience: integer("years_experience").notNull().default(0),
  languages: jsonb("languages").$type<string[]>().notNull().default(sql`'["en"]'::jsonb`),
  // Task #1356 — Typed handicap-range window the marketplace handicap
  // filter (`/api/coach-marketplace/coaches?handicap=…`) uses to surface
  // coaches whose preferred student-handicap range covers the requested
  // value. Replaces the prior JSONB-key hack on `certifications` (which
  // is declared as `string[]` but the live route was reading
  // `certifications->>'coachesHandicapMin/Max'` from). NULL on either
  // column means "no lower / upper bound" — the filter treats a NULL
  // bound as "always passes" so coaches without a range still appear
  // for every handicap.
  coachesHandicapMin: numeric("coaches_handicap_min", { precision: 4, scale: 1 }),
  coachesHandicapMax: numeric("coaches_handicap_max", { precision: 4, scale: 1 }),
  hourlyRatePaise: integer("hourly_rate_paise").notNull().default(0),
  asyncReviewPricePaise: integer("async_review_price_paise").notNull().default(0),
  acceptsInPerson: boolean("accepts_in_person").notNull().default(true),
  acceptsAsync: boolean("accepts_async").notNull().default(true),
  asyncTurnaroundHours: integer("async_turnaround_hours").notNull().default(48),
  revenueSharePct: numeric("revenue_share_pct", { precision: 5, scale: 2 }).notNull().default("70"),
  payoutAccountId: text("payout_account_id"),
  payoutMethod: text("payout_method"),
  payoutVpa: text("payout_vpa"),
  payoutBankAccountNumber: text("payout_bank_account_number"),
  payoutBankIfsc: text("payout_bank_ifsc"),
  payoutAccountHolderName: text("payout_account_holder_name"),
  razorpayContactId: text("razorpay_contact_id"),
  // Task #913 — Periodic re-verification of the saved fund account.
  // `payoutVerifiedAt` records the last time we successfully validated
  // the VPA / bank fund account with Razorpay (initial save or scheduled
  // re-validation). `payoutVerificationStatus` flips to 'needs_attention'
  // when a re-validation fails; the auto-payout job then skips this coach
  // until they save (and so re-verify) their account again.
  // `payoutVerificationFailureReason` carries the human-readable error so
  // the coach workspace banner can surface it.
  payoutVerifiedAt: timestamp("payout_verified_at", { withTimezone: true }),
  payoutVerificationStatus: text("payout_verification_status"),
  payoutVerificationFailureReason: text("payout_verification_failure_reason"),
  ratingsAvg: numeric("ratings_avg", { precision: 3, scale: 2 }).notNull().default("0"),
  ratingsCount: integer("ratings_count").notNull().default(0),
  intoVideoUrl: text("intro_video_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("coach_marketplace_pro_unique").on(t.proId),
  index("coach_marketplace_listed_idx").on(t.isListed),
  index("coach_marketplace_org_idx").on(t.organizationId),
  // Task #913 — index used by the periodic re-verification cron to find
  // stale payout accounts (payoutAccountId IS NOT NULL AND payoutVerifiedAt
  // < cutoff). Partial-style WHEREs aren't portable so we just index the
  // timestamp; the planner uses it together with the existing pro_unique.
  index("coach_marketplace_payout_verified_idx").on(t.payoutVerifiedAt),
  // Task #1356 — supports the marketplace handicap filter (`isListed=true
  // AND coachesHandicapMin <= h AND coachesHandicapMax >= h`). The two
  // bounds are most useful together (the filter probes both sides) so a
  // composite index keyed on min then max gives the planner a usable
  // entry point for either direction.
  index("coach_marketplace_handicap_idx").on(t.coachesHandicapMin, t.coachesHandicapMax),
]);

// Task #764 — Audit trail of changes to a coach's payout account.
// Each successful save of `/me/payout-account` (and any future admin-initiated
// change) writes a row here so coaches and org admins can review who changed
// the account, when, from where, and what masked details were stored.
export const coachPayoutAccountHistoryTable = pgTable("coach_payout_account_history", {
  id: serial("id").primaryKey(),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  // Explicit short FK name: the auto-generated
  // `coach_payout_account_history_organization_id_organizations_id_fk` is
  // 64 chars and would be silently truncated by Postgres. See task #805
  // and `lib/db/scripts/check-fk-names.ts`.
  organizationId: integer("organization_id").notNull(),
  changedByUserId: integer("changed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  // 'coach' = self-service save by the pro; 'admin' = on-behalf-of save by an org/super admin.
  changedByRole: text("changed_by_role").notNull().default("coach"),
  // 'created' for the very first account, 'updated' for any subsequent change,
  // 'admin_reverify' (Task #1222) for an admin-triggered re-run of the same
  // VPA / bank-fund-account validation the nightly cron uses (no account
  // details actually changed — the snapshot columns mirror the saved profile
  // and `verificationOutcome` / `verificationReason` carry the audit signal).
  changeKind: text("change_kind").notNull().default("updated"),
  method: text("method").notNull(), // 'upi' | 'bank_account'
  accountHolderName: text("account_holder_name"),
  upiVpaMasked: text("upi_vpa_masked"),
  bankAccountLast4: text("bank_account_last4"),
  bankIfsc: text("bank_ifsc"),
  razorpayContactId: text("razorpay_contact_id"),
  payoutAccountId: text("payout_account_id"),
  // Task #1222 — outcome + reason of the verification call that produced
  // this audit row. Populated for `admin_reverify` rows (mirrors the
  // `ReverifyResult.outcome` / `.reason` from `coachReverifyPayouts.ts`).
  // Null for legacy `created` / `updated` rows.
  verificationOutcome: text("verification_outcome"),
  verificationReason: text("verification_reason"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("coach_payout_acct_hist_pro_idx").on(t.proId, t.createdAt),
  index("coach_payout_acct_hist_org_idx").on(t.organizationId),
  foreignKey({ name: "coach_payout_acct_hist_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

export type CoachPayoutAccountHistory = typeof coachPayoutAccountHistoryTable.$inferSelect;

// Member swing video library
export const swingVideosTable = pgTable("swing_videos", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  title: text("title"),
  videoUrl: text("video_url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  durationSeconds: numeric("duration_seconds", { precision: 8, scale: 2 }),
  // Task #761 — true frame rate of the source video (detected client-side via
  // requestVideoFrameCallback), so the coach delivery canvas can step ±1 real
  // frame regardless of whether the swing was shot at 30 / 60 / 120 / 240fps.
  // Null until detected; clients fall back to 30fps.
  fps: numeric("fps", { precision: 6, scale: 3 }),
  club: text("club"),
  view: swingViewEnum("view").notNull().default("dtl"),
  notes: text("notes"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("swing_videos_user_idx").on(t.userId),
  index("swing_videos_user_captured_idx").on(t.userId, t.capturedAt),
]);

// Task #1217 — Durable queue for swing-video frame-rate detection.
//
// Task #1057 moved the fps probe out of the upload-completion request into
// an in-process background scheduler. That kept uploads snappy but the
// scheduled probes lived only in API server memory: an API restart between
// the swing_videos INSERT and the ffprobe finishing left the row with
// fps=NULL forever, recoverable only by re-running the manual backfill
// script. This table records every pending probe in the database so a
// standalone worker (modeled on highlightWorker / highlightQueue) can
// claim them with FOR UPDATE SKIP LOCKED, run ffprobe, and persist the
// result with retry/backoff — restart-safe and crash-safe.
//
// Status lifecycle:
//   queued    — ready to run when next_attempt_at <= now()
//   probing   — claimed by a worker, ffprobe in progress
//   done      — fps detected and persisted to swing_videos.fps
//   failed    — exhausted retries (cap), swing_videos.fps left as-is
//
// Rows are kept after terminal states (done/failed) for audit and so a
// re-enqueue can detect "already processed" without racing the unique
// index. The unique index on swing_video_id guarantees we never double-
// queue probes for the same video.
export const swingVideoFpsProbeStatusEnum = pgEnum("swing_video_fps_probe_status", [
  "queued", "probing", "done", "failed",
]);

export const swingVideoFpsProbesTable = pgTable("swing_video_fps_probes", {
  id: serial("id").primaryKey(),
  swingVideoId: integer("swing_video_id").notNull().references(() => swingVideosTable.id, { onDelete: "cascade" }),
  // Storage object path captured at enqueue time. The swing_videos row
  // itself stores videoUrl, but we copy it here so the worker can probe
  // even if the row is updated/renamed in flight.
  objectPath: text("object_path").notNull(),
  status: swingVideoFpsProbeStatusEnum("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Truncated to 500 chars by the worker, matching highlightQueue's cap.
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // One probe row per swing_video — the route enqueues exactly once and
  // re-enqueue is a no-op on conflict.
  uniqueIndex("swing_video_fps_probes_video_uniq").on(t.swingVideoId),
  // Worker queue lookup: oldest queued job ready to run.
  index("swing_video_fps_probes_queue_idx").on(t.status, t.nextAttemptAt),
]);

export type SwingVideoFpsProbe = typeof swingVideoFpsProbesTable.$inferSelect;

// Coach annotations (drawings + voice-over) on a swing video
export const swingAnnotationsTable = pgTable("swing_annotations", {
  id: serial("id").primaryKey(),
  swingVideoId: integer("swing_video_id").notNull().references(() => swingVideosTable.id, { onDelete: "cascade" }),
  reviewRequestId: integer("review_request_id"),
  authorUserId: integer("author_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  proId: integer("pro_id").references(() => teachingProsTable.id, { onDelete: "set null" }),
  // Drawings: array of {timestamp, type, points, color}
  drawings: jsonb("drawings").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
  voiceOverUrl: text("voice_over_url"),
  voiceOverDurationSeconds: numeric("voice_over_duration_seconds", { precision: 8, scale: 2 }),
  textNotes: text("text_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("swing_annotations_video_idx").on(t.swingVideoId),
  index("swing_annotations_review_idx").on(t.reviewRequestId),
]);

// Side-by-side comparisons (member's swing vs reference)
export const swingComparisonsTable = pgTable("swing_comparisons", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  leftVideoId: integer("left_video_id").notNull().references(() => swingVideosTable.id, { onDelete: "cascade" }),
  rightVideoId: integer("right_video_id").notNull().references(() => swingVideosTable.id, { onDelete: "cascade" }),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("swing_comparisons_user_idx").on(t.userId),
]);

// Async swing-review requests (coach reviews a member's video — escrowed payment)
export const swingReviewRequestsTable = pgTable("swing_review_requests", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  swingVideoId: integer("swing_video_id").notNull().references(() => swingVideosTable.id, { onDelete: "restrict" }),
  memberPrompt: text("member_prompt"),
  pricePaise: integer("price_paise").notNull(),
  status: swingReviewStatusEnum("status").notNull().default("pending_payment"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  escrowHeld: boolean("escrow_held").notNull().default(false),
  dueAt: timestamp("due_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  annotationId: integer("annotation_id"),
  rating: integer("rating"),
  ratingComment: text("rating_comment"),
  ratedAt: timestamp("rated_at", { withTimezone: true }),
  payoutId: integer("payout_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("swing_review_pro_idx").on(t.proId),
  index("swing_review_user_idx").on(t.userId),
  index("swing_review_status_idx").on(t.status),
  index("swing_review_org_idx").on(t.organizationId),
]);

// Coach payouts (tracks money owed to coach from delivered review requests + lessons)
export const coachPayoutsTable = pgTable("coach_payouts", {
  id: serial("id").primaryKey(),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  grossPaise: integer("gross_paise").notNull().default(0),
  platformFeePaise: integer("platform_fee_paise").notNull().default(0),
  netPayoutPaise: integer("net_payout_paise").notNull().default(0),
  status: coachPayoutStatusEnum("status").notNull().default("pending"),
  payoutReference: text("payout_reference"),
  notes: text("notes"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  failureReason: text("failure_reason"),
  payoutMode: text("payout_mode"),
  // Set the moment the coach has been notified (email + in-app) that this
  // payout was marked paid. Used to keep the mark-paid endpoint idempotent so
  // retried admin clicks never trigger duplicate emails / in-app rows.
  paidNotifiedAt: timestamp("paid_notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("coach_payouts_pro_idx").on(t.proId),
  index("coach_payouts_status_idx").on(t.status),
]);

// In-app notifications surfaced on the coach's workspace when one of their
// payouts is marked paid by an org admin. Mirrors the structure of
// handicap_case_notifications so we can track read state per notification.
export const coachPayoutNotificationsTable = pgTable("coach_payout_notifications", {
  id: serial("id").primaryKey(),
  coachUserId: integer("coach_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  payoutId: integer("payout_id").notNull().references(() => coachPayoutsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  amountPaise: integer("amount_paise").notNull().default(0),
  reference: text("reference"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [
  index("coach_payout_notif_user_idx").on(t.coachUserId, t.createdAt),
  index("coach_payout_notif_unread_idx").on(t.coachUserId, t.readAt),
  uniqueIndex("coach_payout_notif_payout_unique").on(t.payoutId),
]);

// Per-payout notification delivery attempts (Task #967). Mirrors
// `member_levy_receipt_attempts` (Task #247) but scoped to the coach
// payout-paid push + SMS fan-out. Lets the cron re-attempt transient
// provider failures on a bounded schedule so coaches aren't silently
// missed when fcm/twilio blip on the first try. The payload columns
// (amount/reference/notes/org_name) are snapshotted at first send so
// retries don't depend on possibly-mutated payout rows and produce a
// stable message.
export const coachPayoutNotificationAttemptsTable = pgTable("coach_payout_notification_attempts", {
  id: serial("id").primaryKey(),
  payoutId: integer("payout_id").notNull(),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull(),
  // Snapshot of the coach app-user id at first send (nullable — coach may
  // not have a linked app user). Push retries re-derive userId from the
  // teaching-pro row at retry time so a later linkage is honoured.
  coachUserId: integer("coach_user_id"),
  amountPaise: integer("amount_paise").notNull().default(0),
  reference: text("reference").notNull(),
  notes: text("notes"),
  orgName: text("org_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Per-channel state. Statuses mirror the levy-receipt channel statuses:
  //   sent | failed | no_address | no_user | opted_out | skipped
  pushStatus: text("push_status"),
  pushAttempts: integer("push_attempts").notNull().default(0),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushError: text("last_push_error"),
  lastPushRetryAt: timestamp("last_push_retry_at", { withTimezone: true }),
  pushRetryExhaustedAt: timestamp("push_retry_exhausted_at", { withTimezone: true }),
  smsStatus: text("sms_status"),
  smsAttempts: integer("sms_attempts").notNull().default(0),
  lastSmsAt: timestamp("last_sms_at", { withTimezone: true }),
  lastSmsError: text("last_sms_error"),
  lastSmsRetryAt: timestamp("last_sms_retry_at", { withTimezone: true }),
  smsRetryExhaustedAt: timestamp("sms_retry_exhausted_at", { withTimezone: true }),
  // Task #1543 — stamped every time the coach presses "Try again" on
  // their own missed payout notification. Used by the coach-side
  // /coach/payouts/:id/retry-notification route to enforce a per-payout
  // cooldown so a coach cannot wedge the retry cron with repeat presses.
  // The admin Resend button does NOT touch this column on purpose — an
  // admin override is allowed to bypass the cooldown.
  coachRetryRequestedAt: timestamp("coach_retry_requested_at", { withTimezone: true }),
  // Task #1914 — running count of coach-initiated "Try again" presses on
  // this stuck payout. Incremented each time `/coach/payouts/:id/retry-
  // notification` succeeds. Once it crosses
  // `COACH_PAYOUT_REPEAT_RETRY_ADMIN_THRESHOLD` without delivery success
  // we page org admins (because the coach is hammering the button which
  // means the underlying contact problem isn't getting fixed). The web
  // and mobile coach UIs use the same counter to surface a "Still not
  // getting through? Contact support" hint after the second self-retry.
  // Reset by the admin Resend path so a fresh streak after the admin
  // intervened can re-trigger the alert if the coach gets stuck again.
  coachRetryCount: integer("coach_retry_count").notNull().default(0),
  // Task #1914 — atomic dedup marker for the "coach is hammering retry"
  // admin alert. Stamped exactly once when the threshold above trips so
  // every subsequent coach press doesn't re-page admins. Cleared when
  // the admin Resend path runs (i.e. an admin acknowledged the issue
  // and tried to fix it) so a future repeat-stuck pattern can alert
  // again.
  coachRetryAdminNotifiedAt: timestamp("coach_retry_admin_notified_at", { withTimezone: true }),
  // Task #1544 — masked snapshot of the contact details we tried at attempt
  // time so the coach-facing earnings cell can show *which* phone / device
  // we attempted (e.g. "+91 ●●●●●● 4321", "1 expo device"). Coaches who have
  // since rotated SIMs / changed phones can see whether the failure is
  // because we have stale contact info on file. Both columns are nullable
  // because legacy rows pre-#1544 don't carry the snapshot, and a channel
  // with no recipient (`no_address` / `no_user`) has nothing to mask.
  pushTargetLabel: text("push_target_label"),
  smsTargetMasked: text("sms_target_masked"),
  // Task #1847 — email retry budget for the coach payout-paid fan-out.
  // The `notifyCoachPayoutPaid` helper in `swing-reviews.ts` already
  // sends an email best-effort, but until now it was fire-and-forget:
  // a transient SMTP blip silently dropped the payout receipt and a
  // hard SMTP bounce never paged anyone. Mirrors the wallet-withdrawal
  // / side-game pattern (Task #1108 / #961) so the existing retry cron
  // can re-attempt failed sends on the bounded `5/10/20/40/80` minute
  // schedule, and a hard bounce (Task #1279) jumps straight to
  // exhausted instead of consuming the remaining budget.
  emailStatus: text("email_status"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  emailExhaustionNotifiedAt: timestamp("email_exhaustion_notified_at", { withTimezone: true }),
  // Snapshot of the email address the coach-payout-paid email targeted at
  // first send. Coaches rarely change their on-file address mid-payout,
  // but persisting it here lets the retry helper re-render the message
  // against the *original* recipient rather than chasing a moving target;
  // it's also what the admin exhaustion alert displays as "email on file".
  emailRecipient: text("email_recipient"),
  // Task #1847 — per-channel dedup markers for the admin exhaustion
  // alert (mirrors `member_levy_receipt_attempts.*ExhaustionNotifiedAt`).
  // Until now the coach-payout retry path didn't fire admin alerts at
  // all; the new email retry budget brings it inline with the levy
  // pattern so an exhausted email cap pages org admins exactly once.
  pushExhaustionNotifiedAt: timestamp("push_exhaustion_notified_at", { withTimezone: true }),
  smsExhaustionNotifiedAt: timestamp("sms_exhaustion_notified_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("coach_payout_notif_attempts_payout_unique").on(t.payoutId),
  index("coach_payout_notif_attempts_push_failed_idx").on(t.pushStatus, t.pushAttempts),
  index("coach_payout_notif_attempts_sms_failed_idx").on(t.smsStatus, t.smsAttempts),
  // Task #1847 — covering index for the email retry cron's WHERE clause.
  index("coach_payout_notif_attempts_email_failed_idx").on(t.emailStatus, t.emailAttempts, t.nextEmailRetryAt),
  foreignKey({ name: "coach_payout_notif_attempts_payout_id_fk", columns: [t.payoutId], foreignColumns: [coachPayoutsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "coach_payout_notif_attempts_org_id_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

// Task #2131 — named drawing presets a coach can save once and re-use
// across reviews. Builds on the in-memory clipboard (Task #1712) by
// persisting a small per-coach library of callout patterns ("Setup
// checkpoints", "Impact angle pack", "Tempo bars") that survive
// session and device boundaries. The `drawings` blob stores the same
// shape array the deliver endpoint accepts (line / arrow / circle /
// angle objects with a `t` per shape). Times are preserved verbatim
// so the paste path on the client can re-apply the same offset-
// preserving math the clipboard uses (anchor earliest at playhead).
export const coachDrawingPresetsTable = pgTable("coach_drawing_presets", {
  id: serial("id").primaryKey(),
  proId: integer("pro_id").notNull().references(() => teachingProsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  drawings: jsonb("drawings").$type<Array<Record<string, unknown>>>().notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Picker sorts by recently-updated within a coach; index covers both
  // the `where pro_id = ?` filter and the `order by updated_at desc`.
  index("coach_drawing_presets_pro_idx").on(t.proId, t.updatedAt),
]);

export type CoachMarketplaceProfile = typeof coachMarketplaceProfilesTable.$inferSelect;
export type SwingVideo = typeof swingVideosTable.$inferSelect;
export type SwingAnnotation = typeof swingAnnotationsTable.$inferSelect;
export type SwingComparison = typeof swingComparisonsTable.$inferSelect;
export type SwingReviewRequest = typeof swingReviewRequestsTable.$inferSelect;
export type CoachPayout = typeof coachPayoutsTable.$inferSelect;
export type CoachPayoutNotificationAttempt = typeof coachPayoutNotificationAttemptsTable.$inferSelect;
export type CoachDrawingPreset = typeof coachDrawingPresetsTable.$inferSelect;

// ─── SIDE GAMES v2 (skins, snake, wolf, nassau) ──────────────────────
// Instances are scoped to one of: a tournament round, a league round, or
// a general-play round.  Exactly one of the foreign keys must be set.
export const sideGameInstancesTable = pgTable("side_game_instances", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  leagueRoundId: integer("league_round_id").references(() => leagueRoundsTable.id, { onDelete: "cascade" }),
  generalPlayRoundId: integer("general_play_round_id"),
  round: integer("round").notNull().default(1),
  gameType: text("game_type").notNull(),  // 'skins' | 'snake' | 'wolf' | 'nassau'
  name: text("name"),
  // Per-game rule parameters (see sideGames.ts for the shape per game type).
  rules: jsonb("rules").$type<Record<string, unknown>>().notNull().default({}),
  // Per-hole / per-round events that the engine consumes alongside scores
  // (e.g. wolf picks, nassau presses).  Optional for skins/snake.
  events: jsonb("events").$type<Record<string, unknown>>().notNull().default({}),
  stake: numeric("stake", { precision: 10, scale: 2 }),
  currency: text("currency").default("INR"),
  participantPlayerIds: jsonb("participant_player_ids").$type<number[]>().notNull().default([]),
  participantUserIds: jsonb("participant_user_ids").$type<number[]>().notNull().default([]),
  // Lookup cache: friendly display names for participants (engine fallback).
  participantNames: jsonb("participant_names").$type<Record<string, string>>().notNull().default({}),
  status: text("status").notNull().default("active"),  // 'active' | 'completed' | 'archived'
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("side_game_instances_tournament_idx").on(t.tournamentId, t.round),
  index("side_game_instances_league_round_idx").on(t.leagueRoundId),
  index("side_game_instances_gp_round_idx").on(t.generalPlayRoundId),
  index("side_game_instances_org_idx").on(t.organizationId),
  foreignKey({ name: "side_game_instances_general_play_round_id_fk", columns: [t.generalPlayRoundId], foreignColumns: [generalPlayRoundsTable.id] }).onDelete("cascade"),
]);

export const sideGameTemplatesTable = pgTable("side_game_templates", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  gameType: text("game_type").notNull(),
  rules: jsonb("rules").$type<Record<string, unknown>>().notNull().default({}),
  stake: numeric("stake", { precision: 10, scale: 2 }),
  currency: text("currency").default("INR"),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("side_game_templates_org_idx").on(t.organizationId),
  index("side_game_templates_league_idx").on(t.leagueId),
]);

export const sideGameSettlementsTable = pgTable("side_game_settlements", {
  id: serial("id").primaryKey(),
  instanceId: integer("instance_id").notNull().references(() => sideGameInstancesTable.id, { onDelete: "cascade" }),
  fromPlayerId: integer("from_player_id"),
  fromUserId: integer("from_user_id"),
  fromName: text("from_name"),
  toPlayerId: integer("to_player_id"),
  toUserId: integer("to_user_id"),
  toName: text("to_name"),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").default("INR"),
  status: text("status").notNull().default("pending"),  // 'pending' | 'paid' | 'cancelled'
  paymentMethod: text("payment_method"),  // 'cash' | 'wallet' | 'razorpay' | 'other'
  paymentRef: text("payment_ref"),
  // Razorpay order id for in-app settle-up flow (nullable until "Pay now" is started).
  razorpayOrderId: text("razorpay_order_id"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("side_game_settlements_instance_idx").on(t.instanceId)]);

// ─── CLUB WALLETS (Task #455 — settle-up payment flow) ───────────────
// Per (organization, user, currency) credit balance. Used for in-app
// side-game settlements: paying via wallet debits the payer and credits
// the recipient; settling via Razorpay also credits the recipient's
// wallet so they can spend the balance later or top it up.
export const clubWalletsTable = pgTable("club_wallets", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("INR"),
  // Stored in major currency units (e.g. 12.50 = ₹12.50). Never negative.
  balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("club_wallets_org_user_currency_unique").on(t.organizationId, t.userId, t.currency),
  index("club_wallets_user_idx").on(t.userId),
]);

export const clubWalletTxnsTable = pgTable("club_wallet_txns", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull().references(() => clubWalletsTable.id, { onDelete: "cascade" }),
  // 'credit' increases the wallet balance, 'debit' decreases it.
  kind: text("kind").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  // Source of the txn. Examples:
  //   'side_game_settlement_paid'  — recipient credited from a settled debt
  //   'side_game_settlement_pay'   — payer debited to clear a settlement
  //   'wallet_topup_razorpay'      — user topped up via Razorpay
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  paymentRef: text("payment_ref"),
  note: text("note"),
  // Snapshot of the wallet balance after this txn for audit.
  balanceAfter: numeric("balance_after", { precision: 12, scale: 2 }).notNull(),
  // Structured audit-only amount (Task #1072). Used by audit/adjustment rows
  // such as `wallet_topup_refund`, where `amount` is intentionally "0" to
  // avoid affecting balance arithmetic. Stores the real refunded amount so
  // dashboards can report totals reliably without parsing the note text.
  auditAmount: numeric("audit_amount", { precision: 12, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("club_wallet_txns_wallet_idx").on(t.walletId, t.createdAt),
  index("club_wallet_txns_source_idx").on(t.sourceType, t.sourceId),
]);

// ─── WALLET TOP-UP REQUESTS (Task #1423) ─────────────────────────────
// Per (organization, user, razorpay order) record of an in-flight wallet
// top-up. Inserted at /wallet/topup-order time so the home Upcoming
// widget can surface the request even before the bank settles. Status
// transitions:
//   "pending_verification" → "credited"      (verify or webhook landed)
//   "pending_verification" → "refund_pending" (cron found it orphaned,
//                                              about to refund)
//   "refund_pending"        → "refunded"     (refund recorded in audit)
// Rows in `pending_verification` or `refund_pending` are time-sensitive
// and surface in /api/portal/my-upcoming as `kind: "wallet_topup"`.
export const walletTopupRequestsTable = pgTable("wallet_topup_requests", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull(),
  orderRef: text("order_ref").notNull(),
  paymentRef: text("payment_ref"),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  // 'pending_verification' | 'credited' | 'refund_pending' | 'refunded'
  status: text("status").notNull().default("pending_verification"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wallet_topup_requests_order_unique").on(t.orderRef),
  index("wallet_topup_requests_user_status_idx").on(t.userId, t.status, t.createdAt),
  foreignKey({
    name: "wallet_topup_requests_org_fk",
    columns: [t.organizationId],
    foreignColumns: [organizationsTable.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "wallet_topup_requests_user_fk",
    columns: [t.userId],
    foreignColumns: [appUsersTable.id],
  }).onDelete("cascade"),
]);

export type WalletTopupRequest = typeof walletTopupRequestsTable.$inferSelect;

// ─── SIDE-GAME RECEIPT RETRY ATTEMPTS (Task #961) ────────────────────
// Records each side-game settlement paid notification (one row per
// settlement) so failed email and push deliveries can be re-attempted on
// a bounded schedule by the retry cron, mirroring the levy-receipt
// retry pattern (Tasks #207 / #247).
//
// The captured payload (payerName, recipientName, gameLabel, currency,
// amount, paymentMethod, paymentRef, paidAt) is persisted at notify time
// so retries don't depend on the (potentially since-mutated) settlement
// row to rebuild the message body.
//
// Both channels carry an exponential-backoff `next*RetryAt` timestamp so
// the cron only re-attempts when the backoff has elapsed (5, 10, 20, 40,
// 80 minutes for attempts 2..5).
export const sideGameSettlementReceiptAttemptsTable = pgTable("side_game_settlement_receipt_attempts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  settlementId: integer("settlement_id").notNull(),
  recipientUserId: integer("recipient_user_id").notNull(),
  payerName: text("payer_name").notNull(),
  recipientName: text("recipient_name"),
  recipientEmail: text("recipient_email"),
  gameLabel: text("game_label").notNull(),
  currency: text("currency").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  paymentMethod: text("payment_method"),
  paymentRef: text("payment_ref"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Per-channel state. Statuses mirror the helper's NotifyChannelStatus:
  //   sent | failed | no_address | opted_out | skipped
  emailStatus: text("email_status"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  pushStatus: text("push_status"),
  pushAttempts: integer("push_attempts").notNull().default(0),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushError: text("last_push_error"),
  lastPushRetryAt: timestamp("last_push_retry_at", { withTimezone: true }),
  nextPushRetryAt: timestamp("next_push_retry_at", { withTimezone: true }),
  pushRetryExhaustedAt: timestamp("push_retry_exhausted_at", { withTimezone: true }),
}, (t) => [
  index("side_game_settlement_receipt_attempts_settlement_idx").on(t.settlementId),
  index("side_game_settlement_receipt_attempts_org_idx").on(t.organizationId),
  foreignKey({ name: "side_game_settlement_receipt_attempts_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "side_game_settlement_receipt_attempts_settlement_fk", columns: [t.settlementId], foreignColumns: [sideGameSettlementsTable.id] }).onDelete("cascade"),
]);

export type SideGameInstance = typeof sideGameInstancesTable.$inferSelect;
export type SideGameTemplate = typeof sideGameTemplatesTable.$inferSelect;
export type SideGameSettlement = typeof sideGameSettlementsTable.$inferSelect;
export type SideGameSettlementReceiptAttempt = typeof sideGameSettlementReceiptAttemptsTable.$inferSelect;
export type ClubWallet = typeof clubWalletsTable.$inferSelect;
export type ClubWalletTxn = typeof clubWalletTxnsTable.$inferSelect;

// ─── WALLET WITHDRAWALS (Task #770) ──────────────────────────────────
// Members can withdraw their club wallet balance back to a saved
// UPI / bank account via RazorpayX payouts. The wallet credit is
// debited synchronously on request; the payout is then dispatched and
// reconciled by the `/api/webhooks/razorpay-payout` webhook (which
// flips status to processed / failed and refunds the wallet on
// failure).
//
// `wallet_payout_accounts` is keyed by (organization, user) so each
// member can save one fund account per club they belong to.
export const walletPayoutAccountsTable = pgTable("wallet_payout_accounts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  // 'upi' | 'bank_account'
  method: text("method").notNull(),
  accountHolderName: text("account_holder_name").notNull(),
  upiVpa: text("upi_vpa"),
  bankAccountNumber: text("bank_account_number"),
  bankIfsc: text("bank_ifsc"),
  razorpayContactId: text("razorpay_contact_id"),
  razorpayFundAccountId: text("razorpay_fund_account_id"),
  // Razorpay fund-account validation result (Task #965). A row with
  // verifiedAt = null must NOT be used for withdrawals.
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  verifiedHolderName: text("verified_holder_name"),
  verificationStatus: text("verification_status"),
  verificationFailureReason: text("verification_failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("wallet_payout_accounts_org_user_unique").on(t.organizationId, t.userId),
]);

export const clubWalletWithdrawalsTable = pgTable("club_wallet_withdrawals", {
  id: serial("id").primaryKey(),
  walletId: integer("wallet_id").notNull().references(() => clubWalletsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("INR"),
  // Snapshot of the payout method used (so renaming/removing the saved
  // account later does not change historical entries).
  method: text("method").notNull(),
  payoutAccountId: integer("payout_account_id"),
  razorpayFundAccountId: text("razorpay_fund_account_id"),
  razorpayPayoutId: text("razorpay_payout_id"),
  // 'UPI' | 'IMPS' — passed to RazorpayX
  payoutMode: text("payout_mode"),
  // pending | processing | processed | failed | reversed | cancelled
  status: text("status").notNull().default("pending"),
  failureReason: text("failure_reason"),
  utr: text("utr"),
  // FK to the club_wallet_txns rows that debited the balance and
  // (on failure) refunded it. Nullable so the row survives txn cleanup.
  debitTxnId: integer("debit_txn_id").references(() => clubWalletTxnsTable.id, { onDelete: "set null" }),
  refundTxnId: integer("refund_txn_id").references(() => clubWalletTxnsTable.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("club_wallet_withdrawals_user_idx").on(t.userId, t.organizationId, t.requestedAt),
  index("club_wallet_withdrawals_status_idx").on(t.status),
  index("club_wallet_withdrawals_razorpay_payout_idx").on(t.razorpayPayoutId),
  // Auto-generated FK names from drizzle would exceed Postgres's 63-char
  // identifier limit, so we declare these explicitly with short names.
  foreignKey({ name: "club_wallet_withdrawals_payout_account_fk", columns: [t.payoutAccountId], foreignColumns: [walletPayoutAccountsTable.id] }).onDelete("set null"),
]);

export type WalletPayoutAccount = typeof walletPayoutAccountsTable.$inferSelect;
export type ClubWalletWithdrawal = typeof clubWalletWithdrawalsTable.$inferSelect;

// Task #1518 — Audit trail of admin-triggered re-verifications of a
// member's wallet payout account. Mirrors `coach_payout_account_history`
// (Task #764 / #1222) so we can answer the same compliance question for
// wallet payouts as we already can for coach payouts:
//   "Who triggered the re-check that flipped this member to
//    needs_attention?"
//
// Today the only writer is the admin "re-verify" endpoint at
// `POST /admin/wallet/payout-accounts/:id/reverify` (Task #1289), so
// every row is an `admin_reverify`. The schema mirrors the coach
// equivalent (free-text `change_kind` defaulting to 'admin_reverify'
// rather than 'updated') so we can later add `created` / `updated`
// rows from the member-self-save path without another migration.
export const walletPayoutAccountHistoryTable = pgTable("wallet_payout_account_history", {
  id: serial("id").primaryKey(),
  walletPayoutAccountId: integer("wallet_payout_account_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  // The member whose payout account this row describes. Snapshotted so
  // an audit row survives the member's account being deleted (the FK
  // is `set null` for the same reason).
  userId: integer("user_id"),
  // FK declared via the explicit `foreignKey({ name: ... })` form below
  // because the auto-generated name
  // (`wallet_payout_account_history_changed_by_user_id_app_users_id_fk`)
  // is 64 chars and Postgres silently truncates at 63. See task #805.
  changedByUserId: integer("changed_by_user_id"),
  // 'admin' for admin-triggered re-checks. Reserved for 'member' if/when
  // we ever fold member-self-save events into this table too.
  changedByRole: text("changed_by_role").notNull().default("admin"),
  // 'admin_reverify' is the only kind today. Free-text (matches the
  // coach table's choice) so 'created' / 'updated' can slot in later
  // without an enum migration.
  changeKind: text("change_kind").notNull().default("admin_reverify"),
  method: text("method").notNull(), // 'upi' | 'bank_account'
  accountHolderName: text("account_holder_name"),
  // Masked snapshot of the saved account *before* this re-check ran.
  // The audit row never carries the raw VPA / full account number.
  upiVpaMasked: text("upi_vpa_masked"),
  bankAccountLast4: text("bank_account_last4"),
  bankIfsc: text("bank_ifsc"),
  razorpayContactId: text("razorpay_contact_id"),
  razorpayFundAccountId: text("razorpay_fund_account_id"),
  // Outcome + reason of the verification call that produced this row.
  // Mirrors `WalletReverifyResult.outcome` / `.reason` from
  // `walletReverifyPayouts.ts`.
  verificationOutcome: text("verification_outcome"),
  verificationReason: text("verification_reason"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("wallet_payout_acct_hist_acct_idx").on(t.walletPayoutAccountId, t.createdAt),
  index("wallet_payout_acct_hist_org_idx").on(t.organizationId),
  index("wallet_payout_acct_hist_user_idx").on(t.userId),
  // Auto-generated FK names from drizzle would exceed Postgres's 63-char
  // identifier limit, so we declare these explicitly with short names.
  foreignKey({ name: "wallet_payout_acct_hist_acct_fk", columns: [t.walletPayoutAccountId], foreignColumns: [walletPayoutAccountsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_payout_acct_hist_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_payout_acct_hist_user_fk", columns: [t.userId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
  foreignKey({ name: "wallet_payout_acct_hist_changed_by_fk", columns: [t.changedByUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

export type WalletPayoutAccountHistory = typeof walletPayoutAccountHistoryTable.$inferSelect;

// Per-(withdrawal × outcome) notification delivery attempts (Task #1108).
// Mirrors `side_game_settlement_receipt_attempts` (Task #961) and
// `coach_payout_notification_attempts` (Task #967): the wallet withdrawal
// processed/failed/reversed alert fans out to push + email and used to be
// fire-and-forget. We now persist a row per first-transition notify so the
// retry cron can re-attempt push/email on a bounded exponential-backoff
// schedule when SMTP/Expo blip on the first attempt. Payload columns
// (amount/currency/destination/utr/reason) are snapshotted at first send so
// retries render a stable message without re-loading mutable state.
export const walletWithdrawalNotifyAttemptsTable = pgTable("wallet_withdrawal_notify_attempts", {
  id: serial("id").primaryKey(),
  withdrawalId: integer("withdrawal_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull(),
  // 'processed' | 'failed' | 'reversed' — matches the `outcome` argument
  // passed into `notifyWithdrawal` so retries reproduce the same body.
  outcome: text("outcome").notNull(),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  currency: text("currency").notNull(),
  destination: text("destination").notNull(),
  utr: text("utr"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Per-channel state. Statuses mirror NotifyChannelStatus:
  //   sent | failed | no_address | opted_out | skipped
  emailStatus: text("email_status"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  pushStatus: text("push_status"),
  pushAttempts: integer("push_attempts").notNull().default(0),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushError: text("last_push_error"),
  lastPushRetryAt: timestamp("last_push_retry_at", { withTimezone: true }),
  nextPushRetryAt: timestamp("next_push_retry_at", { withTimezone: true }),
  pushRetryExhaustedAt: timestamp("push_retry_exhausted_at", { withTimezone: true }),
  // Task #1825 — SMS + WhatsApp result snapshot. Task #1107 wired SMS
  // and Task #1487 wired WhatsApp into the wallet-withdrawal lifecycle
  // notice, but until now those channels were one-shot best-effort:
  // their status lived only on the in-memory
  // `WalletWithdrawalNotifyResult` and was lost as soon as the call
  // returned. Admins debugging "did the member get pinged?" could
  // confirm email + push but had no record for SMS / WhatsApp. These
  // columns are audit-only — neither channel is retried by the cron
  // for wallet withdrawals, so we don't carry the retry/exhaustion
  // bookkeeping the email/push columns above need.
  // Statuses mirror NotifyChannelStatus:
  //   sent | failed | no_address | opted_out | skipped
  smsStatus: text("sms_status"),
  smsError: text("sms_error"),
  lastSmsAt: timestamp("last_sms_at", { withTimezone: true }),
  whatsappStatus: text("whatsapp_status"),
  whatsappError: text("whatsapp_error"),
  lastWhatsappAt: timestamp("last_whatsapp_at", { withTimezone: true }),
  // Task #1279 — proactively page org admins exactly once per
  // (withdrawalId × outcome) attempts row when retries on any channel
  // give up (or a hard-bounce SMTP response short-circuits straight to
  // exhausted on the first attempt). Stamped via an atomic conditional
  // UPDATE on `WHERE admin_exhaustion_notified_at IS NULL` so two
  // concurrent cron passes (or a retry + a hard-bounce path racing on
  // the same row) cannot fire the alert twice.
  adminExhaustionNotifiedAt: timestamp("admin_exhaustion_notified_at", { withTimezone: true }),
  // Task #1501 — admins can mark a notified-exhausted row as
  // "manually followed up" so it drops off the
  // /admin/wallet-withdrawal-exhaustion-alerts list view. Stamped with
  // the wall-clock at click and the acting admin's user id so we have
  // a basic audit trail of who cleared it.
  adminFollowupAcknowledgedAt: timestamp("admin_followup_acknowledged_at", { withTimezone: true }),
  adminFollowupAcknowledgedBy: integer("admin_followup_acknowledged_by"),
}, (t) => [
  uniqueIndex("wallet_wd_notify_attempts_wd_outcome_unique").on(t.withdrawalId, t.outcome),
  index("wallet_wd_notify_attempts_email_failed_idx").on(t.emailStatus, t.emailAttempts),
  index("wallet_wd_notify_attempts_push_failed_idx").on(t.pushStatus, t.pushAttempts),
  // Task #1501 — partial index on the open exhaustion-alert worklist so
  // the admin dashboard list is cheap even as the table grows.
  index("wallet_wd_notify_attempts_open_admin_alert_idx")
    .on(t.organizationId, t.adminExhaustionNotifiedAt)
    .where(sql`${t.adminExhaustionNotifiedAt} IS NOT NULL AND ${t.adminFollowupAcknowledgedAt} IS NULL`),
  foreignKey({ name: "wallet_wd_notify_attempts_withdrawal_fk", columns: [t.withdrawalId], foreignColumns: [clubWalletWithdrawalsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_wd_notify_attempts_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "wallet_wd_notify_attempts_admin_followup_user_fk", columns: [t.adminFollowupAcknowledgedBy], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

export type WalletWithdrawalNotifyAttempt = typeof walletWithdrawalNotifyAttemptsTable.$inferSelect;

// ─── Task #1280 — wallet top-up auto-refund notify retry attempts ────
// Mirrors `wallet_withdrawal_notify_attempts` (Task #1108) so the
// wallet top-up auto-refund confirmation is retried on transient
// SMTP/Expo failures instead of silently dropping the member's only
// notice that we just refunded their bank account.
//
// One row per refunded paymentId — the audit-row dedup guarantee in
// `routes/side-games-v2.ts` (only the first `inserted` audit row fires
// the notify) means we never need a second key. The `unique(paymentId)`
// also defends against a re-fire if a cron loop somehow re-invokes the
// notify in the same process.
export const walletTopupRefundNotifyAttemptsTable = pgTable("wallet_topup_refund_notify_attempts", {
  id: serial("id").primaryKey(),
  paymentId: text("payment_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull(),
  refundId: text("refund_id"),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Per-channel state. Statuses mirror NotifyChannelStatus:
  //   sent | failed | no_address | opted_out | skipped
  emailStatus: text("email_status"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  pushStatus: text("push_status"),
  pushAttempts: integer("push_attempts").notNull().default(0),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushError: text("last_push_error"),
  lastPushRetryAt: timestamp("last_push_retry_at", { withTimezone: true }),
  nextPushRetryAt: timestamp("next_push_retry_at", { withTimezone: true }),
  pushRetryExhaustedAt: timestamp("push_retry_exhausted_at", { withTimezone: true }),
  // Task #1507 — stamped by `sendNotifyExhaustionAdminDigest` once the row
  // has been included in the daily admin digest, so a subsequent run never
  // re-emails the same exhausted notice.
  adminDigestSentAt: timestamp("admin_digest_sent_at", { withTimezone: true }),
  // Task #1508 — SMS / WhatsApp retry state. The original notify wires
  // these channels but only for members who have explicitly opted in
  // to billing SMS / WhatsApp (schema defaults are OFF). Until this
  // task they were one-shot best-effort: a Twilio / WhatsApp Business
  // outage during the original send was silently dropped. Mirrors the
  // email/push columns above so the cron can sweep them too.
  smsStatus: text("sms_status"),
  smsAttempts: integer("sms_attempts").notNull().default(0),
  lastSmsAt: timestamp("last_sms_at", { withTimezone: true }),
  lastSmsError: text("last_sms_error"),
  lastSmsRetryAt: timestamp("last_sms_retry_at", { withTimezone: true }),
  nextSmsRetryAt: timestamp("next_sms_retry_at", { withTimezone: true }),
  smsRetryExhaustedAt: timestamp("sms_retry_exhausted_at", { withTimezone: true }),
  whatsappStatus: text("whatsapp_status"),
  whatsappAttempts: integer("whatsapp_attempts").notNull().default(0),
  lastWhatsappAt: timestamp("last_whatsapp_at", { withTimezone: true }),
  lastWhatsappError: text("last_whatsapp_error"),
  lastWhatsappRetryAt: timestamp("last_whatsapp_retry_at", { withTimezone: true }),
  nextWhatsappRetryAt: timestamp("next_whatsapp_retry_at", { withTimezone: true }),
  whatsappRetryExhaustedAt: timestamp("whatsapp_retry_exhausted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("wallet_topup_refund_notify_attempts_payment_unique").on(t.paymentId),
  index("wallet_topup_refund_notify_attempts_email_failed_idx").on(t.emailStatus, t.emailAttempts),
  index("wallet_topup_refund_notify_attempts_push_failed_idx").on(t.pushStatus, t.pushAttempts),
  index("wallet_topup_refund_notify_attempts_sms_failed_idx").on(t.smsStatus, t.smsAttempts),
  index("wallet_topup_refund_notify_attempts_wa_failed_idx").on(t.whatsappStatus, t.whatsappAttempts),
  foreignKey({ name: "wallet_topup_refund_notify_attempts_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

export type WalletTopupRefundNotifyAttempt = typeof walletTopupRefundNotifyAttemptsTable.$inferSelect;

// ─── Task #1280 — coach payout-account change notify retry attempts ──
// Mirrors `wallet_withdrawal_notify_attempts` (Task #1108) for the
// coach payout-account change security alert. A transient SMTP/Expo
// failure on the first try used to silently drop the only timely
// warning the coach gets about an unauthorised account swap; this
// table lets the cron retry just like it does for withdrawals.
//
// Keyed by the unique audit `historyId` (one notify per persisted
// history row, mirroring how the route invokes the notify exactly
// once per save in `routes/coach-marketplace.ts`).
export const coachPayoutAccountChangeNotifyAttemptsTable = pgTable("coach_payout_account_change_notify_attempts", {
  id: serial("id").primaryKey(),
  historyId: integer("history_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  proId: integer("pro_id").notNull(),
  // Snapshot of the coach app-user id at first send. Required: the
  // notify helper bails out before persisting if the teaching-pro row
  // has no linked app user (`pro.userId === null`), so a row in this
  // table always carries the user id we sent (or tried to send) to.
  coachUserId: integer("coach_user_id").notNull(),
  changeKind: text("change_kind").notNull(),
  method: text("method").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Per-channel state. Statuses mirror CoachPayoutNotifyChannelStatus:
  //   sent | failed | no_address | opted_out | skipped
  emailStatus: text("email_status"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  pushStatus: text("push_status"),
  pushAttempts: integer("push_attempts").notNull().default(0),
  lastPushAt: timestamp("last_push_at", { withTimezone: true }),
  lastPushError: text("last_push_error"),
  lastPushRetryAt: timestamp("last_push_retry_at", { withTimezone: true }),
  nextPushRetryAt: timestamp("next_push_retry_at", { withTimezone: true }),
  pushRetryExhaustedAt: timestamp("push_retry_exhausted_at", { withTimezone: true }),
  // Task #1507 — stamped by `sendNotifyExhaustionAdminDigest` once the row
  // has been included in the daily admin digest, so a subsequent run never
  // re-emails the same exhausted notice.
  adminDigestSentAt: timestamp("admin_digest_sent_at", { withTimezone: true }),
  // Task #1864 — SMS / WhatsApp retry state. Mirrors the wallet-topup-refund
  // SMS/WhatsApp pipeline (Task #1508) so a transient Twilio / WhatsApp
  // Business outage during the original send no longer silently swallows the
  // security-sensitive "your payout bank account was changed" notice. Both
  // channels are gated on the coach's `member_comm_prefs` billing-category
  // opt-in (schema defaults are OFF) and re-checked at retry time.
  smsStatus: text("sms_status"),
  smsAttempts: integer("sms_attempts").notNull().default(0),
  lastSmsAt: timestamp("last_sms_at", { withTimezone: true }),
  lastSmsError: text("last_sms_error"),
  lastSmsRetryAt: timestamp("last_sms_retry_at", { withTimezone: true }),
  nextSmsRetryAt: timestamp("next_sms_retry_at", { withTimezone: true }),
  smsRetryExhaustedAt: timestamp("sms_retry_exhausted_at", { withTimezone: true }),
  whatsappStatus: text("whatsapp_status"),
  whatsappAttempts: integer("whatsapp_attempts").notNull().default(0),
  lastWhatsappAt: timestamp("last_whatsapp_at", { withTimezone: true }),
  lastWhatsappError: text("last_whatsapp_error"),
  lastWhatsappRetryAt: timestamp("last_whatsapp_retry_at", { withTimezone: true }),
  nextWhatsappRetryAt: timestamp("next_whatsapp_retry_at", { withTimezone: true }),
  whatsappRetryExhaustedAt: timestamp("whatsapp_retry_exhausted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("coach_payout_acct_chg_notify_attempts_history_unique").on(t.historyId),
  index("coach_payout_acct_chg_notify_attempts_email_failed_idx").on(t.emailStatus, t.emailAttempts),
  index("coach_payout_acct_chg_notify_attempts_push_failed_idx").on(t.pushStatus, t.pushAttempts),
  index("coach_payout_acct_chg_notify_attempts_sms_failed_idx").on(t.smsStatus, t.smsAttempts),
  index("coach_payout_acct_chg_notify_attempts_wa_failed_idx").on(t.whatsappStatus, t.whatsappAttempts),
  foreignKey({ name: "coach_payout_acct_chg_notify_attempts_history_fk", columns: [t.historyId], foreignColumns: [coachPayoutAccountHistoryTable.id] }).onDelete("cascade"),
  foreignKey({ name: "coach_payout_acct_chg_notify_attempts_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "coach_payout_acct_chg_notify_attempts_pro_fk", columns: [t.proId], foreignColumns: [teachingProsTable.id] }).onDelete("cascade"),
]);

export type CoachPayoutAccountChangeNotifyAttempt = typeof coachPayoutAccountChangeNotifyAttemptsTable.$inferSelect;

// ─── Task #1855 — per-recipient send trail for the daily exhaustion ──
// admin digest cron (`sendNotifyExhaustionAdminDigest` in
// `lib/cron.ts`). Solves the silent-bounce problem reported against
// Task #1507: previously a `logger.warn` was the only trace when an
// admin inbox bounced, so a fully bouncing recipient list looked
// identical to a healthy one in the dashboard.
//
// One row per (org, recipient_email, run) capturing whether the send
// went out (`sent`), threw at the mailer (`failed`), was pre-empted
// because the address is already on `email_suppressions`
// (`paused_suppressed`), or could not be attempted at all because the
// org has no admin recipients with an email (`no_recipients`,
// recipient_email = ""). The cron pairs this with the existing
// `Metadata.flow = "notify_exhaustion_admin_digest"` Postmark hint
// (mailer.ts) so future hard bounces from this flow auto-populate
// `email_suppressions` and the next daily run pre-empts them via
// `pauseSuppressedRecipients`.
export const notifyExhaustionAdminDigestRecipientSendsTable = pgTable("notify_exhaustion_admin_digest_recipient_sends", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  // Nullable so a deleted admin user doesn't cascade-wipe the
  // historical send trail (FK is `set null`).
  recipientUserId: integer("recipient_user_id"),
  recipientEmail: text("recipient_email").notNull(),
  // 'sent' | 'failed' | 'paused_suppressed' | 'no_recipients'
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  // Mirrors `MailerErrorClass` from `lib/mailer.ts`
  // ('hard_bounce' | 'provider_unconfigured' | 'transient').
  errorClass: text("error_class"),
  // Snapshot from `email_suppressions` at the moment we pre-empted
  // the recipient (Postmark's bounce category, e.g. "HardBounce").
  bounceType: text("bounce_type"),
  suppressionReason: text("suppression_reason"),
  walletItemCount: integer("wallet_item_count").notNull().default(0),
  coachItemCount: integer("coach_item_count").notNull().default(0),
  runStartedAt: timestamp("run_started_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("notify_exh_admin_digest_recip_org_created_idx").on(t.organizationId, t.createdAt),
  index("notify_exh_admin_digest_recip_email_created_idx").on(t.recipientEmail, t.createdAt),
  index("notify_exh_admin_digest_recip_status_idx").on(t.status),
  foreignKey({ name: "notify_exh_admin_digest_recip_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
  foreignKey({ name: "notify_exh_admin_digest_recip_user_fk", columns: [t.recipientUserId], foreignColumns: [appUsersTable.id] }).onDelete("set null"),
]);

export type NotifyExhaustionAdminDigestRecipientSend = typeof notifyExhaustionAdminDigestRecipientSendsTable.$inferSelect;

// ─── Task #1845 — admin comm-pref override notify retry attempts ─────
// Mirrors the per-attempt persistence + 5/10/20/40/80-minute backoff
// pattern from Task #1280 (`coach_payout_account_change_notify_attempts`)
// for the admin-override consent email added in Task #1504.
//
// `notifyMemberOfAdminCommPrefOverride` was originally fire-and-forget:
// a single SMTP/Postmark hiccup silently swallowed the only timely
// signal a member would ever receive that an admin had toggled one of
// their notification preferences on their behalf. The in-app inbox row
// is the secondary trail but isn't pushed to the member's email/device,
// so an outage during the original send made the consent notice
// effectively invisible.
//
// Each row snapshots EVERYTHING we need to re-fire the email at retry
// time without consulting the upstream preference row (which may have
// been re-toggled between the original send and the retry, and would
// otherwise produce a misleading "previous → new" diff in the email).
// One row per notify event — the call site invokes the helper exactly
// once per actually-changed field per request, so we don't need a
// uniqueness constraint to defend against re-fires.
export const adminCommPrefOverrideNotifyAttemptsTable = pgTable("admin_comm_pref_override_notify_attempts", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  // The member whose preference was changed.
  targetUserId: integer("target_user_id").notNull(),
  // The admin who flipped the flag.
  adminUserId: integer("admin_user_id").notNull(),
  // Snapshot of the preference + reason text the admin supplied so a
  // retry never has to re-derive the email body from a row that may
  // have been re-toggled in the meantime.
  prefKey: text("pref_key").notNull(),
  prefLabel: text("pref_label").notNull(),
  previousValue: boolean("previous_value").notNull(),
  newValue: boolean("new_value").notNull(),
  reason: text("reason"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Per-channel state (email only — the in-app inbox row writes
  // synchronously into `member_messages` and isn't subject to a
  // delivery-provider outage). Statuses mirror the helper's
  // AdminPrefOverrideChannelStatus union:
  //   sent | failed | no_address | opted_out | skipped
  emailStatus: text("email_status"),
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
}, (t) => [
  index("admin_comm_pref_override_notify_attempts_email_failed_idx").on(t.emailStatus, t.emailAttempts),
  index("admin_comm_pref_override_notify_attempts_target_idx").on(t.targetUserId),
  foreignKey({ name: "admin_comm_pref_override_notify_attempts_org_fk", columns: [t.organizationId], foreignColumns: [organizationsTable.id] }).onDelete("cascade"),
]);

export type AdminCommPrefOverrideNotifyAttempt = typeof adminCommPrefOverrideNotifyAttemptsTable.$inferSelect;

/* ─────────────────────────────────────────────────────────────────────

 * Task #376 — Cross-club leagues & national ladders
 *
 * Cross-club ladders span multiple participating organizations. They
 * are managed by super-admins (role "super_admin"). Standings update as
 * qualifying rounds are posted at any participating club.
 * ───────────────────────────────────────────────────────────────────── */

export const crossClubLadderFormatEnum = pgEnum("cross_club_ladder_format", [
  "stroke", "stableford", "team_series", "knockout_cup", "national_ladder",
]);

export const crossClubLadderStatusEnum = pgEnum("cross_club_ladder_status", [
  "draft", "open", "active", "completed", "archived",
]);

export const crossClubLadderScopeEnum = pgEnum("cross_club_ladder_scope", [
  "regional", "national",
]);

export const crossClubLaddersTable = pgTable("cross_club_ladders", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  scope: crossClubLadderScopeEnum("scope").notNull().default("national"),
  format: crossClubLadderFormatEnum("format").notNull().default("stableford"),
  status: crossClubLadderStatusEnum("status").notNull().default("draft"),
  region: text("region"),
  seasonStart: timestamp("season_start", { withTimezone: true }).notNull(),
  seasonEnd: timestamp("season_end", { withTimezone: true }).notNull(),
  // Eligibility rules
  minHandicap: numeric("min_handicap", { precision: 4, scale: 1 }),
  maxHandicap: numeric("max_handicap", { precision: 4, scale: 1 }),
  allowedMembershipTypes: jsonb("allowed_membership_types").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  allowedRegions: jsonb("allowed_regions").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  // Counting rules
  bestOfRounds: integer("best_of_rounds"),
  minRoundsRequired: integer("min_rounds_required").notNull().default(1),
  // Promotion / relegation
  promotionRelegationEnabled: boolean("promotion_relegation_enabled").notNull().default(false),
  divisionCount: integer("division_count").notNull().default(1),
  promotePerDivision: integer("promote_per_division").notNull().default(0),
  relegatePerDivision: integer("relegate_per_division").notNull().default(0),
  // Misc
  isPublic: boolean("is_public").notNull().default(true),
  shareSlug: text("share_slug").notNull().unique(),
  createdBy: integer("created_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ccl_status_idx").on(t.status),
  index("ccl_scope_idx").on(t.scope),
]);

export const crossClubLadderClubsTable = pgTable("cross_club_ladder_clubs", {
  id: serial("id").primaryKey(),
  ladderId: integer("ladder_id").notNull().references(() => crossClubLaddersTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ccl_clubs_unique").on(t.ladderId, t.organizationId),
  index("ccl_clubs_ladder_idx").on(t.ladderId),
]);

export const crossClubLadderEntriesTable = pgTable("cross_club_ladder_entries", {
  id: serial("id").primaryKey(),
  ladderId: integer("ladder_id").notNull().references(() => crossClubLaddersTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  homeOrganizationId: integer("home_organization_id"),
  playerName: text("player_name").notNull(),
  playerEmail: text("player_email"),
  handicapAtRegistration: numeric("handicap_at_registration", { precision: 4, scale: 1 }),
  membershipType: text("membership_type"),
  region: text("region"),
  division: integer("division").notNull().default(1),
  totalPoints: integer("total_points").notNull().default(0),
  roundsCounted: integer("rounds_counted").notNull().default(0),
  position: integer("position"),
  previousPosition: integer("previous_position"),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("ccl_entries_user_unique").on(t.ladderId, t.userId),
  index("ccl_entries_ladder_idx").on(t.ladderId),
  index("ccl_entries_division_idx").on(t.ladderId, t.division),
  foreignKey({ name: "cross_club_ladder_entries_home_organization_id_fk", columns: [t.homeOrganizationId], foreignColumns: [organizationsTable.id] }).onDelete("set null"),
]);

export const crossClubLadderResultsTable = pgTable("cross_club_ladder_results", {
  id: serial("id").primaryKey(),
  ladderId: integer("ladder_id").notNull().references(() => crossClubLaddersTable.id, { onDelete: "cascade" }),
  entryId: integer("entry_id").notNull(),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  generalPlayRoundId: integer("general_play_round_id"),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  roundDate: timestamp("round_date", { withTimezone: true }).notNull(),
  grossScore: integer("gross_score"),
  netScore: integer("net_score"),
  stablefordPoints: integer("stableford_points"),
  pointsAwarded: integer("points_awarded").notNull().default(0),
  countedTowardTotal: boolean("counted_toward_total").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ccl_results_ladder_idx").on(t.ladderId),
  index("ccl_results_entry_idx").on(t.entryId),
  index("ccl_results_org_idx").on(t.organizationId),
  foreignKey({ name: "cross_club_ladder_results_entry_id_fk", columns: [t.entryId], foreignColumns: [crossClubLadderEntriesTable.id] }).onDelete("cascade"),
  foreignKey({ name: "cross_club_ladder_results_general_play_round_id_fk", columns: [t.generalPlayRoundId], foreignColumns: [generalPlayRoundsTable.id] }).onDelete("set null"),
]);

/**
 * Task #751 — Audit log for edits/deletes of posted ladder results.
 * Each row captures who acted, when, and the before/after values
 * (or full pre-delete snapshot for "delete" actions).
 */
export const crossClubLadderResultAuditsTable = pgTable("cross_club_ladder_result_audits", {
  id: serial("id").primaryKey(),
  // Explicit short FK name: the auto-generated
  // `cross_club_ladder_result_audits_ladder_id_cross_club_ladders_id_fk` is
  // 66 chars and would be silently truncated by Postgres. See task #805.
  ladderId: integer("ladder_id").notNull(),
  // Not a FK — survives the underlying result being deleted.
  resultId: integer("result_id").notNull(),
  entryId: integer("entry_id").notNull(),
  action: text("action").notNull(), // "update" | "delete"
  actorUserId: integer("actor_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  fieldChanges: jsonb("field_changes").$type<Record<string, { from: unknown; to: unknown }>>(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ccl_result_audits_result_idx").on(t.resultId),
  index("ccl_result_audits_ladder_created_idx").on(t.ladderId, t.createdAt),
  index("ccl_result_audits_entry_idx").on(t.entryId),
  foreignKey({ name: "ccl_result_audits_ladder_fk", columns: [t.ladderId], foreignColumns: [crossClubLaddersTable.id] }).onDelete("cascade"),
]);

export type CrossClubLadderResultAudit = typeof crossClubLadderResultAuditsTable.$inferSelect;

export const crossClubLadderEventsTable = pgTable("cross_club_ladder_events", {
  id: serial("id").primaryKey(),
  ladderId: integer("ladder_id").notNull().references(() => crossClubLaddersTable.id, { onDelete: "cascade" }),
  entryId: integer("entry_id"),
  // promoted | relegated | qualified | final_standing
  eventType: text("event_type").notNull(),
  fromDivision: integer("from_division"),
  toDivision: integer("to_division"),
  finalPosition: integer("final_position"),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ccl_events_ladder_idx").on(t.ladderId),
  index("ccl_events_entry_idx").on(t.entryId),
  foreignKey({ name: "cross_club_ladder_events_entry_id_fk", columns: [t.entryId], foreignColumns: [crossClubLadderEntriesTable.id] }).onDelete("cascade"),
]);

export type CrossClubLadder = typeof crossClubLaddersTable.$inferSelect;
export type CrossClubLadderClub = typeof crossClubLadderClubsTable.$inferSelect;
export type CrossClubLadderEntry = typeof crossClubLadderEntriesTable.$inferSelect;
export type CrossClubLadderResult = typeof crossClubLadderResultsTable.$inferSelect;
export type CrossClubLadderEvent = typeof crossClubLadderEventsTable.$inferSelect;

// ─── Task #378: Live odds & prediction widgets (read-only, no gambling) ──────

/**
 * Pre-tournament prediction game submissions. Fun-only, no monetary stakes.
 * Each user submits one prediction per tournament: winner, top-5 lineup, and
 * a guess at the lowest single round. Locked at tournament start.
 */
export const tournamentPredictionsTable = pgTable("tournament_predictions", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  predictedWinnerPlayerId: integer("predicted_winner_player_id").references(() => playersTable.id, { onDelete: "set null" }),
  predictedTop5: jsonb("predicted_top5").$type<number[]>().notNull().default([]),
  predictedLowRound: integer("predicted_low_round"),
  displayName: text("display_name"),
  // Computed score (set when tournament completes); null while live
  score: integer("score"),
  scoreBreakdown: jsonb("score_breakdown").$type<Record<string, number>>(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  scoredAt: timestamp("scored_at", { withTimezone: true }),
  // Task #501 — Idempotency marker for the post-completion results email.
  // Set the moment the "you scored X, ranked #Y" notification is dispatched
  // so re-completing a tournament (or repeated cron sweeps) never doubles up.
  resultsEmailSentAt: timestamp("results_email_sent_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("tournament_predictions_user_tournament_unique").on(t.tournamentId, t.userId),
  index("tournament_predictions_tournament_idx").on(t.tournamentId),
]);

/**
 * Lightweight engagement telemetry for the odds & prediction widgets.
 * Used to inform iteration on uplift; no PII beyond an optional userId.
 */
export const oddsTelemetryTable = pgTable("odds_telemetry", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(), // 'impression' | 'click' | 'predict_submit'
  widget: text("widget").notNull(),         // 'win_probability' | 'expected_score' | 'biggest_swings' | 'predictions'
  surface: text("surface"),                 // 'web_spectator' | 'web_public' | 'mobile_leaderboard' | 'mobile_fantasy'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("odds_telemetry_tournament_idx").on(t.tournamentId, t.createdAt),
  index("odds_telemetry_event_idx").on(t.eventType, t.widget),
]);

export type TournamentPrediction = typeof tournamentPredictionsTable.$inferSelect;
export type OddsTelemetry = typeof oddsTelemetryTable.$inferSelect;
/* ─────────────────────────────────────────────────────────────────────
 * Task #373 — Multi-currency & multi-tax support
 *
 * Adds first-class currency and tax modelling on top of the legacy
 * INR/GST flows without disturbing them. Existing INR transactions
 * continue to flow through `gstInvoice.ts`/`resolveGstTax`. Non-INR
 * orgs can now configure base + display currencies, jurisdiction-
 * aware tax profiles (GST, VAT, sales tax), and route payments through
 * the right processor (Razorpay for INR + supported currencies, Stripe
 * for everything else).
 *
 * All tables are additive — no existing column types or defaults
 * change. FX rates are stored as immutable snapshots so that historical
 * settlement amounts remain reproducible. The `fxLedgerEntriesTable`
 * captures the difference between booked (org-base) and settled
 * (processor) amounts so reporting can isolate FX gain/loss per
 * currency.
 * ───────────────────────────────────────────────────────────────────── */

export const paymentProcessorEnum = pgEnum("payment_processor", [
  "razorpay", "stripe", "manual",
]);

export const taxJurisdictionKindEnum = pgEnum("tax_jurisdiction_kind", [
  "gst", "vat", "sales_tax", "none",
]);

// Per-club currency configuration. One row per organization.
export const clubCurrencyProfilesTable = pgTable("club_currency_profiles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull().unique()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  // ISO-4217 base currency the club books revenue in (e.g. "INR", "USD").
  baseCurrency: text("base_currency").notNull().default("INR"),
  // Currencies the club is willing to display prices in (jsonb array of ISO codes).
  displayCurrencies: jsonb("display_currencies").$type<string[]>()
    .notNull().default(sql`'["INR"]'::jsonb`),
  // When true, players may pick a preferred display currency (FX disclosure shown).
  allowPlayerPreferredCurrency: boolean("allow_player_preferred_currency")
    .notNull().default(false),
  // Default tax profile applied when a transaction does not specify one.
  defaultTaxProfileId: integer("default_tax_profile_id"),
  // Surcharge added on top of the spot FX rate when displaying foreign prices.
  fxMarkupPct: numeric("fx_markup_pct", { precision: 6, scale: 3 })
    .notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Named tax profile for an org. A profile owns N rates.
export const taxProfilesTable = pgTable("tax_profiles", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  jurisdictionKind: taxJurisdictionKindEnum("jurisdiction_kind").notNull().default("none"),
  // ISO-3166-1 alpha-2 country code, e.g. "IN", "GB", "US".
  country: text("country").notNull().default("IN"),
  // Region/state code — meaning depends on jurisdiction. For GST this is the
  // 2-digit Indian state code; for US sales tax this would be the 2-letter
  // state abbreviation.
  region: text("region"),
  // Free-text label for invoices (e.g. "Standard VAT 20%", "GST 18%").
  invoiceLabel: text("invoice_label"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  // Exemption rules — flexible JSON. Recognised keys:
  //   { exemptCustomerClasses?: string[]; exemptProductClasses?: string[];
  //     thresholdAmount?: number; thresholdCurrency?: string;
  //     b2bReverseCharge?: boolean; exportZeroRated?: boolean }
  exemptionRules: jsonb("exemption_rules").$type<Record<string, unknown>>()
    .notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("tax_profiles_org_idx").on(t.organizationId),
]);

// Individual tax rate components that belong to a profile (e.g. CGST + SGST,
// or "Federal" + "Provincial"). Multiple rows allowed per profile so we can
// represent split jurisdictions.
export const taxRatesTable = pgTable("tax_rates", {
  id: serial("id").primaryKey(),
  taxProfileId: integer("tax_profile_id")
    .notNull()
    .references(() => taxProfilesTable.id, { onDelete: "cascade" }),
  componentName: text("component_name").notNull(),
  ratePct: numeric("rate_pct", { precision: 7, scale: 4 }).notNull().default("0"),
  // Optional product class filter — e.g. "alcohol", "food", "service".
  productClass: text("product_class"),
  // Optional customer class filter — e.g. "member", "guest", "corporate".
  customerClass: text("customer_class"),
  // Optional minimum/maximum taxable amount for this component (in profile currency).
  minTaxableAmount: numeric("min_taxable_amount", { precision: 14, scale: 2 }),
  maxTaxableAmount: numeric("max_taxable_amount", { precision: 14, scale: 2 }),
  sortOrder: integer("sort_order").notNull().default(0),
}, (t) => [
  index("tax_rates_profile_idx").on(t.taxProfileId),
]);

// Immutable FX rate snapshots. Inserted by manual admin actions or by the
// scheduled FX-refresh cron (not implemented here — the table accepts
// arbitrary `source` strings so future automation can attribute the rate).
export const fxRatesTable = pgTable("fx_rates", {
  id: serial("id").primaryKey(),
  baseCurrency: text("base_currency").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  // 1 unit of base = `rate` units of quote.
  rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
  source: text("source").notNull().default("manual"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fx_rates_pair_idx").on(t.baseCurrency, t.quoteCurrency, t.fetchedAt),
]);

// Per-org per-currency processor selection. One row per (org, currency).
// `accountRef` is opaque — for Razorpay it can be the account id, for Stripe
// the connected-account id. Credentials themselves live in env vars/secrets.
export const paymentProcessorConfigsTable = pgTable("payment_processor_configs", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  currency: text("currency").notNull(),
  processor: paymentProcessorEnum("processor").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  accountRef: text("account_ref"),
  // Webhook secret / public key hint stored here only as a non-sensitive
  // identifier (full secret stays in env vars per environment-secrets policy).
  publicKeyHint: text("public_key_hint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("payment_processor_configs_org_currency_unique")
    .on(t.organizationId, t.currency),
]);

// Player display-currency preference. Falls back to club display default.
export const userCurrencyPreferencesTable = pgTable("user_currency_preferences", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => appUsersTable.id, { onDelete: "cascade" }),
  preferredCurrency: text("preferred_currency").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// FX gain/loss ledger — captures the delta between booked and settled
// amounts whenever a transaction crosses currencies. Reporting joins this
// against the financial_ledger to surface unrealised vs realised FX P&L.
export const fxLedgerEntriesTable = pgTable("fx_ledger_entries", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id")
    .notNull()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  bookedCurrency: text("booked_currency").notNull(),
  bookedAmount: numeric("booked_amount", { precision: 14, scale: 2 }).notNull(),
  settledCurrency: text("settled_currency").notNull(),
  settledAmount: numeric("settled_amount", { precision: 14, scale: 2 }).notNull(),
  fxRate: numeric("fx_rate", { precision: 20, scale: 10 }).notNull(),
  // Positive = gain to the org (settled > booked-equivalent), negative = loss.
  gainLoss: numeric("gain_loss", { precision: 14, scale: 2 }).notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  processor: paymentProcessorEnum("processor"),
  notes: text("notes"),
  /**
   * Timestamp at which the upstream processor confirmed settlement of the
   * payment that produced this entry. Populated by webhook / verify handlers
   * via `recordCheckoutSettlement`. Defaults to row insert time so historical
   * rows remain queryable.
   */
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("fx_ledger_org_idx").on(t.organizationId, t.createdAt),
]);

export type ClubCurrencyProfile = typeof clubCurrencyProfilesTable.$inferSelect;
export type TaxProfile = typeof taxProfilesTable.$inferSelect;
export type TaxRate = typeof taxRatesTable.$inferSelect;
export type FxRate = typeof fxRatesTable.$inferSelect;
export type PaymentProcessorConfig = typeof paymentProcessorConfigsTable.$inferSelect;
export type UserCurrencyPreference = typeof userCurrencyPreferencesTable.$inferSelect;
export type FxLedgerEntry = typeof fxLedgerEntriesTable.$inferSelect;

/* ─────────────────────────────────────────────────────────────────────
 * SPECTATOR FOLLOWS — Task #377
 * Persistent per-user follow records with granular notification opt-ins.
 * Anonymous spectators continue to use localStorage; authenticated portal
 * users sync follows here so push notifications can be delivered.
 * ───────────────────────────────────────────────────────────────────── */
export const spectatorFollowsTable = pgTable("spectator_follows", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").references(() => playersTable.id, { onDelete: "cascade" }),
  teeTimeId: integer("tee_time_id").references(() => teeTimesTable.id, { onDelete: "cascade" }),
  notifyBirdie: boolean("notify_birdie").notNull().default(false),
  notifyEagle: boolean("notify_eagle").notNull().default(true),
  notifyHio: boolean("notify_hio").notNull().default(true),
  notifyRoundStart: boolean("notify_round_start").notNull().default(false),
  notifyRoundFinish: boolean("notify_round_finish").notNull().default(true),
  notifyTeeOff: boolean("notify_tee_off").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("spectator_follow_user_player_unique").on(t.userId, t.tournamentId, t.playerId),
  uniqueIndex("spectator_follow_user_group_unique").on(t.userId, t.tournamentId, t.teeTimeId),
  index("spectator_follow_player_idx").on(t.tournamentId, t.playerId),
  index("spectator_follow_group_idx").on(t.tournamentId, t.teeTimeId),
]);
export type SpectatorFollow = typeof spectatorFollowsTable.$inferSelect;


// ─── TASK #384: PUBLIC COURSE PAGES — REVIEWS & ABUSE REPORTS ──────────────
export const courseReviewsTable = pgTable("course_reviews", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  reviewerDisplayName: text("reviewer_display_name"),
  reviewerEmail: text("reviewer_email"),
  // 'public' shows reviewerDisplayName; 'anonymous' hides it on the public page.
  displayMode: text("display_mode").notNull().default("public"),
  rating: integer("rating").notNull(),
  title: text("title"),
  body: text("body"),
  // 'pending' | 'approved' | 'rejected' | 'hidden'
  status: text("status").notNull().default("pending"),
  abuseReportCount: integer("abuse_report_count").notNull().default(0),
  moderationNote: text("moderation_note"),
  moderatedByUserId: integer("moderated_by_user_id"),
  moderatedAt: timestamp("moderated_at", { withTimezone: true }),
  // Task #628 — admin can post a public reply that appears under the
  // review on the course page. Cleared by setting back to null.
  adminReply: text("admin_reply"),
  adminReplyAt: timestamp("admin_reply_at", { withTimezone: true }),
  adminReplyByUserId: integer("admin_reply_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("course_reviews_course_idx").on(t.courseId, t.status),
  index("course_reviews_org_idx").on(t.organizationId, t.status),
]);

export const courseReviewReportsTable = pgTable("course_review_reports", {
  id: serial("id").primaryKey(),
  reviewId: integer("review_id").notNull().references(() => courseReviewsTable.id, { onDelete: "cascade" }),
  reporterUserId: integer("reporter_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  reporterEmail: text("reporter_email"),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("course_review_reports_review_idx").on(t.reviewId),
]);

export type CourseReview = typeof courseReviewsTable.$inferSelect;
export type CourseReviewReport = typeof courseReviewReportsTable.$inferSelect;

// WATCH MOTION BUFFER — Task #527
// Durable per-user buffer of accelerometer-peak events streamed from a paired
// watch (Apple Watch / Wear OS / Garmin) while a round is in progress. Was
// previously held in a process-local Map; persisted to Postgres so the buffer
// survives API server restarts (deploys, autoscale events) mid-round.
// Entries older than the 6h TTL are pruned on every read/write.
export const watchMotionBufferTable = pgTable("watch_motion_buffer", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  // Event timestamp from the watch (ms since epoch). Stored as numeric to keep
  // millisecond fidelity without depending on Postgres timestamp coercion.
  eventTimestampMs: numeric("event_timestamp_ms", { precision: 16, scale: 0 }).notNull(),
  peakG: numeric("peak_g", { precision: 6, scale: 3 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("watch_motion_buffer_user_ts_idx").on(t.userId, t.eventTimestampMs),
  index("watch_motion_buffer_created_idx").on(t.createdAt),
]);

export type WatchMotionBufferRow = typeof watchMotionBufferTable.$inferSelect;

// GPS CHUNK BUFFER — Task #690
// Durable per-(user, round) buffer of GPS samples streamed from the phone
// **during** a round via /portal/shots/ingest. Was previously held in a
// process-local Map; persisted to Postgres so chunks survive a mid-round
// API server restart (deploys, autoscale, crash) and the round-end commit
// detect call still sees the full sample set.
//
// `context_key` namespaces the buffer per round (e.g. `t:42:r:1` for
// tournament 42 round 1, `g:99:r:1` for general-play round 99). The unique
// index on (user_id, context_key, sample_timestamp_ms) gives us free
// idempotency for retried chunks via ON CONFLICT DO NOTHING — duplicate
// timestamps within the same round buffer are silently dropped, matching
// the previous in-memory dedupe semantics.
//
// Entries older than the 8h TTL (covers a long round + delay) are pruned
// on every read/write so a player who never finishes a round cannot grow
// the table unbounded.
export const gpsChunkBufferTable = pgTable("gps_chunk_buffer", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  contextKey: text("context_key").notNull(),
  // Sample timestamp from the phone (ms since epoch). Stored as numeric to
  // keep millisecond fidelity and drive the per-(user,context) dedupe key.
  sampleTimestampMs: numeric("sample_timestamp_ms", { precision: 16, scale: 0 }).notNull(),
  lat: numeric("lat", { precision: 10, scale: 7 }).notNull(),
  lng: numeric("lng", { precision: 10, scale: 7 }).notNull(),
  accuracyM: numeric("accuracy_m", { precision: 8, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("gps_chunk_buffer_user_ctx_ts_uniq").on(t.userId, t.contextKey, t.sampleTimestampMs),
  // Supports the global TTL prune which scans by sample_timestamp_ms only.
  index("gps_chunk_buffer_sample_ts_idx").on(t.sampleTimestampMs),
  index("gps_chunk_buffer_created_idx").on(t.createdAt),
]);

export type GpsChunkBufferRow = typeof gpsChunkBufferTable.$inferSelect;

// ─────────────────────────────────────────────────────────────────────────
// Wave 0 / Task #935 — platform foundations
// ─────────────────────────────────────────────────────────────────────────

// Durable fallback store for the analytics `track()` helper. Org-scoped
// from day one (multi-tenancy is not retrofitted later). The PostHog
// forwarding layer reads from here on retry; for now we only persist.
export const analyticsEventsTable = pgTable("analytics_events", {
  id: serial("id").primaryKey(),
  eventName: text("event_name").notNull(),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  // web | mobile | watch | api | system
  surface: text("surface").notNull().default("api"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  requestId: text("request_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("analytics_events_event_idx").on(t.eventName, t.occurredAt),
  index("analytics_events_org_idx").on(t.organizationId, t.occurredAt),
  index("analytics_events_user_idx").on(t.userId, t.occurredAt),
  // Task #1944 — make the push-tap dedupe lookup in
  // POST /portal/notifications/push-opened a single index seek even
  // as analytics_events grows. The dedupe SELECT filters by
  // (event_name = 'notification_opened', user_id, recent occurred_at,
  // payload->>'messageId'); the first three are covered by the
  // existing indexes but the JSONB extraction is not, so the planner
  // would otherwise have to re-check it on every candidate row. A
  // partial expression index keyed on (user_id, payload->>'messageId')
  // and constrained to the one event lets the dedupe terminate in a
  // single lookup without bloating storage for unrelated events.
  index("analytics_events_notif_open_msg_idx")
    .on(t.userId, sql`(${t.payload}->>'messageId')`)
    .where(sql`${t.eventName} = 'notification_opened'`),
]);

export type AnalyticsEventRow = typeof analyticsEventsTable.$inferSelect;

// Hybrid course-mapping pipeline (Wave 0 / W0-2). Each row is one polygon
// (or polyline / point) belonging to a hole. `geometry` is GeoJSON-shaped
// so it can be consumed directly by web (Leaflet/MapLibre) and mobile
// (react-native-maps) without conversion.
//
// `source` records provenance: in_house = drawn by club admin in our
// mapper UI, ghin / usga = imported from those data sources, user_drawn =
// crowdsourced from a player. Multi-tenancy is enforced transitively
// through the course → organization cascade.
export const courseHoleGeometryTable = pgTable("course_hole_geometry", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number").notNull(),
  // green | fairway | hazard_water | hazard_bunker | hazard_oob | tee_box | cart_path
  featureType: text("feature_type").notNull(),
  geometry: jsonb("geometry").$type<{
    type: "Polygon" | "LineString" | "Point" | "MultiPolygon";
    coordinates: unknown;
  }>().notNull(),
  // in_house | ghin | usga | user_drawn
  source: text("source").notNull().default("in_house"),
  label: text("label"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("course_hole_geometry_course_idx").on(t.courseId, t.holeNumber),
  index("course_hole_geometry_feature_idx").on(t.courseId, t.featureType),
]);

export type CourseHoleGeometryRow = typeof courseHoleGeometryTable.$inferSelect;

// Wave 1 W1-A: audit log of every blocked AI Caddie advice attempt.
// Written whenever assertModeAllows() rejects a surface action, so an
// event organiser can later prove no advice leaked during a lockdown round.
export const aiCaddieModeBlocksTable = pgTable("ai_caddie_mode_blocks", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "set null" }),
  leagueId: integer("league_id").references(() => leaguesTable.id, { onDelete: "set null" }),
  roundId: integer("round_id"),
  mode: aiCaddieModeEnum("mode").notNull(),
  // 'phone' | 'web' | 'watch'
  surface: text("surface").notNull(),
  // e.g. 'caddie_ask', 'club_recommendation', 'distance_yardage'
  action: text("action").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("ai_caddie_mode_blocks_org_idx").on(t.organizationId, t.occurredAt),
  index("ai_caddie_mode_blocks_user_idx").on(t.userId, t.occurredAt),
]);
export type AiCaddieModeBlockRow = typeof aiCaddieModeBlocksTable.$inferSelect;

// ─── WAVE 2 (Task #937) — Load-bearing primitives ────────────────────────────

// W2-F core: notification_type_registry — every dispatched notify must
// register its key here. lib/notificationRegistry.ts seeds + asserts.
export const notificationTypeRegistryTable = pgTable("notification_type_registry", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  category: text("category").notNull(),
  description: text("description").notNull(),
  defaultChannels: jsonb("default_channels").$type<string[]>().notNull().default(sql`'["email","push"]'::jsonb`),
  transactional: boolean("transactional").notNull().default(true),
  digestable: boolean("digestable").notNull().default(false),
  auditRequired: boolean("audit_required").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("notification_type_registry_category_idx").on(t.category)]);
export type NotificationTypeRow = typeof notificationTypeRegistryTable.$inferSelect;

// Task #1005 — Digest queue. When a digestable notification fires for a
// user who has opted into digest mode, we enqueue a row here instead of
// sending immediately. A daily cron drains the queue and sends one
// summary email per user, then deletes the rows.
export const notificationDigestQueueTable = pgTable("notification_digest_queue", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  notificationKey: text("notification_key").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
}, (t) => [
  index("notification_digest_queue_user_undelivered_idx").on(t.userId, t.deliveredAt),
]);
export type NotificationDigestEntry = typeof notificationDigestQueueTable.$inferSelect;

// Task #1005 — Audit log for notification dispatch. Written when the
// registry spec marks a key as `auditRequired = true`. Lets admins prove
// after-the-fact that committee/admin-impacting notifications fired.
export const notificationAuditLogTable = pgTable("notification_audit_log", {
  id: serial("id").primaryKey(),
  notificationKey: text("notification_key").notNull(),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("notification_audit_log_key_created_idx").on(t.notificationKey, t.createdAt),
  index("notification_audit_log_user_idx").on(t.userId),
]);
export type NotificationAuditRow = typeof notificationAuditLogTable.$inferSelect;

// Task #1622 — Email CTA click tracking. Every branded notification email
// has its CTA href wrapped with `/api/r/email/<token>`; the redirect route
// records one row here per click before 302-ing the recipient onto the
// original URL. Joined against `email_cta_send_stats` to compute CTR per
// `notificationKey`.
//
// `userId` is nullable because the click can arrive after the recipient's
// account has been deleted (we still want to count the click — anonymously —
// so the per-key CTR isn't biased downward by churn).
//
// Task #2019 — `organizationId` carries the recipient's organisation at
// send time so the admin CTR report can break engagement down per club.
// Encoded into the (HMAC-signed) tracking token so the redirect route
// can stamp it on the click row without a DB lookup. Nullable because
// recipients may have no organisation at all (e.g. unaffiliated players,
// system users), and FK is `set null` so deleting an org doesn't
// retroactively destroy historical engagement rows.
export const emailCtaClicksTable = pgTable("email_cta_clicks", {
  id: serial("id").primaryKey(),
  notificationKey: text("notification_key").notNull(),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  originalUrl: text("original_url").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  clickedAt: timestamp("clicked_at", { withTimezone: true }).notNull().defaultNow(),
  // Task #2020 — short random correlation id minted at click time. Forwarded
  // to the destination as both a `kg_email_click=…` cookie (same-origin) and
  // an `?ec=…` query string (cookie-loss fallback) so the conversion handler
  // can re-attach the next meaningful action to the click that drove it.
  // Nullable so legacy rows pre-dating this column read as "no correlation".
  clickId: text("click_id"),
}, (t) => [
  index("email_cta_clicks_key_clicked_idx").on(t.notificationKey, t.clickedAt),
  index("email_cta_clicks_user_idx").on(t.userId),
  // Task #2019 — covers the per-org CTR report's `WHERE organization_id = $1
  // AND notification_key = $2 AND clicked_at >= $3` access pattern.
  index("email_cta_clicks_org_key_clicked_idx").on(t.organizationId, t.notificationKey, t.clickedAt),
  // Task #2020 — partial unique index on the click correlation id. Lets the
  // conversion handler look up the originating click in O(1) without
  // wasting a full unique on the historical NULL rows that pre-date the
  // column.
  uniqueIndex("email_cta_clicks_click_id_uidx").on(t.clickId).where(sql`${t.clickId} IS NOT NULL`),
]);
export type EmailCtaClickRow = typeof emailCtaClicksTable.$inferSelect;

// Task #1622 — Per-key send counter. The dispatcher increments this on
// every successful CTA-bearing email send (UPSERT), so the admin CTR
// report can compute clicks/sends without per-send rows. Storing only
// the aggregate avoids a row-per-email cost while still giving us the
// denominator the audit log can't (audit rows are only written when
// `auditRequired = true`, which is a minority of keys).
//
// Task #2019 — Counter is now keyed by (notification_key,
// organization_id) so each club's CTR has its own denominator. The
// surrogate `id` PK keeps drizzle's UPSERT path happy while the
// (key, org) pair is enforced by a UNIQUE constraint with NULLS NOT
// DISTINCT — recipients with no organisation (org_id = NULL) all
// roll up into a single shared "unaffiliated" bucket instead of
// proliferating one row per send.
export const emailCtaSendStatsTable = pgTable("email_cta_send_stats", {
  id: serial("id").primaryKey(),
  notificationKey: text("notification_key").notNull(),
  organizationId: integer("organization_id").references(() => organizationsTable.id, { onDelete: "set null" }),
  sendCount: integer("send_count").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("email_cta_send_stats_key_org_unique").on(t.notificationKey, t.organizationId).nullsNotDistinct(),
]);
export type EmailCtaSendStatsRow = typeof emailCtaSendStatsTable.$inferSelect;

// Task #2020 — Per-conversion rows attributing a meaningful action back to
// the email click that drove it. The redirect handler stamps the recipient
// with a click id (cookie + `?ec=` query); the destination flow calls
// `recordEmailCtaConversion(...)` after the action completes, which inserts
// one row here. Unique on (clickId, conversionType) so a re-fired flow
// (e.g. retried POST) only counts once.
//
// `notificationKey` and `userId` are snapshotted from the click row at
// insert time so the per-key admin report doesn't have to re-join against
// `email_cta_clicks` (and so churn — user deletion — doesn't blank out
// historical attribution). The 24h attribution window is enforced in the
// app layer; we still keep `convertedAt` raw so admins can re-window
// without losing data.
export const emailCtaConversionsTable = pgTable("email_cta_conversions", {
  id: serial("id").primaryKey(),
  clickId: text("click_id").notNull(),
  notificationKey: text("notification_key").notNull(),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  conversionType: text("conversion_type").notNull(),
  convertedAt: timestamp("converted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("email_cta_conversions_click_type_uidx").on(t.clickId, t.conversionType),
  index("email_cta_conversions_key_converted_idx").on(t.notificationKey, t.convertedAt),
]);
export type EmailCtaConversionRow = typeof emailCtaConversionsTable.$inferSelect;

// W2-A: course data corrections moderation queue.
export const courseCorrectionStatusEnum = pgEnum("course_correction_status",
  ["open", "accepted", "rejected"]);

export const courseDataCorrectionsTable = pgTable("course_data_corrections", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => coursesTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  holeNumber: integer("hole_number"),
  fieldName: text("field_name").notNull(),
  currentValue: text("current_value"),
  proposedValue: text("proposed_value").notNull(),
  reason: text("reason"),
  reportedByUserId: integer("reported_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  status: courseCorrectionStatusEnum("status").notNull().default("open"),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNotes: text("review_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("course_data_corrections_org_status_idx").on(t.organizationId, t.status),
  index("course_data_corrections_course_idx").on(t.courseId),
]);
export type CourseDataCorrection = typeof courseDataCorrectionsTable.$inferSelect;

// W2-D: post-event surveys.
export const postEventSurveysTable = pgTable("post_event_surveys", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull().unique().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  questions: jsonb("questions").$type<Array<{ id: string; prompt: string; type: "rating" | "text" | "boolean" }>>().notNull().default(sql`'[]'::jsonb`),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type PostEventSurvey = typeof postEventSurveysTable.$inferSelect;

export const postEventSurveyResponsesTable = pgTable("post_event_survey_responses", {
  id: serial("id").primaryKey(),
  surveyId: integer("survey_id").notNull().references(() => postEventSurveysTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  answers: jsonb("answers").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("post_event_survey_responses_survey_idx").on(t.surveyId)]);
export type PostEventSurveyResponse = typeof postEventSurveyResponsesTable.$inferSelect;

// Task #1637 — reusable post-event survey templates per organisation.
// Tournament admins were rebuilding the same set of questions for every
// event; this table lets a club save one or more named templates and
// pick one when sending a new survey. Templates are stored per-org and
// shared across all tournament admins in that org. Cascades on org
// delete so cleanup is automatic. The `(organization_id, name)` unique
// index prevents accidental "Standard post-round survey" duplicates and
// gives the UI a deterministic upsert handle.
export const postEventSurveyTemplatesTable = pgTable("post_event_survey_templates", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  questions: jsonb("questions").$type<Array<{ id: string; prompt: string; type: "rating" | "text" | "boolean" }>>().notNull().default(sql`'[]'::jsonb`),
  createdByUserId: integer("created_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("post_event_survey_templates_org_idx").on(t.organizationId),
  uniqueIndex("post_event_survey_templates_org_name_idx").on(t.organizationId, t.name),
]);
export type PostEventSurveyTemplate = typeof postEventSurveyTemplatesTable.$inferSelect;

// W2-G: dynamic pricing rules (layered on top of teePricingRules).
export const teeDynamicPricingRulesTable = pgTable("tee_dynamic_pricing_rules", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  conditions: jsonb("conditions").$type<{
    dayOfWeek?: number[];
    timeRange?: [string, string];
    occupancyMin?: number;
    leadTimeHoursMax?: number;
  }>().notNull().default(sql`'{}'::jsonb`),
  priceDeltaPct: numeric("price_delta_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  active: boolean("active").notNull().default(true),
  priority: integer("priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tee_dynamic_pricing_rules_org_active_idx").on(t.organizationId, t.active)]);
export type TeeDynamicPricingRule = typeof teeDynamicPricingRulesTable.$inferSelect;

// W2-G: tee booking waitlist with auto-promote.
export const teeWaitlistStatusEnum = pgEnum("tee_waitlist_status",
  ["waiting", "promoted", "expired", "cancelled"]);

export const teeBookingWaitlistTable = pgTable("tee_booking_waitlist", {
  id: serial("id").primaryKey(),
  slotId: integer("slot_id").notNull().references(() => courseTeeSlotTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  partySize: integer("party_size").notNull().default(1),
  status: teeWaitlistStatusEnum("status").notNull().default("waiting"),
  promotedBookingId: integer("promoted_booking_id").references(() => teeBookingsTable.id, { onDelete: "set null" }),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tee_booking_waitlist_slot_status_idx").on(t.slotId, t.status, t.createdAt)]);
export type TeeBookingWaitlist = typeof teeBookingWaitlistTable.$inferSelect;

// ── Wave 3 (Task #938) primitives ────────────────────────────────────────
export const userTotpSecretsTable = pgTable("user_totp_secrets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique("user_totp_secrets_user_id_key").references(() => appUsersTable.id, { onDelete: "cascade" }),
  secretEnc: text("secret_enc").notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type UserTotpSecret = typeof userTotpSecretsTable.$inferSelect;

export const userActiveSessionsTable = pgTable("user_active_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  sessionToken: text("session_token").notNull().unique("user_active_sessions_session_token_key"),
  deviceLabel: text("device_label"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [index("user_active_sessions_user_idx").on(t.userId)]);
export type UserActiveSession = typeof userActiveSessionsTable.$inferSelect;

export const userFollowsTable = pgTable("user_follows", {
  followerId: integer("follower_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  followeeId: integer("followee_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "user_follows_pkey", columns: [t.followerId, t.followeeId] }),
  index("user_follows_followee_idx").on(t.followeeId),
]);
export type UserFollow = typeof userFollowsTable.$inferSelect;

// Task #1697 — per-user "mute this author" relationship consulted by feed
// post push fan-out (and any future feed-author-scoped notification). One
// row per (muter, mutedUser); cascades on either side so deleting either
// account drops the row without leaving a dangling reference. Intentionally
// distinct from `user_follows` (a follow is opt-in subscription; a mute is
// opt-out suppression — a member can follow an author and still mute their
// pushes if they want only in-app visibility).
export const userFeedAuthorMutesTable = pgTable("user_feed_author_mutes", {
  muterId: integer("muter_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  mutedUserId: integer("muted_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "user_feed_author_mutes_pkey", columns: [t.muterId, t.mutedUserId] }),
  index("user_feed_author_mutes_muted_user_idx").on(t.mutedUserId),
]);
export type UserFeedAuthorMute = typeof userFeedAuthorMutesTable.$inferSelect;

// Task #1225 — track which social sign-in providers (Apple, Google) are
// linked to a player account. Without this row we have no record of WHICH
// provider attached to the user, so the portal account screen has nothing to
// show and no way to surgically detach a stale Apple ID / Google account.
//
// One row per (user, provider). The (provider, sub) pair is globally unique
// so the same Apple ID / Google account cannot map to two users — matching
// the resolution order in routes/social-auth.ts (lookup by provider+sub
// first, then by verified email).
export const socialAuthProviderEnum = pgEnum("social_auth_provider", ["apple", "google"]);

export const appUserSocialLinksTable = pgTable("app_user_social_links", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  provider: socialAuthProviderEnum("provider").notNull(),
  providerSub: text("provider_sub").notNull(),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("app_user_social_links_provider_sub_uq").on(t.provider, t.providerSub),
  uniqueIndex("app_user_social_links_user_provider_uq").on(t.userId, t.provider),
  index("app_user_social_links_user_idx").on(t.userId),
]);
export type AppUserSocialLink = typeof appUserSocialLinksTable.$inferSelect;

export const verifiedHandicapBadgesTable = pgTable("verified_handicap_badges", {
  userId: integer("user_id").primaryKey().references(() => appUsersTable.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  externalId: text("external_id"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
export type VerifiedHandicapBadge = typeof verifiedHandicapBadgesTable.$inferSelect;

export const feedPostMentionsTable = pgTable("feed_post_mentions", {
  id: serial("id").primaryKey(),
  postId: integer("post_id").notNull().references(() => feedPostsTable.id, { onDelete: "cascade" }),
  mentionedUserId: integer("mentioned_user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("feed_post_mentions_uq").on(t.postId, t.mentionedUserId),
  index("feed_post_mentions_user_idx").on(t.mentionedUserId),
]);
export type FeedPostMention = typeof feedPostMentionsTable.$inferSelect;

export const moderationInboxTable = pgTable("moderation_inbox", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(),
  sourceId: integer("source_id").notNull(),
  summary: text("summary"),
  status: text("status").notNull().default("open"),
  assignedTo: integer("assigned_to").references(() => appUsersTable.id, { onDelete: "set null" }),
  resolvedBy: integer("resolved_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  action: text("action"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("moderation_inbox_org_status_idx").on(t.organizationId, t.status),
  uniqueIndex("moderation_inbox_source_uq").on(t.sourceType, t.sourceId),
]);
export type ModerationInboxItem = typeof moderationInboxTable.$inferSelect;

export const sponsorAssetsTable = pgTable("sponsor_assets", {
  id: serial("id").primaryKey(),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  url: text("url").notNull(),
  status: text("status").notNull().default("pending"),
  uploadedBy: integer("uploaded_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  reviewedBy: integer("reviewed_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sponsor_assets_sponsor_idx").on(t.sponsorId)]);
export type SponsorAsset = typeof sponsorAssetsTable.$inferSelect;

export const sponsorClicksTable = pgTable("sponsor_clicks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  sponsorId: integer("sponsor_id").notNull().references(() => sponsorsTable.id, { onDelete: "cascade" }),
  placement: text("placement").notNull(),
  userId: integer("user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  kind: text("kind").notNull().default("click"),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("sponsor_clicks_sponsor_ts_idx").on(t.sponsorId, t.ts)]);
export type SponsorClick = typeof sponsorClicksTable.$inferSelect;

export const subscriptionSkusTable = pgTable("subscription_skus", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  periodMonths: integer("period_months").notNull().default(1),
  priceMinor: integer("price_minor").notNull(),
  currency: text("currency").notNull().default("INR"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("subscription_skus_org_idx").on(t.organizationId)]);
export type SubscriptionSku = typeof subscriptionSkusTable.$inferSelect;

export const marshalPaceAlertsTable = pgTable("marshal_pace_alerts", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").references(() => tournamentsTable.id, { onDelete: "cascade" }),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  groupLabel: text("group_label").notNull(),
  holeNumber: integer("hole_number").notNull(),
  minutesBehind: integer("minutes_behind").notNull(),
  alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedBy: integer("acknowledged_by").references(() => appUsersTable.id, { onDelete: "set null" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("marshal_pace_alerts_t_dedupe")
    .on(t.tournamentId, t.groupLabel, t.holeNumber)
    .where(sql`${t.tournamentId} IS NOT NULL`),
  uniqueIndex("marshal_pace_alerts_gp_dedupe")
    .on(t.organizationId, t.groupLabel, t.holeNumber)
    .where(sql`${t.tournamentId} IS NULL`),
  index("marshal_pace_alerts_org_idx").on(t.organizationId),
]);
export type MarshalPaceAlert = typeof marshalPaceAlertsTable.$inferSelect;

export const clubThemingTable = pgTable("club_theming", {
  organizationId: integer("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  primaryColor: text("primary_color"),
  accentColor: text("accent_color"),
  fontFamily: text("font_family"),
  logoUrl: text("logo_url"),
  faviconUrl: text("favicon_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ClubTheming = typeof clubThemingTable.$inferSelect;

export const tvMotionTemplatesTable = pgTable("tv_motion_templates", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  config: jsonb("config").notNull().default({}),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tv_motion_templates_org_idx").on(t.organizationId)]);
export type TvMotionTemplate = typeof tvMotionTemplatesTable.$inferSelect;

export const userStreaksTable = pgTable("user_streaks", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  currentLen: integer("current_len").notNull().default(0),
  bestLen: integer("best_len").notNull().default(0),
  lastIncrAt: timestamp("last_incr_at", { withTimezone: true }),
}, (t) => [uniqueIndex("user_streaks_user_kind_uq").on(t.userId, t.kind)]);
export type UserStreak = typeof userStreaksTable.$inferSelect;

// Task #1019 — audit trail for the manual-entry round alert. Originally one
// row per fired alert (i.e. per countersign that crossed the >50% manual
// threshold in `notifyManualEntryRound`); Task #1658 widened this to one
// row per countersign that *invoked* the notifier so support can answer
// "why didn't this round trigger an alert?" against a durable record
// instead of rolling structured logs. The skip path is captured by the
// `status`/`reason` columns and recorded with `recipientCount = 0`,
// `push*/email* = 0`. Lets the Players-tab data-quality table surface
// a small "alerted at HH:MM" badge or skip-reason badge per (player,
// round), and gives ops a way to audit silent rounds.
export const manualEntryAlertsTable = pgTable("manual_entry_alerts", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull().references(() => roundSubmissionsTable.id, { onDelete: "cascade" }),
  tournamentId: integer("tournament_id").notNull().references(() => tournamentsTable.id, { onDelete: "cascade" }),
  playerId: integer("player_id").notNull().references(() => playersTable.id, { onDelete: "cascade" }),
  round: integer("round").notNull(),
  manualPct: numeric("manual_pct", { precision: 5, scale: 2 }).notNull(),
  manualShots: integer("manual_shots").notNull(),
  totalShots: integer("total_shots").notNull(),
  recipientCount: integer("recipient_count").notNull().default(0),
  pushAttempted: integer("push_attempted").notNull().default(0),
  pushSent: integer("push_sent").notNull().default(0),
  emailAttempted: integer("email_attempted").notNull().default(0),
  emailSent: integer("email_sent").notNull().default(0),
  // Task #1658 — outcome of the notifier invocation. Mirrors
  // `ManualEntryNotifyStatus` ('sent' | 'skipped' | 'failed'). Default
  // 'sent' covers the pre-#1658 backfill where every persisted row was a
  // delivered alert.
  status: text("status").notNull().default("sent"),
  // Task #1658 — canonical skip reason from `MANUAL_ENTRY_NOTIFY_REASONS`
  // (e.g. 'org_muted', 'below_threshold') when status != 'sent', or the
  // surfaced error message for an unexpected failure. NULL for delivered
  // alerts.
  reason: text("reason"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("manual_entry_alerts_player_round_idx").on(t.playerId, t.round),
  index("manual_entry_alerts_tournament_idx").on(t.tournamentId),
  index("manual_entry_alerts_submission_idx").on(t.submissionId),
  // Skip-reason aggregations and the Players-tab "skip badge" both filter
  // on (status, reason); index speeds them up on a growing table.
  index("manual_entry_alerts_status_reason_idx").on(t.status, t.reason),
  check("manual_entry_alerts_status_chk", sql`${t.status} in ('sent','skipped','failed')`),
]);
export type ManualEntryAlert = typeof manualEntryAlertsTable.$inferSelect;

// Task #1386 — per-recipient delivery audit for the manual-entry round
// alert. The aggregate counts on `manual_entry_alerts` answer "did this
// alert reach anyone?", but they cannot answer "which TD specifically
// got nothing?". Without that, ops can see a tournament with a zero
// delivery rate but cannot reach out to the silent recipient
// individually or pinpoint a stale device token. One row per
// (alert, user, channel) attempt closes that gap.
//
// Status values:
//   - "sent"       — channel call succeeded for this user.
//   - "failed"     — channel call failed (transport error / bounce).
//                    `errorMessage` carries the surfaced reason.
//   - "no_address" — push only: user has no registered (Expo) device tokens.
//   - "no_email"   — email only: user row carries no email address.
//   - "opted_out"  — user disabled this channel for the alert in their
//                    notification prefs (kept for audit completeness).
export const manualEntryAlertRecipientsTable = pgTable("manual_entry_alert_recipients", {
  id: serial("id").primaryKey(),
  // FK columns are declared without inline `.references()` so we can give
  // each constraint an explicit ≤63-char name below — the auto-generated
  // ones overflow Postgres's identifier limit (Task #805).
  alertId: integer("alert_id").notNull(),
  userId: integer("user_id"),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Task #1847 — per-recipient email retry budget for the manual-entry
  // round alert. Only populated on rows where channel='email' (push rows
  // already have their own delivery-failure pathway and aren't part of
  // this task's scope). Mirrors the side-game / wallet-withdrawal email
  // retry pattern (Task #961 / #1108): the cron re-attempts failed
  // deliveries on the bounded `5/10/20/40/80` minute schedule, and a
  // hard SMTP bounce (Task #1279) jumps straight to exhausted instead
  // of consuming the remaining budget. Capacity = 5 attempts; on cap
  // we fire a single admin alert per row (dedup'd via
  // `emailExhaustionNotifiedAt`) so the on-call team knows a TD never
  // got the manual-entry-flagged email and the round needs follow-up.
  emailAttempts: integer("email_attempts").notNull().default(0),
  lastEmailAt: timestamp("last_email_at", { withTimezone: true }),
  lastEmailError: text("last_email_error"),
  lastEmailRetryAt: timestamp("last_email_retry_at", { withTimezone: true }),
  nextEmailRetryAt: timestamp("next_email_retry_at", { withTimezone: true }),
  emailRetryExhaustedAt: timestamp("email_retry_exhausted_at", { withTimezone: true }),
  emailExhaustionNotifiedAt: timestamp("email_exhaustion_notified_at", { withTimezone: true }),
  // Snapshot of the recipient address we tried at first send so the
  // retry helper can re-render against the original target rather than
  // chasing a moving `app_users.email`. Also surfaces in the admin
  // exhaustion alert as the "email on file" line.
  emailRecipient: text("email_recipient"),
}, (t) => [
  index("manual_entry_alert_recipients_alert_idx").on(t.alertId),
  index("manual_entry_alert_recipients_user_idx").on(t.userId),
  // Task #1847 — covering index for the email retry cron's WHERE clause
  // (`channel='email' AND status='failed' AND emailAttempts < cap AND
  //   nextEmailRetryAt <= now`).
  index("manual_entry_alert_recipients_email_failed_idx").on(t.channel, t.status, t.emailAttempts, t.nextEmailRetryAt),
  foreignKey({
    name: "manual_entry_alert_recipients_alert_fk",
    columns: [t.alertId],
    foreignColumns: [manualEntryAlertsTable.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "manual_entry_alert_recipients_user_fk",
    columns: [t.userId],
    foreignColumns: [appUsersTable.id],
  }).onDelete("set null"),
  check("manual_entry_alert_recipients_channel_chk", sql`${t.channel} in ('push','email')`),
  // Task #1847 — `skipped` added so the email retry helper can mark a
  // row terminal-without-counting-as-failure when the SMTP provider
  // env isn't configured (matches the data-request / wallet-withdrawal
  // precedent for `provider_unconfigured`).
  check(
    "manual_entry_alert_recipients_status_chk",
    // Task #1502 / Task #1849 — `skipped` lets `manualEntryNotify.ts`
    // record a provider-misconfig (`provider_unconfigured`) email
    // attempt as terminal-skipped instead of inflating the per-recipient
    // failure count with a marker `status='failed' / error='provider_not_configured'`.
    sql`${t.status} in ('sent','failed','no_address','no_email','opted_out','skipped')`,
  ),
]);
export type ManualEntryAlertRecipient = typeof manualEntryAlertRecipientsTable.$inferSelect;

// Task #1657 — One row per `notifyManualEntryRound` call whose outcome
// was NOT a successful fan-out (status `skipped` or `failed`). Pairs
// with `manual_entry_alerts` (which records successful fan-outs) so the
// super-admin manual-entry alert dashboard can render a breakdown
// chart of WHY rounds get skipped — without the support team having
// to grep the structured `[manual-entry-notify] result` log lines.
//
// `reason` is intentionally free-text (no check constraint) so adding
// a new branch to `notifyManualEntryRound` doesn't require a coupled
// migration; the dashboard's read side enumerates
// `MANUAL_ENTRY_NOTIFY_REASONS` and falls back to an "Other" bucket
// only as a defensive backstop for unrecognised values.
export const manualEntryNotifySkipsTable = pgTable("manual_entry_notify_skips", {
  id: serial("id").primaryKey(),
  submissionId: integer("submission_id").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("manual_entry_notify_skips_created_idx").on(t.createdAt),
  index("manual_entry_notify_skips_reason_created_idx").on(t.reason, t.createdAt),
  check("manual_entry_notify_skips_status_chk", sql`${t.status} in ('skipped','failed')`),
]);
export type ManualEntryNotifySkip = typeof manualEntryNotifySkipsTable.$inferSelect;

// Task #1665 — durable record of every manual-entry alert health ops
// page sent by `runManualEntryAlertHealthOpsAlertJob` (Task #1387).
//
// The auto-page job keeps its cooldown / "last paged at" state in
// process memory, so super-admins looking at
// `/super-admin/manual-entry-alerts` can't tell whether on-call has
// already been notified about a current outage or whether the
// cooldown is about to expire. Appending one row per successful page
// here lets the dashboard surface a banner — "Last paged: <when> —
// <breach kinds> — <N recipients>" — without anyone having to DM
// on-call to confirm, and gives ops a long-tail history to scroll
// when reconstructing an incident timeline.
//
// One row is inserted only when the job actually sent at least one
// email (i.e. the cooldown gate passed AND ≥1 recipient was reached).
// Skipped runs (`no_breach`, `in_cooldown`, `no_recipients`,
// `send_failed`) leave no row, so the banner only ever shows real
// pages.
export const manualEntryAlertPageHistoryTable = pgTable("manual_entry_alert_page_history", {
  id: serial("id").primaryKey(),
  pagedAt: timestamp("paged_at", { withTimezone: true }).notNull().defaultNow(),
  // Which breach detector(s) tripped this page — typically
  // ["delivery_rate"], ["consecutive_zero"], or both. Stored as a
  // text[] so the dashboard can render them as discrete chips and
  // future filters can `ANY(breach_kinds)` cheaply.
  breachKinds: text("breach_kinds").array().notNull().default(sql`ARRAY[]::text[]`),
  // Aggregate fan-out for the banner ("paged N people"). We also keep
  // the actual recipient email list so support can confirm a specific
  // address received the page without rerunning the lookup.
  recipientCount: integer("recipient_count").notNull().default(0),
  recipientEmails: text("recipient_emails").array().notNull().default(sql`ARRAY[]::text[]`),
  // Snapshot of the tunables that tripped the breach so a postmortem
  // can answer "what was the threshold at the time?" even if ops has
  // since widened it via the Task #1546 history flow.
  thresholdPct: numeric("threshold_pct", { precision: 6, scale: 2 }).notNull(),
  cooldownHours: numeric("cooldown_hours", { precision: 6, scale: 2 }).notNull(),
  // Snapshot of the 7-day delivery health that triggered the page.
  // Denormalised columns (vs. JSONB) so the dashboard banner / future
  // history list can render without a JSON parse.
  alertCount7d: integer("alert_count_7d").notNull(),
  anyDeliveryRate7d: numeric("any_delivery_rate_7d", { precision: 6, scale: 2 }).notNull(),
  zeroDeliveryCount7d: integer("zero_delivery_count_7d").notNull(),
  // Task #2079 — flag for synthetic "Send test page" rows fired by a
  // super-admin from the dashboard. The auto-page job always inserts
  // false; the test-page route inserts true. Lets the banner / history
  // list visually segregate test rows so a freshly-fired wiring test
  // isn't mistaken for a live outage. Default false so old rows
  // backfilled by the prior schema (Task #1665) read as "real pages".
  isTest: boolean("is_test").notNull().default(false),
}, (t) => [
  index("manual_entry_alert_page_history_paged_at_idx").on(t.pagedAt),
]);
export type ManualEntryAlertPageHistory = typeof manualEntryAlertPageHistoryTable.$inferSelect;

export const nearMissPromptsTable = pgTable("near_miss_prompts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => appUsersTable.id, { onDelete: "cascade" }),
  badgeKey: text("badge_key").notNull(),
  missedBy: text("missed_by"),
  promptedAt: timestamp("prompted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("near_miss_prompts_user_idx").on(t.userId)]);
export type NearMissPrompt = typeof nearMissPromptsTable.$inferSelect;

// OPS ALERT SETTINGS (Task #1305) — admin-tunable thresholds for the
// retry-exhaustion ops alert (artifacts/api-server/src/lib/notifyExhaustionOpsAlert.ts).
// Singleton row (`id` = 1) so ops can edit threshold + lookback window
// from the super-admin UI and have the cron pick it up on its next run
// without a redeploy. Both tunables are nullable: NULL means "fall back
// to the env var (or hardcoded default) at read time", which preserves
// the historical behaviour for environments that haven't customised
// anything yet.
export const opsAlertSettingsTable = pgTable("ops_alert_settings", {
  id: integer("id").primaryKey().default(1),
  notifyExhaustionThreshold: integer("notify_exhaustion_threshold"),
  notifyExhaustionWindowHours: integer("notify_exhaustion_window_hours"),
  // Task #1910 — DB-backed override for the retry-exhaustion ops alert
  // recipient list. NULL means "inherit from OPS_ALERT_EMAILS env var";
  // the resolver also treats an empty array as inherit, so an admin
  // who clears the list never silently disables the breach email
  // (env recipients remain the floor).
  notifyExhaustionRecipients: text("notify_exhaustion_recipients").array(),
  // Task #1664 — manual-entry alert health auto-page tunables (paired
  // with `artifacts/api-server/src/lib/manualEntryAlertHealthOpsAlert.ts`).
  // All four are nullable: NULL means "fall back to env / default at
  // read time", same convention as the retry-exhaustion columns above.
  manualEntryRateThresholdPct: integer("manual_entry_rate_threshold_pct"),
  manualEntryMinSample: integer("manual_entry_min_sample"),
  manualEntryConsecutiveZero: integer("manual_entry_consecutive_zero"),
  manualEntryCooldownHours: integer("manual_entry_cooldown_hours"),
  // Task #2081 — three additional manual-entry alert tunables editable
  // from the same super-admin Ops Alert card. All three are nullable
  // with the same DB → env → default precedence as the four columns
  // above:
  //   * `manualEntryLookbackHours` — how far back the cron looks when
  //     querying the muted-skip pile-up signal (the rate / consecutive
  //     -zero summaries are still evaluated over a fixed 7d/30d window
  //     by `getManualEntryAlertHealthSummary`; this knob just controls
  //     the muted-pile-up `since` window).
  //   * `manualEntryDryRun` — when true, the cron evaluates breaches
  //     and logs / writes page-history rows but skips the email + chat
  //     dispatch. Lets ops dry-run a tightened threshold against
  //     production traffic without paging on-call.
  //   * `manualEntryRecipientLookupLimit` — caps the deduplicated
  //     recipient list before the email send loop, so a misconfigured
  //     super_admin sweep can't fan out to thousands of inboxes.
  manualEntryLookbackHours: integer("manual_entry_lookback_hours"),
  manualEntryDryRun: boolean("manual_entry_dry_run"),
  manualEntryRecipientLookupLimit: integer("manual_entry_recipient_lookup_limit"),
  // Task #1916 — record metadata about the last "Send test alert"
  // delivery so the super-admin Ops Alert card can show admins
  // "Last test sent <relative time> ago to N recipient(s)" beside
  // the button (and stop encouraging duplicate test sends). All
  // nullable: NULL means no test has ever been recorded on this row,
  // which is the historical state for environments that haven't
  // exercised the button yet.
  lastTestSentAt: timestamp("last_test_sent_at", { withTimezone: true }),
  lastTestSentByUserId: integer("last_test_sent_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  lastTestRecipientCount: integer("last_test_recipient_count"),
  updatedByUserId: integer("updated_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("ops_alert_settings_singleton_chk", sql`${t.id} = 1`),
  check("ops_alert_settings_threshold_positive_chk",
    sql`${t.notifyExhaustionThreshold} IS NULL OR ${t.notifyExhaustionThreshold} > 0`),
  check("ops_alert_settings_window_positive_chk",
    sql`${t.notifyExhaustionWindowHours} IS NULL OR ${t.notifyExhaustionWindowHours} > 0`),
  // Manual-entry tunables — all positive; the rate threshold also caps
  // at 100 so the UI can't store a value the cron can never satisfy.
  check("ops_alert_settings_me_rate_threshold_chk",
    sql`${t.manualEntryRateThresholdPct} IS NULL OR (${t.manualEntryRateThresholdPct} > 0 AND ${t.manualEntryRateThresholdPct} <= 100)`),
  check("ops_alert_settings_me_min_sample_chk",
    sql`${t.manualEntryMinSample} IS NULL OR ${t.manualEntryMinSample} > 0`),
  check("ops_alert_settings_me_consecutive_zero_chk",
    sql`${t.manualEntryConsecutiveZero} IS NULL OR ${t.manualEntryConsecutiveZero} > 0`),
  check("ops_alert_settings_me_cooldown_hours_chk",
    sql`${t.manualEntryCooldownHours} IS NULL OR ${t.manualEntryCooldownHours} > 0`),
  // Task #2081 — lookback window must be positive (the cron multiplies
  // by 60*60*1000 to derive the muted-skip pile-up `since` window) and
  // the recipient lookup limit must be positive (a 0 / negative cap
  // would silently disable the email page entirely).
  check("ops_alert_settings_me_lookback_hours_chk",
    sql`${t.manualEntryLookbackHours} IS NULL OR ${t.manualEntryLookbackHours} > 0`),
  check("ops_alert_settings_me_recipient_lookup_limit_chk",
    sql`${t.manualEntryRecipientLookupLimit} IS NULL OR ${t.manualEntryRecipientLookupLimit} > 0`),
  // Task #1916 — recipient count must be non-negative when populated.
  check("ops_alert_settings_last_test_recipient_count_chk",
    sql`${t.lastTestRecipientCount} IS NULL OR ${t.lastTestRecipientCount} >= 0`),
]);
export type OpsAlertSettings = typeof opsAlertSettingsTable.$inferSelect;

// Task #1546 — audit log for ops alert tunable changes. Each PATCH to
// /super-admin/ops-alert-settings appends a row here so ops can
// reconstruct decisions during postmortems and spot accidental
// wide-open thresholds. The singleton settings row only keeps the
// *latest* override values (and last-editor metadata); this table is
// the historical trail.
export const opsAlertSettingsHistoryTable = pgTable("ops_alert_settings_history", {
  id: serial("id").primaryKey(),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  changedByUserId: integer("changed_by_user_id").references(() => appUsersTable.id, { onDelete: "set null" }),
  // Stored override values *before* the PATCH (NULL = "was inheriting
  // from env / default"). We deliberately record the DB-stored override
  // rather than the resolved effective value so the trail reflects what
  // the admin actually changed; the env-var fallback is itself audited
  // by the deploy.
  prevThreshold: integer("prev_threshold"),
  newThreshold: integer("new_threshold"),
  prevWindowHours: integer("prev_window_hours"),
  newWindowHours: integer("new_window_hours"),
  // Task #1664 — audit columns for the manual-entry alert health
  // tunables. Same prev/new pattern as the retry-exhaustion columns
  // above; NULL on either side means the override was unset (cron was
  // inheriting from env / default at that point in time).
  prevManualEntryRateThresholdPct: integer("prev_manual_entry_rate_threshold_pct"),
  newManualEntryRateThresholdPct: integer("new_manual_entry_rate_threshold_pct"),
  prevManualEntryMinSample: integer("prev_manual_entry_min_sample"),
  newManualEntryMinSample: integer("new_manual_entry_min_sample"),
  prevManualEntryConsecutiveZero: integer("prev_manual_entry_consecutive_zero"),
  newManualEntryConsecutiveZero: integer("new_manual_entry_consecutive_zero"),
  prevManualEntryCooldownHours: integer("prev_manual_entry_cooldown_hours"),
  newManualEntryCooldownHours: integer("new_manual_entry_cooldown_hours"),
  // Task #2081 — prev/new audit columns for the three additional
  // manual-entry tunables (lookback hours, dry-run flag, recipient
  // lookup limit). Same NULL-on-either-side convention as the four
  // pairs above: NULL means the override was unset and the cron was
  // inheriting from env / hardcoded default at that point in time.
  prevManualEntryLookbackHours: integer("prev_manual_entry_lookback_hours"),
  newManualEntryLookbackHours: integer("new_manual_entry_lookback_hours"),
  prevManualEntryDryRun: boolean("prev_manual_entry_dry_run"),
  newManualEntryDryRun: boolean("new_manual_entry_dry_run"),
  prevManualEntryRecipientLookupLimit: integer("prev_manual_entry_recipient_lookup_limit"),
  newManualEntryRecipientLookupLimit: integer("new_manual_entry_recipient_lookup_limit"),
  // Task #1910 — prev/new audit columns for the recipient list
  // override. NULL on either side means "the override was unset and
  // the cron was inheriting from OPS_ALERT_EMAILS at that point in
  // time". Stored as a `text[]` to match the singleton column.
  prevNotifyExhaustionRecipients: text("prev_notify_exhaustion_recipients").array(),
  newNotifyExhaustionRecipients: text("new_notify_exhaustion_recipients").array(),
}, (t) => [
  index("ops_alert_settings_history_changed_at_idx").on(t.changedAt),
]);
export type OpsAlertSettingsHistoryRow = typeof opsAlertSettingsHistoryTable.$inferSelect;

// Task #1674 — Audit trail for org-wide bulk-applies of notification
// defaults onto individual tournaments. The bulk-apply button on the
// club-settings page (`POST /organizations/:orgId/notification-defaults
// /apply-to-tournaments`) can silently flip a tournament director's
// deliberately-tuned per-tournament setting back to the org default.
// One row is inserted per tournament that actually changed value, so
// the tournament-detail page can surface a "your preference was
// overridden by a club admin on <date>" notice with a one-click restore.
//
// `setting` is the canonical column name on `tournaments` that was
// changed (currently only 'notify_manual_entry_alerts'; kept as text so
// future bulk-apply settings can reuse this trail without another
// migration). `previousValue` is what the tournament held immediately
// before the bulk-apply (i.e. the value the director would want to
// restore to). `acknowledgedAt` is set when the affected director
// either restores or dismisses the notice; `restoredAt` is set only on
// the restore path so we can distinguish the two outcomes in audits.
export const tournamentNotificationOverrideAuditTable = pgTable("tournament_notification_override_audit", {
  id: serial("id").primaryKey(),
  tournamentId: integer("tournament_id").notNull(),
  organizationId: integer("organization_id").notNull(),
  setting: text("setting").notNull(),
  previousValue: boolean("previous_value").notNull(),
  appliedValue: boolean("applied_value").notNull(),
  appliedByUserId: integer("applied_by_user_id"),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  restoredAt: timestamp("restored_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    name: "tnoa_tournament_id_fk",
    columns: [t.tournamentId],
    foreignColumns: [tournamentsTable.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "tnoa_organization_id_fk",
    columns: [t.organizationId],
    foreignColumns: [organizationsTable.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "tnoa_applied_by_user_id_fk",
    columns: [t.appliedByUserId],
    foreignColumns: [appUsersTable.id],
  }).onDelete("set null"),
  // Partial index — the notice lookup only ever cares about open
  // (unacknowledged) rows for a given tournament + setting, so the
  // index stays small as historical rows accumulate.
  index("tournament_notif_override_audit_open_idx")
    .on(t.tournamentId, t.setting)
    .where(sql`${t.acknowledgedAt} IS NULL`),
  index("tournament_notif_override_audit_org_idx").on(t.organizationId, t.createdAt),
]);
export type TournamentNotificationOverrideAuditRow = typeof tournamentNotificationOverrideAuditTable.$inferSelect;
