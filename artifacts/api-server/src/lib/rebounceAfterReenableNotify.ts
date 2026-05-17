/**
 * Task #1927 — When the Postmark webhook records a fresh "bounced"
 * suppression for an address that an admin re-enabled in the last 14
 * days (via the Suppressions "Re-enable" / "Re-enable + replace" flow,
 * Tasks #1311 / #1548), email the actor admin so they can follow up
 * promptly without polling the Marketing dashboard.
 *
 * Matching mirrors the existing `recentReenable` enrichment in
 * `routes/marketing.ts`:
 *   - Look at `member_audit_log` rows with
 *     `entity = 'email_suppression'` and
 *     `action in ('reenable', 'reenable_with_replacement')` for the org,
 *     created in the last 14 days, ordered by `createdAt` desc.
 *   - Match the bounced address against `metadata.oldEmail` or
 *     `metadata.replacementEmail` (case-insensitive). First match wins
 *     (most recent re-enable).
 *
 * Rate-limit:
 *   - We refuse to email the same actor about the same address more
 *     than once per re-enable cycle. A "cycle" begins at the matched
 *     re-enable audit row's `createdAt`. After we attempt the email
 *     (whether or not delivery succeeded) we drop a marker audit row
 *     with `action = 'rebounce_admin_notified'` so a flapping mailbox
 *     can't spam the admin. The next time the address bounces inside
 *     the same window, the marker is older than the re-enable but
 *     newer than the previous bounce, so we skip.
 *   - When the admin re-enables the address again (writing a new
 *     `reenable` row), the matched re-enable's `createdAt` advances
 *     past the marker and the next bounce is eligible to notify
 *     again. This is the "new cycle" semantics.
 *
 * Best-effort:
 *   - Every failure path is caught and logged; the helper never throws.
 *     The Postmark webhook has already committed the suppression by the
 *     time we run, so a delivery glitch must not roll it back or 500
 *     the API call.
 *   - We always write the marker audit row when we attempted delivery,
 *     even if the email send failed. Otherwise a transient Postmark
 *     hiccup would cause the next bounce to retry the email and the
 *     one after to retry again, etc., potentially spamming the admin
 *     once the provider recovers.
 *   - Self-actions (admin re-enabled their own address and it bounced
 *     again on their own mailbox) still notify — there's no "self"
 *     short-circuit because the bounce is happening to the admin's
 *     own external mailbox, not to a user account they're managing.
 */
import { db } from "@workspace/db";
import {
  appUsersTable,
  memberAuditLogTable,
  organizationsTable,
} from "@workspace/db";
import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import {
  sendReBouncedAfterReenableAdminEmail,
  type EmailBranding,
} from "./mailer";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "rebounce-after-reenable-notify" });

/** Public marker action so callers/tests can reference the same string. */
export const REBOUNCE_NOTIFIED_ACTION = "rebounce_admin_notified";

/** Window we look back for a recent re-enable. Mirrors marketing.ts. */
export const REENABLE_LOOKBACK_DAYS = 14;

export interface RebounceAfterReenableOpts {
  organizationId: number;
  /** The address that just bounced again (any case). */
  email: string;
  /** Suppression row id the bounce just refreshed/inserted. */
  suppressionId: number;
  /** Postmark Type field from the bounce payload (may be null). */
  bounceType: string | null;
  /** Postmark Description / fallback bounce-summary (may be null). */
  description: string | null;
  /** When the bounce arrived. Defaults to now(). */
  bouncedAt?: Date;
}

export type RebounceAfterReenableStatus =
  | "sent"
  | "skipped"
  | "failed";

export interface RebounceAfterReenableResult {
  status: RebounceAfterReenableStatus;
  /**
   * Reason for the outcome — useful in tests / logs. Examples:
   *   - "no_recent_reenable"  — no matching audit row in the window
   *   - "no_admin"            — audit row had no actor user
   *   - "no_admin_email"      — admin has no email address on file
   *   - "rate_limited"        — already notified this admin+address
   *                             since the re-enable
   *   - "self_action"         — n/a (kept for symmetry with sibling
   *                             helpers; not actually used here)
   *   - "delivery_failed"     — email send threw
   *   - "marker_failed"       — couldn't write the rate-limit marker
   *                             (we still report the email outcome)
   */
  reason?: string;
  adminUserId?: number;
}

