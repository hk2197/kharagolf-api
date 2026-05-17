/**
 * Wave 2 W2-F core — Notification type registry.
 *
 * Single source of truth for every transactional / digestable notify
 * the platform sends. Going forward the contract is:
 *
 *   1. Every new notify must be registered here (or via `register()`
 *      from a feature module's startup hook) BEFORE it dispatches.
 *   2. Every dispatch path calls `assertRegistered(key)`. Unknown keys
 *      throw — preventing a "rogue" notify from sneaking past the
 *      preferences UI / DND window / digest mode plumbing.
 *   3. The user-prefs UI auto-syncs from the registry; adding a new
 *      type requires no UI code change.
 *
 * The registry is loaded into memory on boot (`hydrate()`), then kept
 * in sync with the DB. We hold a Set for O(1) lookup since dispatch is
 * on the hot path.
 */

import { db, notificationTypeRegistryTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { NOTIFICATION_SAMPLES } from "./notificationSamples.js";

export interface NotificationTypeSpec {
  key: string;
  category: string;
  description: string;
  defaultChannels?: string[];   // e.g. ["email", "push", "sms", "inapp"]
  transactional?: boolean;       // immediate (true) vs digestable (false)
  digestable?: boolean;          // may be batched by digest mode
  auditRequired?: boolean;       // every send writes an admin audit row
}

const knownKeys = new Set<string>();

/** Throws if `key` was never registered. Hot-path safe (Set lookup). */
export function assertRegistered(key: string): void {
  if (!knownKeys.has(key)) {
    throw new Error(
      `[notificationRegistry] dispatch attempted for unregistered notification key: "${key}". ` +
      `Add it to lib/notificationRegistry.ts SEED_TYPES or call register() at startup.`,
    );
  }
}

/** Read-only snapshot of every registered key (sorted, for UI menus). */
export function listRegistered(): string[] {
  return [...knownKeys].sort();
}

/**
 * Task #1632 — Read-only snapshot of every registered key together with
 * the metadata the admin "registry" panel needs to be useful: human
 * description, category, default channels, and the auditRequired flag.
 *
 * Sourced from the DB (the registry table is the persisted source of
 * truth, populated from SEED_TYPES on hydrate() and from any feature
 * module's `register()` call). Sorted by key so admin UIs render a
 * stable order.
 */
export interface NotificationTypeRegistryEntry {
  key: string;
  category: string;
  description: string;
  defaultChannels: string[];
  auditRequired: boolean;
}
export async function listRegisteredDetails(): Promise<NotificationTypeRegistryEntry[]> {
  const rows = await db.select({
    key: notificationTypeRegistryTable.key,
    category: notificationTypeRegistryTable.category,
    description: notificationTypeRegistryTable.description,
    defaultChannels: notificationTypeRegistryTable.defaultChannels,
    auditRequired: notificationTypeRegistryTable.auditRequired,
  }).from(notificationTypeRegistryTable);
  return rows
    .map(r => ({
      key: r.key,
      category: r.category ?? "",
      description: r.description ?? "",
      defaultChannels: Array.isArray(r.defaultChannels) ? r.defaultChannels : [],
      auditRequired: Boolean(r.auditRequired),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Persist a new type (idempotent on `key`). Use this from feature
 * module startup hooks; for built-in types prefer the SEED_TYPES list
 * below so the contract is greppable.
 */
export async function register(spec: NotificationTypeSpec): Promise<void> {
  await db.insert(notificationTypeRegistryTable).values({
    key: spec.key,
    category: spec.category,
    description: spec.description,
    defaultChannels: spec.defaultChannels ?? ["email", "push"],
    transactional: spec.transactional ?? true,
    digestable: spec.digestable ?? false,
    auditRequired: spec.auditRequired ?? false,
  }).onConflictDoNothing({ target: notificationTypeRegistryTable.key });
  knownKeys.add(spec.key);
}

/**
 * Built-in seed list — every notify the platform sent before Wave 2.
 * Each entry was extracted from the existing notification helpers in
 * artifacts/api-server/src/lib/. Keep this list alphabetised by key.
 *
 * Adding a new entry here is the right call for any notify that lives
 * inside the api-server bundle. Out-of-tree modules should call
 * register() during their own startup.
 */
const SEED_TYPES: NotificationTypeSpec[] = [
  { key: "achievement.unlocked",        category: "engagement",  description: "Player unlocked a new achievement", digestable: true },
  { key: "booking.confirmed",           category: "tee",         description: "Tee-time booking confirmed" },
  { key: "booking.reminder.24h",        category: "tee",         description: "Tee-time reminder, 24h before" },
  { key: "booking.reminder.2h",         category: "tee",         description: "Tee-time reminder, 2h before" },
  { key: "booking.cancelled",           category: "tee",         description: "Tee-time was cancelled" },
  { key: "booking.waitlist.promoted",   category: "tee",         description: "Waitlist auto-promoted you to a confirmed booking" },
  { key: "caddie.mode.blocked",         category: "play",        description: "AI Caddie request was blocked by round mode", auditRequired: true },
  { key: "coach.review.delivered",      category: "coaching",    description: "Coach delivered an async swing review" },
  { key: "coach.payout.sent",           category: "coaching",    description: "Coach payout sent" },
  { key: "coach.payout.account.needs_attention", category: "coaching", description: "Coach payout account failed periodic re-verification" },
  // Task #1119 — daily re-verification of a member's saved wallet payout
  // account (UPI / bank) failed; we ask them to re-save it.
  { key: "wallet.payout.account.needs_attention", category: "billing", description: "Member wallet payout account failed periodic re-verification" },
  // Task #1233 — wallet auto-refund digest (Task #1073) failed to deliver
  // OR was paused entirely because every recipient is on the suppression
  // list. Audit-logged so finance has a paper trail of every dropped
  // dispatch and which recipients (if any) were paused as a result.
  { key: "wallet.refund.digest.failed", category: "billing", description: "Wallet auto-refund digest failed to deliver or was paused due to bounced recipients", auditRequired: true },
  // Task #1290 — daily/weekly stuck-side-game-receipt digest failed to
  // deliver OR was paused entirely because every recipient is on the
  // suppression list. Audit-logged so support has a paper trail of every
  // dropped dispatch and which recipients (if any) got pruned.
  { key: "side_game.receipt.digest.failed", category: "play", description: "Stuck side-game receipts digest failed to deliver or was paused due to bounced recipients", auditRequired: true },
  // Task #1444 — bounce-aware recipient pausing for the per-levy ledger
  // CSV digest (`runOneLevyLedgerEmailSchedule`, member-360.ts). Same
  // semantics as the wallet refund / side-game receipt digests above:
  // the cron auto-trims `email_suppressions`-listed addresses off the
  // schedule's stored recipient list and dispatches this key when the
  // mailer rejects the send OR every configured recipient is paused.
  { key: "levy.ledger.digest.failed", category: "billing", description: "Per-levy ledger CSV digest failed to deliver or was paused due to bounced recipients", auditRequired: true },
  // Task #1444 — companion key for the club-wide combined levy ledger
  // digest (`runOneOrgLevyLedgerEmailSchedule`, member-360.ts). Sent
  // independently of the per-levy variant so finance can tell which
  // schedule is broken from the audit trail without correlating
  // schedule ids.
  { key: "levy.ledger.org.digest.failed", category: "billing", description: "Club-wide combined levy ledger CSV digest failed to deliver or was paused due to bounced recipients", auditRequired: true },
  // Task #1444 — bounced-levy reminders cron digest
  // (`sendBouncedLevyRemindersDigest`, lib/cron.ts) failed for every
  // discovered admin recipient OR every admin's email was on the
  // suppression list. Recipients are derived dynamically from
  // org_admin / treasurer / membership_secretary roles so there is no
  // schedule row to mutate — the cron only filters and alerts.
  { key: "levy.reminders.digest.failed", category: "billing", description: "Bounced-levy reminders digest failed to deliver or every admin recipient is bouncing", auditRequired: true },
  // Task #1855 — super-admin fallback alert for the daily exhaustion
  // admin digest cron (`sendNotifyExhaustionAdminDigest`, lib/cron.ts).
  // Fires when EVERY admin recipient for an org bounces / is on the
  // suppression list / fails the SMTP send so finance has a paper
  // trail (and a human-readable email) of the dropped digest instead
  // of a single `logger.warn` line. Recipients are super_admin users
  // with `notifyExhaustionAdminDigestFailed = true`.
  { key: "notify.exhaustion.admin_digest.failed", category: "ops", description: "Daily exhaustion admin digest failed to deliver to every admin recipient for an org", auditRequired: true },
  // Task #1060 — Admin-facing alert when a coach's payout account is created
  // or updated. Digestable so admins who turn on digestMode get one summary
  // email a day instead of per-event spam. Audit-logged so the dispatch trail
  // is captured for finance compliance.
  { key: "coach.payout.account.changed.admin", category: "coaching", description: "Coach payout account was created or updated (admin oversight alert)", digestable: true, auditRequired: true },
  // Task #1406 — Coach-facing security alert when their own payout account is
  // created or updated. Audit-logged per-channel (email / in-app / push) so a
  // coach disputing whether they were ever notified has a persisted dispatch
  // trail to point at, mirroring the admin oversight key above.
  { key: "coach.payout.account.changed.coach", category: "coaching", description: "Coach payout account was created or updated (coach-side security alert)", auditRequired: true },
  { key: "course.correction.resolved",  category: "course",      description: "Your reported course correction was resolved" },
  { key: "handicap.committee.changed",  category: "handicap",    description: "Committee changed your handicap index", auditRequired: true },
  { key: "handicap.exceptional.score",  category: "handicap",    description: "Exceptional score reduction triggered", digestable: true },
  { key: "highlight.ready",             category: "engagement",  description: "Your highlight reel is ready", digestable: true },
  { key: "leaderboard.position.change", category: "play",        description: "You moved up or down the leaderboard", digestable: true },
  { key: "league.standings.updated",    category: "league",      description: "League standings updated", digestable: true },
  { key: "marker.share.requested",      category: "play",        description: "Marker share-link requested" },
  { key: "match.scheduled",             category: "match-play",  description: "Your match was scheduled" },
  { key: "match.result.recorded",       category: "match-play",  description: "Match result recorded" },
  { key: "member.document.rejected",    category: "member-360",  description: "A member document was rejected" },
  { key: "payment.received",            category: "billing",     description: "Payment received and applied" },
  { key: "post.event.survey",           category: "tournament",  description: "Post-event survey invitation" },
  { key: "post.round.results",          category: "play",        description: "Post-round results summary" },
  { key: "recap.year.ready",            category: "engagement",  description: "Your Year-in-Golf recap is ready", digestable: true },
  { key: "scheduled.email.failed",      category: "ops",         description: "An admin-scheduled email failed to send", auditRequired: true },
  // Task #1241 — companion in-app inbox row + push for the daily controller
  // digest of stuck erasure storage cleanups (Task #1078). Email-only by
  // policy is `defaultChannels: ["push"]` here so the dispatcher does not
  // also re-send the email that the cron is already sending via the bespoke
  // `sendErasureStorageFailuresDigestEmail` template. The cron stamps the
  // same per-org per-UTC-day watermark so a restart can't double-notify.
  { key: "privacy.erasure.storage_failures.controller_digest", category: "ops", description: "Controller daily digest: members' account erasure left object-storage files behind", defaultChannels: ["push"], auditRequired: true },
  { key: "scoring.event.eagle",         category: "play",        description: "You made eagle or better" },
  { key: "scoring.event.hole_in_one",   category: "play",        description: "You made a hole-in-one" },
  { key: "tournament.cut.applied",      category: "tournament",  description: "Cut line applied; round 3 grouping published" },
  { key: "tournament.tee.published",    category: "tournament",  description: "Tournament tee sheet published" },
  // Task #2088 — heads-up to a tournament's directors that an org admin
  // bulk-applied a club-wide notification default that overwrote the
  // tournament's per-event toggle (Task #1674 audit row). Emailed
  // best-effort after the bulk-apply transaction commits with a deep
  // link back to the tournament settings page where the existing
  // override-notice banner exposes the one-click `POST
  // /tournaments/:id/manual-entry-override-notice/restore` action.
  // Audit-required so the per-recipient dispatch row shows up on the
  // notification audit dashboard alongside the underlying override
  // audit row in `tournament_notification_override_audit`.
  { key: "tournament.override.applied", category: "tournament",  description: "A club admin bulk-applied a notification default that overrode this tournament's setting", auditRequired: true },
  { key: "wearable.reauth.required",    category: "wearable",    description: "Re-authorise your wearable" },
  // Wave 3 (Task #938) seed keys
  { key: "interclub.qualified",         category: "tournament",  description: "You qualified for the interclub final" },
  { key: "streak.broken",               category: "engagement",  description: "Your streak ended" },
  { key: "streak.milestone",            category: "engagement",  description: "Your streak hit a milestone", digestable: true },
  { key: "near.miss",                   category: "engagement",  description: "You narrowly missed a badge", digestable: true },
  // Task #2040 — daily push when a player closes a coaching gap on a
  // club (proximity-vs-tour trend dropped by ≥ TREND_ENCOURAGEMENT_FT
  // (1.5 ft) between the prior 30-day window and the current 30-day
  // window). Push-only by policy: the encouragement nudge belongs in
  // the home-screen surface, not the inbox / no email template needed.
  // Audit-required so the per-recipient dispatch row shows up alongside
  // every other player-facing notification on the audit dashboard
  // (mirrors `privacy.erasure.storage_failures.controller_digest`,
  // which is also `defaultChannels: ["push"]` + `auditRequired: true`).
  // Per-event opt-out wired in `notifyDispatch.ts` via
  // `notify_coaching_tip_closed`.
  { key: "coaching.gap.closed",         category: "coaching",    description: "You closed a coaching gap on a club (proximity-vs-tour trend improved)", defaultChannels: ["push"], auditRequired: true },
  { key: "marshal.pace.alert",          category: "ops",         description: "Group is behind pace threshold", auditRequired: true },
  // Task #1786 — bare-push notify sites that previously swallowed
  // delivery errors silently. Registering them here unlocks audit-log
  // writes on `failed` (so operators can see "Expo down for the
  // 14:00 volunteer push" / "marketing campaign 42 lost N pushes")
  // without having to bolt them onto the full dispatchNotification
  // path. Both keys are auditRequired so the per-recipient failure
  // rows show up in the admin notification audit dashboard.
  { key: "volunteer.assignment.assigned", category: "tournament", description: "Volunteer was assigned to a tournament role", auditRequired: true },
  { key: "marketing.campaign.push",       category: "marketing",  description: "Marketing campaign push fan-out delivery", auditRequired: true },
  { key: "verified.handicap.expiring",  category: "billing",     description: "Verified-handicap badge is expiring soon" },
  { key: "social.follow.new",           category: "engagement",  description: "Someone followed you", digestable: true },
  { key: "social.mention",              category: "engagement",  description: "You were mentioned in a feed post" },
  { key: "moderation.assigned",         category: "ops",         description: "A moderation item was assigned to you" },
  { key: "sponsor.asset.review",        category: "ops",         description: "A sponsor uploaded an asset awaiting review" },
];

/**
 * Task #2024 — Static cross-check that every key in {@link SEED_TYPES}
 * has a matching sample registered in {@link NOTIFICATION_SAMPLES}. Run
 * at module load so a contributor who adds a new dispatch key without
 * a sample fails the api-server's typecheck/test cycle immediately
 * rather than discovering a `[Sample] {description}` placeholder in the
 * admin "Preview template" dialog after deploy.
 */
(function assertSamplesCoverSeedTypes(): void {
  const missing = SEED_TYPES.filter(s => !(s.key in NOTIFICATION_SAMPLES)).map(s => s.key);
  if (missing.length > 0) {
    throw new Error(
      `[notificationRegistry] missing notification samples for keys: ${missing.join(", ")}. ` +
      `Add a sample to lib/notificationSamples.ts so previewNotificationTemplate emits realistic copy.`,
    );
  }
})();

let hydrated = false;
let hydratePromise: Promise<void> | null = null;

/**
 * Load the registry into the in-memory Set + upsert any missing seed
 * entries. Safe to call repeatedly; idempotent. Should be called once
 * at server startup (see api-server's bootstrap).
 */
export async function hydrate(): Promise<void> {
  if (hydrated) return;
  if (hydratePromise) { await hydratePromise; return; }
  hydratePromise = (async () => {
    try {
    // Upsert every seed type. onConflictDoNothing keeps it idempotent.
    if (SEED_TYPES.length > 0) {
      await db.insert(notificationTypeRegistryTable).values(SEED_TYPES.map(s => ({
        key: s.key,
        category: s.category,
        description: s.description,
        defaultChannels: s.defaultChannels ?? ["email", "push"],
        transactional: s.transactional ?? true,
        digestable: s.digestable ?? false,
        auditRequired: s.auditRequired ?? false,
      }))).onConflictDoNothing({ target: notificationTypeRegistryTable.key });
    }
    const rows = await db.select({ key: notificationTypeRegistryTable.key })
      .from(notificationTypeRegistryTable);
      knownKeys.clear();
      for (const r of rows) knownKeys.add(r.key);
      hydrated = true;
    } catch (err) {
      // Architect-flagged: if hydrate fails we must NOT leave a
      // permanently-rejected promise that prevents subsequent retry.
      hydratePromise = null;
      throw err;
    }
  })();
  await hydratePromise;
}
