/**
 * Task #835 — Notify super admins when a club gets auto-reset by the legacy
 * plan-tier migration (Task #514, audit shape `entity =
 * 'organization_subscription_tier'`, `action = 'migrate'`).
 *
 * Without this, the only way a super admin learns a paying club was silently
 * dropped to Free is to remember to open the Plan Migration Audit panel.
 *
 * Behaviour:
 *   - `getUnacknowledgedPlanMigrationsSummary()` returns the count + a small
 *     preview slice of unacknowledged migration audit rows, joined to org
 *     name/slug.
 *   - `sendPlanMigrationDigestToSuperAdmins()` emails every super_admin with
 *     an email address when at least one unacknowledged row exists. Dedupes
 *     against a 23h floor so the cron can tick more often than once a day
 *     (so newly created rows surface within ~1h of being written), while
 *     still matching the daily-digest cadence in steady state. Task #1551 —
 *     the dedup floor is persisted on each dispatched audit row's
 *     `metadata.lastDigestedAt`, so it survives process restarts and a
 *     deploy/crash inside the 23h window no longer triggers a duplicate
 *     digest on the next cron tick.
 */

import type { Request } from "express";
import { db } from "@workspace/db";
import {
  memberAuditLogTable,
  organizationsTable,
  appUsersTable,
} from "@workspace/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sendPlanMigrationDigestEmail } from "./mailer";
import { sendTransactionalPush } from "./comms";
import { recordMemberAudit } from "./auditMember";
import { issuePlanMigrationAckToken } from "./plan-migration-ack-token";

/**
 * Task #1906 — categorise WHY a plan-migration audit row was raised so super
 * admins can tell genuine churn (`'cancelled'`) from a slug-mapping bug
 * (`'unknown_tier'`) at a glance without reading the free-text `reason`
 * field. `'manual'` covers admin-triggered re-migrations.
 *
 * Persisted on each audit row's `metadata.triggerReason`, surfaced through
 * the digest summary and the audit-panel feed, and used by the email +
 * push helpers to vary the subject and title.
 *
 * The enum is intentionally small and stable; new triggers should be added
 * here so callers don't fall back to string-parsing the `reason` field.
 */
export type PlanMigrationTriggerReason = "cancelled" | "unknown_tier" | "manual";

const VALID_TRIGGER_REASONS = new Set<PlanMigrationTriggerReason>([
  "cancelled",
  "unknown_tier",
  "manual",
]);

function coerceTriggerReason(raw: unknown): PlanMigrationTriggerReason | null {
  return typeof raw === "string" && VALID_TRIGGER_REASONS.has(raw as PlanMigrationTriggerReason)
    ? (raw as PlanMigrationTriggerReason)
    : null;
}

/**
 * Task #1906 — push-notification title that varies by trigger so the lock
 * screen alone is enough to triage. The email subject helper in
 * `mailer.ts` mirrors this mapping (see `planMigrationEmailSubject`).
 *
 * Falls back to the legacy "Club auto-reset to Free" wording for `null`
 * triggers so older code paths and tests that don't yet supply a reason
 * keep working.
 */
export function planMigrationPushTitle(
  triggerReason: PlanMigrationTriggerReason | null,
): string {
  switch (triggerReason) {
    case "cancelled":
      return "Club cancelled paid plan";
    case "unknown_tier":
      return "Club auto-reset (unknown tier)";
    case "manual":
      return "Club plan re-migrated by super admin";
    default:
      return "Club auto-reset to Free";
  }
}

/**
 * Task #1906 — when every row in a batch shares the same `triggerReason`,
 * return it so the email subject + (single-event) push title can be
 * specialised. Mixed batches return `null` so the caller falls back to the
 * generic "auto-reset to Free" wording.
 */