function baseUrl(): string {
  return (
    process.env.APP_BASE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`
  ).replace(/\/$/, "");
}

interface MatchedReenable {
  id: number;
  createdAt: Date;
  actorUserId: number | null;
  actorName: string | null;
  action: string;
  hadReplacement: boolean;
}

/**
 * Find the most recent reenable / reenable_with_replacement audit row
 * for this org+email within the lookback window. Returns null when no
 * match exists.
 */
async function findRecentReenable(
  orgId: number,
  email: string,
  bouncedAt: Date,
): Promise<MatchedReenable | null> {
  const lower = email.toLowerCase();
  const cutoff = new Date(
    bouncedAt.getTime() - REENABLE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const rows = await db
    .select({
      id: memberAuditLogTable.id,
      createdAt: memberAuditLogTable.createdAt,
      actorUserId: memberAuditLogTable.actorUserId,
      actorName: memberAuditLogTable.actorName,
      action: memberAuditLogTable.action,
      metadata: memberAuditLogTable.metadata,
    })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "email_suppression"),
      inArray(memberAuditLogTable.action, ["reenable", "reenable_with_replacement"]),
      gte(memberAuditLogTable.createdAt, cutoff),
    ))
    .orderBy(desc(memberAuditLogTable.createdAt));

  for (const r of rows) {
    const md = (r.metadata ?? {}) as { oldEmail?: unknown; replacementEmail?: unknown };
    const oldEmail = typeof md.oldEmail === "string" ? md.oldEmail.toLowerCase() : null;
    const replacementEmail = typeof md.replacementEmail === "string" ? md.replacementEmail.toLowerCase() : null;
    if (oldEmail !== lower && replacementEmail !== lower) continue;
    const created = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string);
    // The audit must predate this bounce — otherwise the suppression
    // existed *before* the re-enable attempt (which would be the same
    // row being re-deleted, not a re-bounce).
    if (created.getTime() > bouncedAt.getTime()) continue;
    return {
      id: r.id,
      createdAt: created,
      actorUserId: r.actorUserId ?? null,
      actorName: r.actorName ?? null,
      action: r.action,
      hadReplacement: r.action === "reenable_with_replacement",
    };
  }
  return null;
}

/**
 * Was a `rebounce_admin_notified` marker already written for this
 * (org, email, admin) since the matched re-enable? Used to gate the
 * email so a flapping mailbox can't spam the admin.
 */
async function alreadyNotifiedSince(
  orgId: number,
  email: string,
  adminUserId: number,
  since: Date,
): Promise<boolean> {
  const lower = email.toLowerCase();
  const rows = await db
    .select({ id: memberAuditLogTable.id })
    .from(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, orgId),
      eq(memberAuditLogTable.entity, "email_suppression"),
      eq(memberAuditLogTable.action, REBOUNCE_NOTIFIED_ACTION),
      gt(memberAuditLogTable.createdAt, since),
      sql`${memberAuditLogTable.metadata}->>'email' = ${lower}`,
      sql`(${memberAuditLogTable.metadata}->>'adminUserId')::int = ${adminUserId}`,
    ))
    .limit(1);
  return rows.length > 0;
}

async function writeMarker(
  orgId: number,
  email: string,
  adminUserId: number,
  suppressionId: number,
  reenableAuditId: number,
  delivery: { status: RebounceAfterReenableStatus; reason?: string },
): Promise<void> {
  await db.insert(memberAuditLogTable).values({
    organizationId: orgId,
    clubMemberId: null,
    actorUserId: null,
    actorName: "system",
    actorRole: null,
    entity: "email_suppression",
    entityId: suppressionId,
    action: REBOUNCE_NOTIFIED_ACTION,
    fieldChanges: null,
    reason: `Re-bounce notification ${delivery.status} for admin #${adminUserId}`,
    metadata: {
      email: email.toLowerCase(),
      adminUserId,
      reenableAuditId,
      deliveryStatus: delivery.status,
      ...(delivery.reason ? { deliveryError: delivery.reason } : {}),
    },
    ipAddress: null,
    userAgent: null,
  });
}

export async function notifyAdminOfReBounceAfterReenable(
  opts: RebounceAfterReenableOpts,
): Promise<RebounceAfterReenableResult> {
  const result: RebounceAfterReenableResult = { status: "skipped" };
  if (!Number.isInteger(opts.organizationId) || !opts.email) {
    result.reason = "invalid_input";
    return result;
  }
  const bouncedAt = opts.bouncedAt ?? new Date();
  try {
    const matched = await findRecentReenable(opts.organizationId, opts.email, bouncedAt);
    if (!matched) {
      result.reason = "no_recent_reenable";
      return result;
    }
    if (matched.actorUserId == null) {
      result.reason = "no_admin";
      return result;
    }
    result.adminUserId = matched.actorUserId;

    if (await alreadyNotifiedSince(
      opts.organizationId,
      opts.email,
      matched.actorUserId,
      matched.createdAt,
    )) {
      result.reason = "rate_limited";
      return result;
    }

    // Resolve admin profile (email + display name) and org branding in
    // parallel — both are needed for the email body.
    const [adminRow, orgRow] = await Promise.all([
      db.select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, matched.actorUserId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      })
        .from(organizationsTable)
        .where(eq(organizationsTable.id, opts.organizationId))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const adminEmail = (adminRow?.email ?? "").trim();
    if (!adminEmail) {
      result.reason = "no_admin_email";
      return result;
    }

    const branding: EmailBranding = {
      orgName: orgRow?.name ?? "KHARAGOLF",
      logoUrl: orgRow?.logoUrl ?? undefined,
      primaryColor: orgRow?.primaryColor ?? undefined,
      orgId: opts.organizationId,
    };
    const adminName = (adminRow?.displayName ?? adminRow?.username ?? matched.actorName ?? "").toString().trim() || null;
    const suppressionsUrl = `${baseUrl()}/marketing`;

    let delivery: { status: RebounceAfterReenableStatus; reason?: string } = { status: "sent" };
    try {
      await sendReBouncedAfterReenableAdminEmail({
        to: adminEmail,
        adminName,
        reboundedEmail: opts.email,
        bounceType: opts.bounceType,
        description: opts.description,
        reenabledAt: matched.createdAt,
        reenableHadReplacement: matched.hadReplacement,
        bouncedAt,
        suppressionsUrl,
        branding,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      delivery = { status: "failed", reason };
      logger.warn(
        { err, orgId: opts.organizationId, email: opts.email, adminUserId: matched.actorUserId },
        "[rebounce-after-reenable-notify] email delivery failed",
      );
    }

    // Always drop the marker — see header comment for why we don't
    // gate on delivery success (avoids retry-spam once the provider
    // recovers).
    try {
      await writeMarker(
        opts.organizationId,
        opts.email,
        matched.actorUserId,
        opts.suppressionId,
        matched.id,
        delivery,
      );
    } catch (markerErr) {
      logger.warn(
        { err: markerErr, orgId: opts.organizationId, email: opts.email, adminUserId: matched.actorUserId },
        "[rebounce-after-reenable-notify] failed to write rate-limit marker",
      );
      if (delivery.status === "sent") {
        result.status = "sent";
        result.reason = "marker_failed";
        return result;
      }
    }

    result.status = delivery.status;
    if (delivery.status === "failed") {
      result.reason = delivery.reason ?? "delivery_failed";
    }
    return result;
  } catch (err) {
    logger.warn(
      { err, orgId: opts.organizationId, email: opts.email },
      "[rebounce-after-reenable-notify] unexpected failure",
    );
    result.status = "failed";
    result.reason = err instanceof Error ? err.message : String(err);
    return result;
  }
}