export function uniformTriggerReason(
  rows: ReadonlyArray<{ triggerReason?: PlanMigrationTriggerReason | null }>,
): PlanMigrationTriggerReason | null {
  if (rows.length === 0) return null;
  const first = rows[0]?.triggerReason ?? null;
  if (first === null) return null;
  for (const r of rows) {
    if ((r.triggerReason ?? null) !== first) return null;
  }
  return first;
}

export type PlanMigrationDigestRow = {
  id: number;
  organizationId: number | null;
  orgName: string | null;
  orgSlug: string | null;
  fromTier: string | null;
  toTier: string | null;
  createdAt: string;
  /**
   * Task #1313 — ISO timestamp of the first digest dispatch that included
   * this row. Persisted on the audit row's metadata so it survives process
   * restarts and stays stable across digest cycles. `null` until the row
   * has been included in at least one dispatched digest (the dispatcher
   * stamps it just before sending).
   */
  firstDigestedAt: string | null;
  /**
   * Task #1906 — categorical trigger so super admins can distinguish
   * genuine cancellations from auto-resets caused by an unrecognised tier
   * slug. `null` for legacy rows written before Task #1906 landed (those
   * pre-date the metadata field; the email + panel fall back to the
   * generic "auto-reset to Free" wording for them).
   */
  triggerReason: PlanMigrationTriggerReason | null;
};

export type PlanMigrationDigestSummary = {
  totalUnacknowledged: number;
  rows: PlanMigrationDigestRow[];
};

export type RecentlyAcknowledgedSummary = {
  count: number;
  lastAcknowledgedAt: string | null;
};

const UNACK_PREDICATE = and(
  eq(memberAuditLogTable.entity, "organization_subscription_tier"),
  eq(memberAuditLogTable.action, "migrate"),
  // Tolerate both jsonb-bool true and string 'true' (matches the route filter).
  sql`(${memberAuditLogTable.metadata}->>'acknowledged') IS DISTINCT FROM 'true'`,
);

/** Fetch the count + the most-recent N unacknowledged migration audit rows. */
export async function getUnacknowledgedPlanMigrationsSummary(
  previewLimit = 20,
): Promise<PlanMigrationDigestSummary> {
  const limit = Math.max(1, Math.min(100, previewLimit));

  const [totalRow] = await db
    .select({ count: count() })
    .from(memberAuditLogTable)
    .where(UNACK_PREDICATE);

  const total = Number(totalRow?.count ?? 0);
  if (total === 0) return { totalUnacknowledged: 0, rows: [] };

  const rows = await db
    .select({
      id: memberAuditLogTable.id,
      organizationId: memberAuditLogTable.organizationId,
      orgName: organizationsTable.name,
      orgSlug: organizationsTable.slug,
      fieldChanges: memberAuditLogTable.fieldChanges,
      createdAt: memberAuditLogTable.createdAt,
      // Task #1313 — pull the persisted "first dispatched" stamp so the
      // email can render "first surfaced X days ago" alongside each entry.
      firstDigestedAt: sql<string | null>`${memberAuditLogTable.metadata}->>'firstDigestedAt'`,
      // Task #1906 — pull the persisted trigger category so the email,
      // push title, and audit panel can show "cancelled" vs
      // "unknown_tier" vs "manual" without re-parsing `reason`.
      triggerReason: sql<string | null>`${memberAuditLogTable.metadata}->>'triggerReason'`,
    })
    .from(memberAuditLogTable)
    .leftJoin(organizationsTable, eq(organizationsTable.id, memberAuditLogTable.organizationId))
    .where(UNACK_PREDICATE)
    .orderBy(desc(memberAuditLogTable.createdAt))
    .limit(limit);

  const preview: PlanMigrationDigestRow[] = rows.map((r) => {
    const tier = (r.fieldChanges as { tier?: { from?: unknown; to?: unknown } } | null)?.tier;
    return {
      id: r.id,
      organizationId: r.organizationId,
      orgName: r.orgName,
      orgSlug: r.orgSlug,
      fromTier: tier?.from == null ? null : String(tier.from),
      toTier: tier?.to == null ? null : String(tier.to),
      createdAt: r.createdAt.toISOString(),
      firstDigestedAt: r.firstDigestedAt ?? null,
      triggerReason: coerceTriggerReason(r.triggerReason),
    };
  });

  return { totalUnacknowledged: total, rows: preview };
}

/**
 * Task #1145 — Count plan-migration audit rows that have been acknowledged
 * since `sinceMs` (typically the last digest dispatch). Used so the email
 * footer can reflect "X already acknowledged since the last digest", giving
 * recipients confidence their previous clicks landed.
 */
export async function getRecentlyAcknowledgedPlanMigrationsSummary(
  sinceMs: number,
): Promise<RecentlyAcknowledgedSummary> {
  const sinceIso = new Date(sinceMs).toISOString();
  const ACK_PREDICATE = and(
    eq(memberAuditLogTable.entity, "organization_subscription_tier"),
    eq(memberAuditLogTable.action, "migrate"),
    sql`(${memberAuditLogTable.metadata}->>'acknowledged') = 'true'`,
    sql`(${memberAuditLogTable.metadata}->>'acknowledgedAt') > ${sinceIso}`,
  );

  const [agg] = await db
    .select({
      count: count(),
      lastAcknowledgedAt: sql<string | null>`MAX(${memberAuditLogTable.metadata}->>'acknowledgedAt')`,
    })
    .from(memberAuditLogTable)
    .where(ACK_PREDICATE);

  const c = Number(agg?.count ?? 0);
  return {
    count: c,
    lastAcknowledgedAt: c > 0 ? (agg?.lastAcknowledgedAt ?? null) : null,
  };
}

/**
 * Dedup clock so the cron can tick hourly (to surface new rows quickly)
 * without spamming inboxes. 23h floor keeps the daily cadence in steady
 * state and matches the legacy bounced-levy digest pattern.
 *
 * Task #1551 — The clock is persisted onto the `metadata.lastDigestedAt`
 * field of every audit row included in a dispatched batch. The dedup check
 * reads `MAX(metadata->>'lastDigestedAt')` across all plan-migration audit
 * rows, so the floor survives process restarts (a deploy or crash inside
 * the 23h window no longer triggers a duplicate digest on the next cron
 * tick).
 */
const MIN_GAP_MS = 23 * 60 * 60 * 1000;

const PLAN_MIGRATION_PREDICATE = and(
  eq(memberAuditLogTable.entity, "organization_subscription_tier"),
  eq(memberAuditLogTable.action, "migrate"),
);

/**
 * Returns the most recent persisted dispatch timestamp (ms since epoch),
 * or `null` if no digest has ever been dispatched. Computed as
 * `MAX(metadata->>'lastDigestedAt')` across every plan-migration audit
 * row, so any dispatched batch — past or present — anchors the floor.
 */
async function getLastDigestSentAtMs(): Promise<number | null> {
  try {
    const [row] = await db
      .select({
        lastDigestedAt: sql<string | null>`MAX(${memberAuditLogTable.metadata}->>'lastDigestedAt')`,
      })
      .from(memberAuditLogTable)
      .where(PLAN_MIGRATION_PREDICATE);
    if (!row?.lastDigestedAt) return null;
    const ms = Date.parse(row.lastDigestedAt);
    return Number.isFinite(ms) ? ms : null;
  } catch (err) {
    // If the DB read fails we degrade by treating it as "no prior dispatch".
    // The downside is a possible duplicate digest in a transient-failure
    // window; the upside is we never silently skip a real digest because
    // the dedup query was unavailable.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[plan-migration-digest] failed to read persisted dedup floor — assuming no prior dispatch",
    );
    return null;
  }
}

/**
 * Test-only: clear the persisted dedup so a test can simulate a fresh
 * install. Removes `lastDigestedAt` from every plan-migration audit row's
 * metadata. Must be awaited.
 */
export async function _resetPlanMigrationDigestDedupForTest() {
  await db
    .update(memberAuditLogTable)
    .set({
      metadata: sql`COALESCE(${memberAuditLogTable.metadata}, '{}'::jsonb) - 'lastDigestedAt'`,
    })
    .where(PLAN_MIGRATION_PREDICATE);
}

type SuperAdminRow = {
  id: number;
  email: string | null;
  displayName: string | null;
  username: string | null;
};

async function loadSuperAdmins(): Promise<SuperAdminRow[]> {
  return db
    .select({
      id: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(appUsersTable)
    .where(eq(appUsersTable.role, "super_admin"));
}

function resolveBaseUrl(): string {
  return process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`;
}

/**
 * Persist dispatch metadata onto every row in the current batch:
 *   - `lastDigestedAt` is overwritten on every dispatch (Task #1551 — this
 *     is the persisted dedup clock; reading `MAX` of this across rows lets
 *     the 23h floor survive process restarts).
 *   - `firstDigestedAt` is stamped only when the row doesn't already have
 *     one (Task #1313 — monotonic, so the email's "first surfaced X days
 *     ago" line stays accurate across redispatches).
 *
 * Both fields are written in a single jsonb merge so the DB hit is one
 * UPDATE per dispatch regardless of how many fields we maintain. The
 * returned row objects mirror the new stamps so the email rendered for
 * this dispatch already shows the fresh "first surfaced" line.
 */
async function stampDispatchOnRows(
  rows: PlanMigrationDigestRow[],
  dispatchAt: string,
): Promise<PlanMigrationDigestRow[]> {
  if (rows.length === 0) return rows;

  const ids = rows.map((r) => r.id);
  // `firstDigestedAt` uses COALESCE against the existing value so it's
  // monotonic; `lastDigestedAt` is always overwritten with the current
  // dispatch time. The right-hand operand of `||` wins on key collision.
  const patch = sql`jsonb_build_object(
    'lastDigestedAt', ${dispatchAt}::text,
    'firstDigestedAt', COALESCE(${memberAuditLogTable.metadata}->>'firstDigestedAt', ${dispatchAt}::text)
  )`;

  try {
    await db
      .update(memberAuditLogTable)
      .set({
        metadata: sql`COALESCE(${memberAuditLogTable.metadata}, '{}'::jsonb) || ${patch}`,
      })
      .where(inArray(memberAuditLogTable.id, ids));
  } catch (err) {
    // Stamping failure is degraded gracefully so the email still goes out.
    // The downside is we may re-dispatch on the next cron tick (since the
    // persisted dedup floor wasn't advanced), which is a much better
    // failure mode than silently skipping a real digest.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), rowIds: ids },
      "[plan-migration-digest] failed to persist dispatch stamps — dedup floor not advanced",
    );
    return rows;
  }

  return rows.map((r) => (r.firstDigestedAt ? r : { ...r, firstDigestedAt: dispatchAt }));
}

/**
 * Email every super_admin with the given digest summary. Internal — also
 * advances the persisted dedup floor (Task #1551) by stamping
 * `lastDigestedAt` onto every row in the batch, so callers don't need to
 * track an in-memory clock.
 */
async function emailDigestToSuperAdmins(
  summary: PlanMigrationDigestSummary,
  superAdmins: SuperAdminRow[],
  recentlyAcknowledged: RecentlyAcknowledgedSummary,
  triggerReasonOverride: PlanMigrationTriggerReason | null = null,
): Promise<{ recipientsAttempted: number; recipientsEmailed: number }> {
  const recipients = superAdmins.filter((u): u is SuperAdminRow & { email: string } => Boolean(u.email));
  if (recipients.length === 0) {
    return { recipientsAttempted: 0, recipientsEmailed: 0 };
  }

  // Stamp once for the whole batch (before the per-recipient loop) so every
  // recipient sees the same "first surfaced" line, and so the persisted
  // dedup floor (`lastDigestedAt`) is advanced even if individual sends
  // throw — that keeps inboxes safe when SMTP is broken.
  const dispatchAt = new Date().toISOString();
  const rowsWithFirstSeen = await stampDispatchOnRows(summary.rows, dispatchAt);

  const baseUrl = resolveBaseUrl();
  const trimmedBase = baseUrl.replace(/\/$/, "");
  let emailed = 0;
  for (const rec of recipients) {
    try {
      // Per-recipient signed acknowledge links (Task #980). The token binds
      // both the audit row id AND this super admin's user id so the audit
      // log records who triaged when the link is clicked.
      const rowsWithLinks = rowsWithFirstSeen.map((r) => ({
        ...r,
        acknowledgeUrl: `${trimmedBase}/api/super-admin/plan-migration-audit/${r.id}/acknowledge-via-email?token=${encodeURIComponent(
          issuePlanMigrationAckToken({ auditId: r.id, userId: rec.id }),
        )}`,
      }));

      await sendPlanMigrationDigestEmail({
        to: rec.email,
        staffName: rec.displayName ?? rec.username ?? "Super Admin",
        baseUrl,
        totalUnacknowledged: summary.totalUnacknowledged,
        rows: rowsWithLinks,
        recentlyAcknowledged,
        // Task #1906 — when the realtime path supplies an explicit
        // trigger reason, prefer it (single-event dispatch). Otherwise
        // derive a uniform reason from the row metadata so the cron
        // digest still gets a specialised subject when every queued
        // row shares a trigger.
        triggerReason: triggerReasonOverride ?? uniformTriggerReason(rowsWithFirstSeen),
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), recipient: rec.email },
        "[plan-migration-digest] email failed",
      );
    }
  }
  return { recipientsAttempted: recipients.length, recipientsEmailed: emailed };
}

/**
 * Email all super_admins with an email address when at least one
 * unacknowledged plan-migration audit row exists. Returns delivery stats
 * for tests / logs. No-op when there are no unack rows or when the dedup
 * window has not elapsed since the last successful send.
 */
export async function sendPlanMigrationDigestToSuperAdmins(): Promise<{
  totalUnacknowledged: number;
  recipientsAttempted: number;
  recipientsEmailed: number;
  skipped?: "no-rows" | "deduped" | "no-recipients";
}> {
  const summary = await getUnacknowledgedPlanMigrationsSummary(20);
  if (summary.totalUnacknowledged === 0) {
    return { totalUnacknowledged: 0, recipientsAttempted: 0, recipientsEmailed: 0, skipped: "no-rows" };
  }

  // Task #1551 — read the dedup floor from the persisted `lastDigestedAt`
  // stamp so it survives process restarts. A deploy or crash inside the
  // 23h window will no longer trigger a duplicate digest on the next
  // cron tick.
  const now = Date.now();
  const lastDigestSentAtMs = await getLastDigestSentAtMs();
  if (lastDigestSentAtMs != null && now - lastDigestSentAtMs < MIN_GAP_MS) {
    return {
      totalUnacknowledged: summary.totalUnacknowledged,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      skipped: "deduped",
    };
  }

  const superAdmins = await loadSuperAdmins();
  const hasEmailRecipients = superAdmins.some((u) => Boolean(u.email));
  if (!hasEmailRecipients) {
    logger.warn(
      { totalUnacknowledged: summary.totalUnacknowledged },
      "[plan-migration-digest] no super_admin recipients with email — skipping",
    );
    return {
      totalUnacknowledged: summary.totalUnacknowledged,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      skipped: "no-recipients",
    };
  }

  // Task #1145 — surface acknowledgements that have happened since the last
  // dispatch so recipients see their previous clicks reflected. On first
  // boot (no prior dispatch) fall back to one digest window.
  const recentlyAcknowledged = await getRecentlyAcknowledgedPlanMigrationsSummary(
    lastDigestSentAtMs ?? (now - MIN_GAP_MS),
  );

  // Acknowledge URL generation per-recipient (Task #980) is handled inside
  // `emailDigestToSuperAdmins`, which also advances the persisted
  // `lastDigestedAt` dedup floor (Task #1551) for the rows in this batch.
  const { recipientsAttempted, recipientsEmailed } = await emailDigestToSuperAdmins(
    summary,
    superAdmins,
    recentlyAcknowledged,
  );

  logger.info(
    {
      totalUnacknowledged: summary.totalUnacknowledged,
      recipientsAttempted,
      recipientsEmailed,
    },
    "[plan-migration-digest] dispatched",
  );

  return {
    totalUnacknowledged: summary.totalUnacknowledged,
    recipientsAttempted,
    recipientsEmailed,
  };
}

/**
 * Task #979 — Real-time write-time hook for plan-migration audit rows.
 *
 * Use this from any code path that auto-resets a club's subscription tier
 * (e.g. an admin-triggered re-migration, a Stripe webhook handler that
 * detects an unknown tier). It:
 *   1. Records the `entity = 'organization_subscription_tier'` /
 *      `action = 'migrate'` audit row via {@link recordMemberAudit}, so the
 *      Plan Migration Audit panel and the hourly digest both see it.
 *   2. Immediately fans out an email AND in-app push to every super_admin,
 *      bypassing the 23h dedup so the alert lands within seconds rather
 *      than waiting up to ~1h for the cron tick.
 *   3. Stamps the dedup clock so the cron's next tick will skip the
 *      now-redundant daily digest for ~23h.
 *
 * The hourly cron in `cron.ts` remains the safety-net for legacy SQL
 * migration rows (`lib/db/drizzle/0056_normalize_subscription_tier.sql`)
 * which can't call into application code.
 */
export async function notifySuperAdminsOfPlanMigration(opts: {
  organizationId: number;
  fromTier: string | null;
  toTier: string;
  reason?: string;
  /**
   * Task #1906 — categorical trigger so the email subject + push title
   * can distinguish genuine paid-plan churn (`'cancelled'`) from a
   * slug-mapping bug (`'unknown_tier'`) and from admin re-migrations
   * (`'manual'`). Persisted on the audit row's
   * `metadata.triggerReason` so downstream consumers (audit panel,
   * future digests, dashboards) don't have to string-parse `reason`.
   * Required for new callers; existing callers should pass the most
   * accurate value rather than omit it.
   */
  triggerReason: PlanMigrationTriggerReason;
  /** Optional Express request so the audit row records the actor + IP. */
  req?: Request | null;
}): Promise<{
  auditRecorded: boolean;
  totalUnacknowledged: number;
  recipientsAttempted: number;
  recipientsEmailed: number;
  pushAttempted: number;
  pushSent: number;
}> {
  // 1. Record the audit row first so it's discoverable by the panel /
  //    digest even if the immediate fan-out below fails.
  await recordMemberAudit({
    req: opts.req ?? null,
    organizationId: opts.organizationId,
    clubMemberId: null,
    entity: "organization_subscription_tier",
    entityId: opts.organizationId,
    action: "migrate",
    changes: { tier: { from: opts.fromTier, to: opts.toTier } },
    reason: opts.reason ?? "Plan tier auto-reset",
    // Task #1906 — persist the trigger category so the panel + future
    // digests can render a chip + specialise wording without parsing
    // the free-text `reason`.
    metadata: { triggerReason: opts.triggerReason },
  });

  // 2. Pull a fresh summary (which now includes the row we just wrote).
  const summary = await getUnacknowledgedPlanMigrationsSummary(20);

  const superAdmins = await loadSuperAdmins();
  if (superAdmins.length === 0) {
    logger.warn(
      { organizationId: opts.organizationId },
      "[plan-migration-realtime] no super_admin users — alert skipped",
    );
    return {
      auditRecorded: true,
      totalUnacknowledged: summary.totalUnacknowledged,
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      pushAttempted: 0,
      pushSent: 0,
    };
  }

  // Task #1145 — include the "recently acknowledged" footer on the realtime
  // path too, using the persisted dedup clock (Task #1551) as the "since
  // last digest" anchor (or one digest window on first boot).
  const lastDigestSentAtMs = await getLastDigestSentAtMs();
  const recentlyAcknowledged = await getRecentlyAcknowledgedPlanMigrationsSummary(
    lastDigestSentAtMs ?? (Date.now() - MIN_GAP_MS),
  );

  // 3. Email immediately (no dedup gate on this realtime path).
  //    Task #1906 — pass the trigger reason through so the subject line
  //    distinguishes a paid-plan cancellation from an unknown-tier
  //    auto-reset, even though the digest summary may also include older
  //    rows from a different trigger.
  const { recipientsAttempted, recipientsEmailed } = await emailDigestToSuperAdmins(
    summary,
    superAdmins,
    recentlyAcknowledged,
    opts.triggerReason,
  );

  // 4. Push to every super_admin's registered devices. sendTransactionalPush
  //    is a no-op for users without a device token, so it's safe to fan-out
  //    to all of them.
  //    Task #1240 — we surface raw `pushAttempted` / `pushSent` counters in
  //    the dispatch log + return value rather than a per-user classification.
  //    This is intentionally telemetry-lite: alerts / digests for super
  //    admins do not branch on a "failed" status, so we avoid bringing in
  //    `classifyPushDelivery`. If we ever extend the response to flag
  //    delivery failures to a downstream alerting pipeline, switch to
  //    `classifyPushDelivery(result)` so the no-Expo-token recipients
  //    (Task #1070) are not booked as failures.
  const userIds = superAdmins.map((u) => u.id);
  const orgRow = summary.rows.find((r) => r.organizationId === opts.organizationId);
  const orgLabel = orgRow?.orgName ?? `Org #${opts.organizationId}`;
  // Task #1906 — distinguish the two very different events that share
  // this notification path so super admins can triage from the lock
  // screen alone. Genuine cancellations (`'cancelled'`) and admin
  // re-migrations (`'manual'`) are NOT bugs; the unknown-tier branch
  // (`'unknown_tier'`) is. Conflating all three behind "Club auto-reset
  // to Free" hides churn behind slug-mapping noise.
  const pushTitle = planMigrationPushTitle(opts.triggerReason);
  const pushBody = `${orgLabel} reset ${opts.fromTier ?? "unknown"} → ${opts.toTier}. Tap to review.`;
  let pushAttempted = 0;
  let pushSent = 0;
  try {
    const result = await sendTransactionalPush(userIds, pushTitle, pushBody, {
      type: "plan_migration_audit",
      organizationId: opts.organizationId,
      fromTier: opts.fromTier,
      toTier: opts.toTier,
      triggerReason: opts.triggerReason,
    });
    pushAttempted = result.attempted;
    pushSent = result.sent;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), organizationId: opts.organizationId },
      "[plan-migration-realtime] push fan-out failed",
    );
  }

  // 5. Belt-and-braces: advance the persisted dedup floor (Task #1551) so
  //    the next hourly cron tick skips the duplicate daily digest. The
  //    common case is already covered by `stampDispatchOnRows` inside
  //    `emailDigestToSuperAdmins`, but that early-returns without stamping
  //    if NO super admin has an email — in that edge case we still want
  //    to advance the floor here so the cron doesn't keep re-firing.
  await stampDispatchOnRows(summary.rows, new Date().toISOString());

  logger.info(
    {
      organizationId: opts.organizationId,
      fromTier: opts.fromTier,
      toTier: opts.toTier,
      totalUnacknowledged: summary.totalUnacknowledged,
      recipientsAttempted,
      recipientsEmailed,
      pushAttempted,
      pushSent,
    },
    "[plan-migration-realtime] dispatched",
  );

  return {
    auditRecorded: true,
    totalUnacknowledged: summary.totalUnacknowledged,
    recipientsAttempted,
    recipientsEmailed,
    pushAttempted,
    pushSent,
  };
}
