/**
 * Coach payout-account change notification (Task #915).
 *
 * Fires after a successful create/update of a coach's payout account
 * (POST /api/coach-marketplace/me/payout-account confirm leg). Sends a
 * security-style email alert to the coach summarising:
 *   - what changed (created vs updated)
 *   - the masked account details we just persisted
 *   - who made the change (the coach themselves, or an org/super admin)
 *   - when it happened and from which IP
 *   - a deep-link back to the workspace payout-history list
 *
 * The intent is to alert coaches to unauthorised account changes much
 * faster than waiting for them to open the workspace, mirroring how
 * banks send a "card added" alert.
 *
 * Entirely best-effort: every failure path is logged but never thrown,
 * so the underlying payout-account save (which has already committed)
 * is never retried or rolled back because of a delivery glitch.
 *
 * Driven off the persisted `coachPayoutAccountHistoryTable` row so the
 * email content matches the audit log byte-for-byte.
 */
import { db } from "@workspace/db";
import {
  coachPayoutAccountHistoryTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  type CoachPayoutAccountChangeNotifyAttempt,
  teachingProsTable,
  appUsersTable,
  organizationsTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberMessagesTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
  notificationDigestQueueTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  sendCoachPayoutAccountChangedEmail,
  sendCoachPayoutAccountChangedAdminEmail,
  classifyMailerError,
  type EmailBranding,
} from "./mailer";
import { sendPushToUsers, classifyPushDelivery, type PushDeliveryResult } from "./push";
import { sendTransactionalSms, sendTransactionalWhatsapp } from "./comms";
import { logger as baseLogger } from "./logger";

const logger = baseLogger.child({ module: "coach-payout-account-change-notify" });

export type CoachPayoutNotifyChannelStatus =
  | "sent"
  | "failed"
  | "skipped"
  | "opted_out"
  | "no_address";

export interface CoachPayoutAccountChangeNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  email: { status: CoachPayoutNotifyChannelStatus; error?: string };
  inApp: { status: CoachPayoutNotifyChannelStatus; messageId?: number; error?: string };
  push: { status: CoachPayoutNotifyChannelStatus; error?: string };
  // Task #1864 — SMS / WhatsApp legs gated on the coach's
  // billing-category `member_comm_prefs` opt-in. Schema defaults are
  // OFF — opt-in is via the member preferences screens. Mirrors the
  // wallet-topup-refund channel rollup (Task #1508).
  sms: { status: CoachPayoutNotifyChannelStatus; error?: string };
  whatsapp: { status: CoachPayoutNotifyChannelStatus; error?: string };
}

/**
 * Task #1864 — load the coach's phone number and billing-category
 * SMS / WhatsApp opt-in flags. Mirrors `loadBillingPrefAndPhone` in
 * `walletTopupRefundNotify.ts` so the coach payout-account-change
 * security alert reuses the same opt-in surface members already see in
 * the web portal Notifications tab and the mobile my-360 screen. When
 * the coach has no `club_members` row in the org we have no place to
 * store the opt-in either — treat the channel as opted-out (no_address
 * if otherwise eligible) so we never blast a phone we don't have a
 * documented opt-in for.
 */
async function loadBillingPrefAndPhone(
  organizationId: number,
  userId: number,
): Promise<{
  phone: string | null;
  smsEnabled: boolean;
  whatsappEnabled: boolean;
}> {
  let phone: string | null = null;
  let clubMemberId: number | null = null;
  try {
    const [m] = await db
      .select({ id: clubMembersTable.id, phone: clubMembersTable.phone })
      .from(clubMembersTable)
      .where(and(
        eq(clubMembersTable.organizationId, organizationId),
        eq(clubMembersTable.userId, userId),
      ))
      .limit(1);
    if (m) {
      clubMemberId = m.id;
      phone = m.phone ?? null;
    }
  } catch {
    // best-effort
  }

  let smsEnabled = false;
  let whatsappEnabled = false;
  if (clubMemberId) {
    try {
      const [pref] = await db
        .select({
          smsEnabled: memberCommPrefsTable.smsEnabled,
          whatsappEnabled: memberCommPrefsTable.whatsappEnabled,
        })
        .from(memberCommPrefsTable)
        .where(and(
          eq(memberCommPrefsTable.clubMemberId, clubMemberId),
          eq(memberCommPrefsTable.category, "billing"),
        ))
        .limit(1);
      if (pref) {
        smsEnabled = Boolean(pref.smsEnabled);
        whatsappEnabled = Boolean(pref.whatsappEnabled);
      }
    } catch {
      // best-effort — fall through with the schema defaults.
    }
  }

  return { phone, smsEnabled, whatsappEnabled };
}

/**
 * Task #1864 — short-form security alert body shared between the
 * initial SMS / WhatsApp send and the retry helpers. Mirrors the push
 * body so a coach who only ever reads the SMS sees the same call to
 * action as a coach who only ever reads the push.
 */
function buildShortBodyForChannel(
  changeKind: "created" | "updated",
  method: "upi" | "bank_account",
): string {
  const methodLabel = method === "upi" ? "UPI" : "bank account";
  const title = changeKind === "created"
    ? `Payout ${methodLabel} added`
    : `Payout ${methodLabel} updated`;
  const body = `Your payout ${methodLabel} was ${changeKind}. If this wasn't you, review your payout history.`;
  return `${title}\n${body}`;
}

function workspaceHistoryUrl(): string {
  const base = process.env.PUBLIC_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://kharagolf.com");
  return `${base.replace(/\/$/, "")}/coach-workspace#payout-history`;
}

// Task #2135 — keep this list in sync with `PAYOUT_HISTORY_CHANGE_KINDS`
// in `routes/coach-marketplace.ts` and `CHANGE_KIND_FILTER_OPTIONS` in
// `pages/coach-admin.tsx`. The dialog's `parsePayoutHistoryHash` falls
// back to the "All" filter for unknown values, so unrecognised kinds
// downgrade to the bare hash here rather than emitting a hash the
// dialog will silently ignore.
const ADMIN_HISTORY_HASH_CHANGE_KINDS = new Set<string>([
  "created",
  "updated",
  "admin_reverify",
]);

function adminPayoutHistoryUrl(proId: number, changeKind?: string | null): string {
  const base = process.env.PUBLIC_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "https://kharagolf.com");
  // Task #2135 — when the email is about a specific change kind, append
  // the matching `=changeKind` filter to the URL hash so the per-coach
  // payout-history dialog opens already filtered to that chip (e.g. an
  // `admin_reverify` notice lands on the "Admin re-verifications" chip
  // instead of the unfiltered list, sparing the admin a manual click).
  const hash = changeKind && ADMIN_HISTORY_HASH_CHANGE_KINDS.has(changeKind)
    ? `#payout-history=${changeKind}`
    : "#payout-history";
  return `${base.replace(/\/$/, "")}/coach-admin?coach=${proId}${hash}`;
}

const ADMIN_NOTIFY_KEY = "coach.payout.account.changed.admin";
const COACH_NOTIFY_KEY = "coach.payout.account.changed.coach";

export async function notifyCoachPayoutAccountChanged(
  historyId: number,
): Promise<CoachPayoutAccountChangeNotifyResult> {
  const result: CoachPayoutAccountChangeNotifyResult = {
    status: "skipped",
    email: { status: "skipped" },
    inApp: { status: "skipped" },
    push: { status: "skipped" },
    sms: { status: "skipped" },
    whatsapp: { status: "skipped" },
  };
  try {
    const [row] = await db.select({
      history: coachPayoutAccountHistoryTable,
      pro: teachingProsTable,
    })
      .from(coachPayoutAccountHistoryTable)
      .innerJoin(teachingProsTable, eq(teachingProsTable.id, coachPayoutAccountHistoryTable.proId))
      .where(eq(coachPayoutAccountHistoryTable.id, historyId))
      .limit(1);

    if (!row) {
      result.reason = "history_row_not_found";
      return result;
    }
    const { history, pro } = row;

    if (!pro.userId) {
      result.reason = "pro_has_no_app_user";
      return result;
    }
    const coachUserId = pro.userId;

    const [coachUser] = await db.select({
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, pro.userId))
      .limit(1);

    const to = coachUser?.email?.trim() ?? "";
    const coachName = (coachUser?.displayName || coachUser?.username || pro.displayName || "").trim();

    let changedByName = "";
    if (history.changedByUserId && history.changedByUserId !== pro.userId) {
      const [actor] = await db.select({
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
        .from(appUsersTable)
        .where(eq(appUsersTable.id, history.changedByUserId))
        .limit(1);
      changedByName = (actor?.displayName || actor?.username || "").trim();
    } else if (history.changedByUserId === pro.userId) {
      changedByName = coachName || "the coach";
    }
    if (!changedByName) changedByName = history.changedByRole === "admin" ? "An administrator" : "The coach";

    let branding: EmailBranding = { orgName: "KHARAGOLF" };
    try {
      const [org] = await db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      }).from(organizationsTable).where(eq(organizationsTable.id, history.organizationId)).limit(1);
      if (org) {
        branding = {
          orgName: org.name ?? "KHARAGOLF",
          logoUrl: org.logoUrl ?? undefined,
          primaryColor: org.primaryColor ?? undefined,
        };
      }
    } catch (err) {
      logger.warn({ err, historyId }, "failed to load org branding for payout-change email");
    }

    const method = (history.method === "upi" || history.method === "bank_account")
      ? history.method as "upi" | "bank_account"
      : "upi";
    const changeKind = history.changeKind === "created" ? "created" : "updated";
    const changedByRole = history.changedByRole === "admin" ? "admin" : "coach";

    // ── Email ───────────────────────────────────────────────────────────
    if (!to) {
      result.email.status = "no_address";
    } else {
      try {
        await sendCoachPayoutAccountChangedEmail({
          to,
          coachName,
          changeKind,
          method,
          accountHolderName: history.accountHolderName ?? null,
          upiVpaMasked: history.upiVpaMasked ?? null,
          bankAccountLast4: history.bankAccountLast4 ?? null,
          bankIfsc: history.bankIfsc ?? null,
          changedByName,
          changedByRole,
          changedAt: history.createdAt,
          ipAddress: history.ipAddress ?? null,
          historyUrl: workspaceHistoryUrl(),
          branding,
        });
        result.email.status = "sent";
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Provider misconfiguration → terminal `skipped`. The cron's
        // retry helper checks emailStatus === "failed", so a `skipped`
        // here naturally stops the row being re-selected and avoids
        // billing the admin's inbox for an env issue.
        if (classifyMailerError(err) === "provider_unconfigured") {
          result.email.status = "skipped";
          result.email.error = "provider_not_configured";
        } else {
          result.email.status = "failed";
          result.email.error = reason;
          logger.warn({ err, historyId }, "[coach-payout-account-change-notify] email delivery failed");
        }
      }
    }

    // ── In-app inbox row ────────────────────────────────────────────────
    // Mirrors the side-game settlement-paid pattern: we only write a row
    // when the coach has an active club_members row in the org that owns
    // this payout account, since the inbox is keyed off clubMemberId.
    const methodLabel = method === "upi" ? "UPI" : "bank account";
    const inAppTitle = changeKind === "created"
      ? `Payout ${methodLabel} added`
      : `Payout ${methodLabel} updated`;
    const actorPhrase = history.changedByUserId === coachUserId
      ? "by you"
      : `by ${changedByName}`;
    const inAppBody = `Your payout ${methodLabel} was ${changeKind} ${actorPhrase}. If this wasn't you, review your payout history.`;

    try {
      const [member] = await db.select({ id: clubMembersTable.id })
        .from(clubMembersTable)
        .where(and(
          eq(clubMembersTable.organizationId, history.organizationId),
          eq(clubMembersTable.userId, coachUserId),
        ))
        .limit(1);
      if (!member) {
        result.inApp.status = "skipped";
      } else {
        const [msg] = await db.insert(memberMessagesTable).values({
          organizationId: history.organizationId,
          clubMemberId: member.id,
          channel: "in_app",
          subject: inAppTitle,
          body: inAppBody,
          status: "sent",
          relatedEntity: "coach_payout_account_history",
          relatedEntityId: history.id,
        }).returning({ id: memberMessagesTable.id });
        result.inApp.status = "sent";
        result.inApp.messageId = msg?.id;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.inApp.status = "failed";
      result.inApp.error = reason;
      logger.warn({ err, historyId }, "[coach-payout-account-change-notify] in-app insert failed");
    }

    // ── Push ────────────────────────────────────────────────────────────
    // Task #2122 — capture the per-device delivery counters so we can
    // include them in the coach-side push audit row's payload below. When
    // a coach disputes whether their phone was reached, this lets an
    // admin see "2 of 3 of your devices got it; the third token was
    // invalid" without another database round-trip.
    let pushDeliverySummary: PushDeliveryResult | null = null;
    try {
      const [pref] = await db.select({ preferPush: userNotificationPrefsTable.preferPush })
        .from(userNotificationPrefsTable)
        .where(eq(userNotificationPrefsTable.userId, coachUserId))
        .limit(1);
      const preferPush = pref?.preferPush ?? true;
      if (!preferPush) {
        result.push.status = "opted_out";
      } else {
        const push = await sendPushToUsers([coachUserId], inAppTitle, inAppBody, {
          type: "coach_payout_account_changed",
          historyId: history.id,
          proId: pro.id,
          organizationId: history.organizationId,
          changeKind,
          method,
        });
        pushDeliverySummary = push;
        // Task #1070 — share the classifier with the other notify helpers
        // so coaches without a linked device aren't reported as a push
        // failure.
        result.push.status = classifyPushDelivery(push);
        if (result.push.status === "failed") {
          result.push.error = "push_delivery_failed";
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.push.status = "failed";
      result.push.error = reason;
      logger.warn({ err, historyId }, "[coach-payout-account-change-notify] push delivery failed");
    }

    // ── SMS + WhatsApp (Task #1864) ─────────────────────────────────────
    // Mirrors the wallet-topup-refund SMS/WhatsApp pipeline (Task #1508):
    // both channels are gated on the coach's billing-category opt-in
    // (schema defaults are OFF) and the phone is loaded from the
    // `club_members` row in this org. Each leg is best-effort and keyed
    // off its own status so a Twilio outage on one channel can't
    // poison the other.
    const { phone, smsEnabled, whatsappEnabled } = await loadBillingPrefAndPhone(
      history.organizationId,
      coachUserId,
    );
    const shortBody = buildShortBodyForChannel(changeKind, method);

    if (!smsEnabled) {
      result.sms.status = "opted_out";
    } else if (!phone) {
      result.sms.status = "no_address";
    } else {
      try {
        await sendTransactionalSms(phone, shortBody.slice(0, 320));
        result.sms.status = "sent";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/SMS_PROVIDER not configured/i.test(msg)) {
          result.sms.status = "skipped";
          result.sms.error = "provider_not_configured";
        } else {
          result.sms.status = "failed";
          result.sms.error = msg;
          logger.warn({ err, historyId }, "[coach-payout-account-change-notify] SMS delivery failed");
        }
      }
    }

    if (!whatsappEnabled) {
      result.whatsapp.status = "opted_out";
    } else if (!phone) {
      result.whatsapp.status = "no_address";
    } else {
      try {
        await sendTransactionalWhatsapp(phone, shortBody.slice(0, 1024));
        result.whatsapp.status = "sent";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(msg)) {
          result.whatsapp.status = "skipped";
          result.whatsapp.error = "provider_not_configured";
        } else {
          result.whatsapp.status = "failed";
          result.whatsapp.error = msg;
          logger.warn({ err, historyId }, "[coach-payout-account-change-notify] WhatsApp delivery failed");
        }
      }
    }

    const statuses = [
      result.email.status,
      result.inApp.status,
      result.push.status,
      result.sms.status,
      result.whatsapp.status,
    ];
    if (statuses.includes("sent")) {
      result.status = "sent";
    } else if (statuses.includes("failed")) {
      result.status = "failed";
      result.reason = result.email.error
        ?? result.inApp.error
        ?? result.push.error
        ?? result.sms.error
        ?? result.whatsapp.error;
    } else {
      result.status = "skipped";
      if (result.email.status === "no_address" && !result.reason) {
        result.reason = "no_coach_email";
      }
    }

    // ── Per-channel audit rows (Task #1406) ─────────────────────────
    // The admin-facing fanout (notifyOrgAdminsCoachPayoutAccountChanged
    // below) writes one notification_audit_log row per recipient so any
    // dispatch can be traced end-to-end. The coach-side fanout used to
    // write zero rows, leaving us nothing to point at when a coach
    // disputed whether they were ever notified about an account change.
    // We mirror the admin pattern here: one row per leg (email, in-app,
    // push), keyed by `coach.payout.account.changed.coach`, attributed to
    // the coach's userId, with the per-leg status + a reason when
    // applicable. Best-effort — a failure to record audit must NOT
    // unwind the (already-committed) save or alter the notify result.
    const auditPayload = {
      historyId: history.id,
      proId: pro.id,
      organizationId: history.organizationId,
      changeKind,
      method,
      changedByUserId: history.changedByUserId,
      changedByRole,
    };
    const auditEntries: Array<{
      channel: "email" | "in_app" | "push" | "sms" | "whatsapp";
      status: CoachPayoutNotifyChannelStatus;
      error?: string;
      defaultReason?: string;
      extraPayload?: Record<string, unknown>;
    }> = [
      {
        channel: "email",
        status: result.email.status,
        error: result.email.error,
        defaultReason: result.email.status === "no_address" ? "no_email_on_file" : undefined,
      },
      {
        channel: "in_app",
        status: result.inApp.status,
        error: result.inApp.error,
        defaultReason: result.inApp.status === "skipped" ? "no_club_member_in_org" : undefined,
      },
      {
        channel: "push",
        status: result.push.status,
        error: result.push.error,
        defaultReason: result.push.status === "opted_out"
          ? "push_opted_out"
          : result.push.status === "no_address"
            ? "no_push_token"
            : undefined,
        // Task #2122 — surface device-level push delivery counters in the
        // audit row's payload so admins can answer disputes about which
        // of a coach's devices actually received the alert.
        extraPayload: pushDeliverySummary
          ? {
              pushDelivery: {
                attempted: pushDeliverySummary.attempted,
                sent: pushDeliverySummary.sent,
                failed: pushDeliverySummary.failed,
                invalid: pushDeliverySummary.invalid,
              },
            }
          : undefined,
      },
      {
        channel: "sms",
        status: result.sms.status,
        error: result.sms.error,
        defaultReason: result.sms.status === "opted_out"
          ? "sms_opted_out"
          : result.sms.status === "no_address"
            ? "no_phone_on_file"
            : undefined,
      },
      {
        channel: "whatsapp",
        status: result.whatsapp.status,
        error: result.whatsapp.error,
        defaultReason: result.whatsapp.status === "opted_out"
          ? "whatsapp_opted_out"
          : result.whatsapp.status === "no_address"
            ? "no_phone_on_file"
            : undefined,
      },
    ];
    for (const entry of auditEntries) {
      try {
        await db.insert(notificationAuditLogTable).values({
          notificationKey: COACH_NOTIFY_KEY,
          userId: coachUserId,
          channel: entry.channel,
          status: entry.status,
          reason: entry.error ?? entry.defaultReason ?? null,
          payload: entry.extraPayload
            ? { ...auditPayload, ...entry.extraPayload }
            : auditPayload,
        });
      } catch (auditErr) {
        logger.warn(
          { err: auditErr, historyId, channel: entry.channel },
          "[coach-payout-account-change-notify] coach audit insert failed",
        );
      }
    }

    // ── Persist attempts row (Task #1280) ───────────────────────────
    // One row per historyId — the coach-marketplace route invokes this
    // helper exactly once per account-change save. The unique index
    // also defends against an in-process re-fire. Best-effort: a
    // failure to persist this row never alters the notify outcome the
    // caller sees.
    try {
      const now = new Date();
      const emailAttempted = result.email.status === "sent" || result.email.status === "failed";
      const pushAttempted = result.push.status === "sent" || result.push.status === "failed";
      const smsAttempted = result.sms.status === "sent" || result.sms.status === "failed";
      const whatsappAttempted = result.whatsapp.status === "sent" || result.whatsapp.status === "failed";
      const nextEmail = result.email.status === "failed" ? computeNextRetryAt(1, now) : null;
      const nextPush = result.push.status === "failed" ? computeNextRetryAt(1, now) : null;
      const nextSms = result.sms.status === "failed" ? computeNextRetryAt(1, now) : null;
      const nextWhatsapp = result.whatsapp.status === "failed" ? computeNextRetryAt(1, now) : null;
      await db.insert(coachPayoutAccountChangeNotifyAttemptsTable).values({
        historyId: history.id,
        organizationId: history.organizationId,
        proId: pro.id,
        coachUserId: coachUserId,
        changeKind,
        method,
        emailStatus: result.email.status,
        emailAttempts: emailAttempted ? 1 : 0,
        lastEmailAt: emailAttempted ? now : null,
        lastEmailError: result.email.error ?? null,
        nextEmailRetryAt: nextEmail,
        pushStatus: result.push.status,
        pushAttempts: pushAttempted ? 1 : 0,
        lastPushAt: pushAttempted ? now : null,
        lastPushError: result.push.error ?? null,
        nextPushRetryAt: nextPush,
        smsStatus: result.sms.status,
        smsAttempts: smsAttempted ? 1 : 0,
        lastSmsAt: smsAttempted ? now : null,
        lastSmsError: result.sms.error ?? null,
        nextSmsRetryAt: nextSms,
        whatsappStatus: result.whatsapp.status,
        whatsappAttempts: whatsappAttempted ? 1 : 0,
        lastWhatsappAt: whatsappAttempted ? now : null,
        lastWhatsappError: result.whatsapp.error ?? null,
        nextWhatsappRetryAt: nextWhatsapp,
      }).onConflictDoNothing({
        target: coachPayoutAccountChangeNotifyAttemptsTable.historyId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(
        { historyId, errMsg: reason },
        "[coach-payout-account-change-notify] Failed to record retry-attempts row",
      );
    }

    // Task #1060 — Also loop in org admins so unauthorised account swaps are
    // caught quickly. Best-effort: never let an admin-side failure unwind the
    // coach-side success.
    void notifyOrgAdminsCoachPayoutAccountChanged(historyId).catch((err) => {
      logger.warn({ err, historyId }, "[coach-payout-account-change-notify] admin notify threw");
    });

    return result;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, historyId }, "[coach-payout-account-change-notify] delivery failed");
    result.status = "failed";
    result.reason = reason;
    return result;
  }
}

// ─── Task #1060 — Admin oversight notification ────────────────────────────

export interface AdminNotifyResult {
  status: "sent" | "skipped" | "failed";
  reason?: string;
  recipientsAttempted: number;
  recipientsEmailed: number;
  recipientsDigested: number;
  recipientsAuditOnly: number;
}

/**
 * Task #1060 — Email org admins (org_admin role members) when a coach's
 * payout account is created or updated. Mirrors the coach-side security
 * alert but addressed to admins, with a link to the admin payout-history
 * view.
 *
 * Recipient resolution:
 *   - app_users.role = 'org_admin' WHERE organizationId = the org, OR
 *   - org_memberships.role = 'org_admin' for the org.
 * (Tournament directors are intentionally excluded — they don't have a
 * financial-controls remit and would just see noise.)
 *
 * Per-recipient gating:
 *   - userNotificationPrefs.preferEmail = false → audit-only, no email.
 *   - userNotificationPrefs.digestMode = true   → enqueued into the
 *     notification_digest_queue so the user gets a daily summary instead
 *     of per-event spam (matches the contract from Task #1005).
 *   - Otherwise → per-event email sent immediately.
 *
 * The admin who actually made the change is excluded from the recipient
 * list — they obviously already know — but a row is still written to the
 * audit log so the dispatch trail is complete.
 *
 * Best-effort: every failure is caught and logged so the upstream save
 * (which has already committed) is never retried or rolled back.
 */
export async function notifyOrgAdminsCoachPayoutAccountChanged(
  historyId: number,
): Promise<AdminNotifyResult> {
  const empty: AdminNotifyResult = {
    status: "skipped",
    recipientsAttempted: 0,
    recipientsEmailed: 0,
    recipientsDigested: 0,
    recipientsAuditOnly: 0,
  };
  try {
    const [row] = await db.select({
      history: coachPayoutAccountHistoryTable,
      pro: teachingProsTable,
    })
      .from(coachPayoutAccountHistoryTable)
      .innerJoin(teachingProsTable, eq(teachingProsTable.id, coachPayoutAccountHistoryTable.proId))
      .where(eq(coachPayoutAccountHistoryTable.id, historyId))
      .limit(1);
    if (!row) return { ...empty, reason: "history_row_not_found" };
    const { history, pro } = row;

    // Coach display name for subject/body.
    let coachName = (pro.displayName ?? "").trim();
    if (!coachName && pro.userId) {
      const [u] = await db.select({
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      }).from(appUsersTable).where(eq(appUsersTable.id, pro.userId)).limit(1);
      coachName = (u?.displayName || u?.username || "").trim();
    }

    // Who actually made the change.
    let changedByName = "";
    if (history.changedByUserId) {
      const [actor] = await db.select({
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      }).from(appUsersTable).where(eq(appUsersTable.id, history.changedByUserId)).limit(1);
      changedByName = (actor?.displayName || actor?.username || "").trim();
    }
    if (!changedByName) {
      changedByName = history.changedByRole === "admin" ? "An administrator" : "The coach";
    }

    // Branding.
    let branding: EmailBranding = { orgName: "KHARAGOLF" };
    try {
      const [org] = await db.select({
        name: organizationsTable.name,
        logoUrl: organizationsTable.logoUrl,
        primaryColor: organizationsTable.primaryColor,
      }).from(organizationsTable).where(eq(organizationsTable.id, history.organizationId)).limit(1);
      if (org) {
        branding = {
          orgName: org.name ?? "KHARAGOLF",
          logoUrl: org.logoUrl ?? undefined,
          primaryColor: org.primaryColor ?? undefined,
        };
      }
    } catch (err) {
      logger.warn({ err, historyId }, "failed to load org branding for admin payout-change email");
    }

    // Resolve org_admin recipients via the same dual-source pattern used
    // elsewhere (direct app_users.role, plus org_memberships.role).
    const directAdmins = await db.select({
      id: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    }).from(appUsersTable)
      .where(and(
        eq(appUsersTable.organizationId, history.organizationId),
        eq(appUsersTable.role, "org_admin"),
      ));
    const memberAdmins = await db.select({
      id: appUsersTable.id,
      email: appUsersTable.email,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    }).from(orgMembershipsTable)
      .innerJoin(appUsersTable, eq(appUsersTable.id, orgMembershipsTable.userId))
      .where(and(
        eq(orgMembershipsTable.organizationId, history.organizationId),
        eq(orgMembershipsTable.role, "org_admin"),
      ));

    const adminMap = new Map<number, { id: number; email: string | null; displayName: string | null; username: string | null }>();
    for (const a of [...directAdmins, ...memberAdmins]) {
      adminMap.set(a.id, a);
    }
    // Exclude the actor (no point emailing the admin who just made the change).
    if (history.changedByUserId) adminMap.delete(history.changedByUserId);
    const admins = [...adminMap.values()];
    if (admins.length === 0) {
      return { ...empty, reason: "no_org_admins" };
    }

    // Pull notification prefs (preferEmail / digestMode / per-event opt-out)
    // for each admin. Task #1224 adds the per-event opt-out
    // (`notifyCoachPayoutAccountChanges`); when false, the recipient is
    // recorded audit-only with no per-event email AND no digest enqueue
    // even if digest mode is on for them globally.
    const adminIds = admins.map(a => a.id);
    const prefRows = await db.select({
      userId: userNotificationPrefsTable.userId,
      preferEmail: userNotificationPrefsTable.preferEmail,
      digestMode: userNotificationPrefsTable.digestMode,
      notifyCoachPayoutAccountChanges: userNotificationPrefsTable.notifyCoachPayoutAccountChanges,
    }).from(userNotificationPrefsTable)
      .where(inArray(userNotificationPrefsTable.userId, adminIds));
    const prefMap = new Map<number, { preferEmail: boolean; digestMode: boolean; notifyCoachPayoutAccountChanges: boolean }>();
    for (const a of adminIds) prefMap.set(a, { preferEmail: true, digestMode: false, notifyCoachPayoutAccountChanges: true });
    for (const r of prefRows) prefMap.set(r.userId, {
      preferEmail: r.preferEmail,
      digestMode: r.digestMode,
      notifyCoachPayoutAccountChanges: r.notifyCoachPayoutAccountChanges,
    });

    const method = (history.method === "upi" || history.method === "bank_account")
      ? history.method as "upi" | "bank_account"
      : "upi";
    const changeKind = history.changeKind === "created" ? "created" : "updated";
    const changedByRole = history.changedByRole === "admin" ? "admin" : "coach";
    // Task #2135 — pass the *raw* `history.changeKind` (not the
    // created/updated-only `changeKind` used for the email body label)
    // so the URL hash can carry `admin_reverify` if a future caller
    // routes admin re-verifications through this fanout. Unknown values
    // gracefully degrade to the bare `#payout-history` hash inside
    // `adminPayoutHistoryUrl`.
    const adminUrl = adminPayoutHistoryUrl(pro.id, history.changeKind);

    const digestTitle = `Payout account ${changeKind} for ${coachName || `coach #${pro.id}`}`;
    const digestBody = `${changedByName} ${changeKind} the payout account for ${coachName || `coach #${pro.id}`} on ${branding.orgName}. Method: ${method === "upi" ? "UPI" : "Bank account"}.`;
    const digestData = {
      historyId,
      proId: pro.id,
      organizationId: history.organizationId,
      changeKind,
      method,
      changedByUserId: history.changedByUserId,
      changedByRole,
      adminHistoryUrl: adminUrl,
    };

    let emailed = 0;
    let digested = 0;
    let auditOnly = 0;

    for (const admin of admins) {
      const prefs = prefMap.get(admin.id) ?? { preferEmail: true, digestMode: false, notifyCoachPayoutAccountChanges: true };
      let channel: "email" | "digest" | "skipped" = "skipped";
      let status: "sent" | "queued" | "failed" | "skipped" = "skipped";
      let reason: string | undefined;

      // Task #1224 — per-event opt-out wins over both digest mode and the
      // per-event email path. Recipient is recorded audit-only.
      if (!prefs.notifyCoachPayoutAccountChanges) {
        reason = "event_opted_out";
        auditOnly++;
      }
      // Digest mode wins over per-event email — never duplicate (digest
      // now AND per-event email).
      else if (prefs.digestMode) {
        try {
          await db.insert(notificationDigestQueueTable).values({
            userId: admin.id,
            notificationKey: ADMIN_NOTIFY_KEY,
            title: digestTitle,
            body: digestBody,
            data: digestData,
          });
          channel = "digest";
          status = "queued";
          digested++;
        } catch (err) {
          channel = "digest";
          status = "failed";
          reason = err instanceof Error ? err.message : String(err);
          logger.warn({ err, historyId, userId: admin.id }, "[coach-payout-account-change-notify] admin digest enqueue failed");
        }
      } else if (prefs.preferEmail && admin.email) {
        try {
          await sendCoachPayoutAccountChangedAdminEmail({
            to: admin.email,
            recipientName: admin.displayName ?? admin.username ?? null,
            coachName,
            proId: pro.id,
            changeKind,
            method,
            accountHolderName: history.accountHolderName ?? null,
            upiVpaMasked: history.upiVpaMasked ?? null,
            bankAccountLast4: history.bankAccountLast4 ?? null,
            bankIfsc: history.bankIfsc ?? null,
            changedByName,
            changedByRole,
            changedAt: history.createdAt,
            ipAddress: history.ipAddress ?? null,
            adminHistoryUrl: adminUrl,
            branding,
          });
          channel = "email";
          status = "sent";
          emailed++;
        } catch (err) {
          channel = "email";
          // Provider misconfiguration → audit-log `skipped` so the
          // admin notification audit doesn't show a misleading
          // delivery failure for an env issue, and we don't ask the
          // user to act on something out of their control.
          if (classifyMailerError(err) === "provider_unconfigured") {
            status = "skipped";
            reason = "provider_not_configured";
          } else {
            status = "failed";
            reason = err instanceof Error ? err.message : String(err);
            logger.warn({ err, historyId, userId: admin.id }, "[coach-payout-account-change-notify] admin email send failed");
          }
        }
      } else {
        // Either preferEmail=false or no email on file → audit-only.
        reason = !admin.email ? "no_email_on_file" : "email_opted_out";
        auditOnly++;
      }

      // Audit row per recipient (registry has auditRequired=true).
      try {
        await db.insert(notificationAuditLogTable).values({
          notificationKey: ADMIN_NOTIFY_KEY,
          userId: admin.id,
          channel,
          status,
          reason: reason ?? null,
          payload: digestData,
        });
      } catch (auditErr) {
        logger.warn({ err: auditErr, historyId, userId: admin.id }, "[coach-payout-account-change-notify] admin audit insert failed");
      }
    }

    return {
      status: emailed + digested > 0 ? "sent" : "skipped",
      reason: emailed + digested === 0 ? "all_recipients_audit_only" : undefined,
      recipientsAttempted: admins.length,
      recipientsEmailed: emailed,
      recipientsDigested: digested,
      recipientsAuditOnly: auditOnly,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ err, historyId }, "[coach-payout-account-change-notify] admin notify failed");
    return { ...empty, status: "failed", reason };
  }
}

// ─── Retry helpers (Task #1280) ────────────────────────────────────────────
// Same pattern as wallet-withdrawal (Task #1108) and wallet-topup-refund
// (Task #1280): bounded per-channel retry cap with exponential backoff so a
// transient SMTP/Expo blip can't silently swallow a security alert about a
// payout account change.
export const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS = 5;
export const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_PUSH_ATTEMPTS = 5;
// Task #1864 — match the wallet-topup-refund SMS/WhatsApp caps (Task
// #1508). Five attempts at 5/10/20/40/80-minute backoff (capped 6h)
// gives ≈2½h of cover for a transient Twilio / WhatsApp Business outage
// before the row is marked exhausted and rolled into the daily admin
// digest.
export const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS = 5;
export const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS = 5;

const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_BACKOFF_BASE_MS = 5 * 60 * 1000;
const COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

export function computeNextRetryAt(completedAttempts: number, from: Date = new Date()): Date {
  const exp = Math.max(0, completedAttempts - 1);
  const delay = Math.min(
    COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_BACKOFF_BASE_MS * Math.pow(2, exp),
    COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_BACKOFF_MAX_MS,
  );
  return new Date(from.getTime() + delay);
}

export interface CoachPayoutAccountChangeNotifyRetryResult {
  channel: "email" | "push" | "sms" | "whatsapp";
  status: CoachPayoutNotifyChannelStatus;
  error?: string;
  attempts: number;
  exhausted: boolean;
}

/**
 * Task #1703 — write one `notification_audit_log` row per retry outcome
 * (success OR failure OR terminal-skip). Mirrors the per-leg audit rows
 * the initial fan-out writes inside `notifyCoachPayoutAccountChanged`,
 * so a coach who is only reached on the third retry still has a
 * chronological audit trail (`retry_attempt_2:<error>`,
 * `retry_attempt_3`) instead of just the original `failed` row.
 *
 * Best-effort: a failure to write the audit row never alters the
 * caller-visible retry result.
 */
async function writeRetryAuditRow(opts: {
  attempt: CoachPayoutAccountChangeNotifyAttempt;
  channel: "email" | "push" | "sms" | "whatsapp";
  status: CoachPayoutNotifyChannelStatus;
  attemptNumber: number;
  subReason?: string;
  /**
   * Task #2122 — channel-specific extras merged into the audit row's
   * JSON payload. Used by the push retry helper to surface the
   * `attempted / sent / failed / invalid` device counters so admins
   * answering coach disputes don't need a second round-trip.
   */
  extraPayload?: Record<string, unknown>;
  logContext?: Record<string, unknown>;
}): Promise<void> {
  const { attempt, channel, status, attemptNumber, subReason, extraPayload, logContext } = opts;
  const reason = subReason
    ? `retry_attempt_${attemptNumber}:${subReason}`
    : `retry_attempt_${attemptNumber}`;
  try {
    await db.insert(notificationAuditLogTable).values({
      notificationKey: COACH_NOTIFY_KEY,
      userId: attempt.coachUserId,
      channel,
      status,
      reason,
      payload: {
        historyId: attempt.historyId,
        proId: attempt.proId,
        organizationId: attempt.organizationId,
        changeKind: attempt.changeKind,
        method: attempt.method,
        retryAttempt: attemptNumber,
        ...(extraPayload ?? {}),
      },
    });
  } catch (auditErr) {
    logger.warn(
      { ...logContext, err: auditErr, channel, attemptId: attempt.id },
      "[coach-payout-account-change-notify] coach retry audit insert failed",
    );
  }
}

/**
 * Re-attempt a previously failed email delivery for a single
 * coach-payout-account-change notification. The history row is re-loaded
 * at retry time so the masked account fields and changed-by identity
 * match the audit log byte-for-byte. Returns `null` if the row is no
 * longer eligible (status not failed, cap reached, backoff window
 * pending). Provider-not-configured errors flip the row to terminal
 * `skipped` so the cron stops re-selecting it.
 */
export async function retryCoachPayoutAccountChangeEmail(opts: {
  attempt: CoachPayoutAccountChangeNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<CoachPayoutAccountChangeNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.emailStatus !== "failed") return null;
  const currentAttempts = attempt.emailAttempts ?? 0;
  if (currentAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS) return null;
  if (attempt.nextEmailRetryAt && attempt.nextEmailRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: CoachPayoutNotifyChannelStatus;
  let error: string | undefined;

  // Honour `preferEmail` at retry time so a coach who opted out between
  // the initial send and now isn't contacted again.
  let preferEmail = true;
  try {
    const [pref] = await db
      .select({ preferEmail: userNotificationPrefsTable.preferEmail })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, attempt.coachUserId))
      .limit(1);
    preferEmail = pref?.preferEmail ?? true;
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[coach-payout-account-change-notify] Failed to load preferEmail on retry; defaulting to ON",
    );
  }

  if (!preferEmail) {
    status = "opted_out";
  } else {
    // Re-load history (defensive against deletion) so the masked PII in
    // the email body comes from the source of truth, not from snapshot
    // columns we deliberately keep PII-free.
    let history:
      | typeof coachPayoutAccountHistoryTable.$inferSelect
      | undefined;
    try {
      const [h] = await db
        .select()
        .from(coachPayoutAccountHistoryTable)
        .where(eq(coachPayoutAccountHistoryTable.id, attempt.historyId))
        .limit(1);
      history = h;
    } catch {
      // best-effort
    }

    if (!history) {
      // History row vanished — terminal skip.
      await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
        emailStatus: "skipped",
        lastEmailAt: now,
        lastEmailError: "history_row_missing",
        lastEmailRetryAt: now,
        nextEmailRetryAt: null,
      }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));
      await writeRetryAuditRow({
        attempt,
        channel: "email",
        status: "skipped",
        attemptNumber: nextAttempts,
        subReason: "history_row_missing",
        logContext,
      });
      return { channel: "email", status: "skipped", error: "history_row_missing", attempts: currentAttempts, exhausted: false };
    }

    const [coachUser] = await db
      .select({
        email: appUsersTable.email,
        displayName: appUsersTable.displayName,
        username: appUsersTable.username,
      })
      .from(appUsersTable)
      .where(eq(appUsersTable.id, attempt.coachUserId))
      .limit(1);
    const to = coachUser?.email?.trim() ?? "";
    const coachName = (coachUser?.displayName || coachUser?.username || "").trim();

    if (!to) {
      status = "no_address";
    } else {
      let changedByName = "";
      if (history.changedByUserId && history.changedByUserId !== attempt.coachUserId) {
        try {
          const [actor] = await db
            .select({ displayName: appUsersTable.displayName, username: appUsersTable.username })
            .from(appUsersTable)
            .where(eq(appUsersTable.id, history.changedByUserId))
            .limit(1);
          changedByName = (actor?.displayName || actor?.username || "").trim();
        } catch {
          // best-effort
        }
      } else if (history.changedByUserId === attempt.coachUserId) {
        changedByName = coachName || "the coach";
      }
      if (!changedByName) {
        changedByName = history.changedByRole === "admin" ? "An administrator" : "The coach";
      }

      let branding: EmailBranding = { orgName: "KHARAGOLF" };
      try {
        const [org] = await db
          .select({
            name: organizationsTable.name,
            logoUrl: organizationsTable.logoUrl,
            primaryColor: organizationsTable.primaryColor,
          })
          .from(organizationsTable)
          .where(eq(organizationsTable.id, attempt.organizationId))
          .limit(1);
        if (org) {
          branding = {
            orgName: org.name ?? "KHARAGOLF",
            logoUrl: org.logoUrl ?? undefined,
            primaryColor: org.primaryColor ?? undefined,
          };
        }
      } catch {
        // best-effort
      }

      const method = (history.method === "upi" || history.method === "bank_account")
        ? history.method as "upi" | "bank_account"
        : "upi";
      const changeKind = history.changeKind === "created" ? "created" : "updated";
      const changedByRole = history.changedByRole === "admin" ? "admin" : "coach";

      try {
        await sendCoachPayoutAccountChangedEmail({
          to,
          coachName,
          changeKind,
          method,
          accountHolderName: history.accountHolderName ?? null,
          upiVpaMasked: history.upiVpaMasked ?? null,
          bankAccountLast4: history.bankAccountLast4 ?? null,
          bankIfsc: history.bankIfsc ?? null,
          changedByName,
          changedByRole,
          changedAt: history.createdAt,
          ipAddress: history.ipAddress ?? null,
          historyUrl: workspaceHistoryUrl(),
          branding,
        });
        status = "sent";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Use the shared mailer classifier so coverage matches the
        // initial-send branch (and catches GMAIL_USER/RESEND_API_KEY/etc).
        if (classifyMailerError(err) === "provider_unconfigured") {
          await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
            emailStatus: "skipped",
            lastEmailAt: now,
            lastEmailError: "provider_not_configured",
            lastEmailRetryAt: now,
            nextEmailRetryAt: null,
          }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));
          await writeRetryAuditRow({
            attempt,
            channel: "email",
            status: "skipped",
            attemptNumber: nextAttempts,
            subReason: "provider_not_configured",
            logContext,
          });
          return { channel: "email", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
        }
        status = "failed";
        error = msg;
        logger.error(
          { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: msg },
          "[coach-payout-account-change-notify] Email retry failed",
        );
      }
    }
  }

  const exhausted = status === "failed" && nextAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_EMAIL_ATTEMPTS;
  await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
    emailStatus: status,
    lastEmailAt: now,
    lastEmailError: error ?? null,
    emailAttempts: nextAttempts,
    lastEmailRetryAt: now,
    nextEmailRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    emailRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));

  // Task #1703 — leave a per-retry breadcrumb in `notification_audit_log`
  // so the coach-side audit trail mirrors the admin fan-out and the
  // initial-send leg. Sub-reason captures the channel-specific signal
  // (error message for failures, opt-out / no-address for skips).
  let auditSubReason: string | undefined;
  if (status === "failed") auditSubReason = error;
  else if (status === "opted_out") auditSubReason = "email_opted_out";
  else if (status === "no_address") auditSubReason = "no_email_on_file";
  await writeRetryAuditRow({
    attempt,
    channel: "email",
    status,
    attemptNumber: nextAttempts,
    subReason: auditSubReason,
    logContext,
  });

  return { channel: "email", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Re-attempt a previously failed push delivery for a single
 * coach-payout-account-change notification. Mirrors {@link
 * retryCoachPayoutAccountChangeEmail}.
 */
export async function retryCoachPayoutAccountChangePush(opts: {
  attempt: CoachPayoutAccountChangeNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<CoachPayoutAccountChangeNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.pushStatus !== "failed") return null;
  const currentAttempts = attempt.pushAttempts ?? 0;
  if (currentAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_PUSH_ATTEMPTS) return null;
  if (attempt.nextPushRetryAt && attempt.nextPushRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: CoachPayoutNotifyChannelStatus;
  let error: string | undefined;

  let preferPush = true;
  try {
    const [pref] = await db
      .select({ preferPush: userNotificationPrefsTable.preferPush })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, attempt.coachUserId))
      .limit(1);
    preferPush = pref?.preferPush ?? true;
  } catch (err) {
    logger.warn(
      { ...logContext, attemptId: attempt.id, errMsg: err instanceof Error ? err.message : String(err) },
      "[coach-payout-account-change-notify] Failed to load preferPush on retry; defaulting to ON",
    );
  }

  // Task #2122 — capture the per-device push delivery counters so the
  // retry audit row can carry the same attempted/sent/failed/invalid
  // breakdown as the initial fan-out leg.
  let pushDeliverySummary: PushDeliveryResult | null = null;
  if (!preferPush) {
    status = "opted_out";
  } else {
    const method = attempt.method === "upi" ? "UPI" : "bank account";
    const title = attempt.changeKind === "created"
      ? `Payout ${method} added`
      : `Payout ${method} updated`;
    const body = `Your payout ${method} was ${attempt.changeKind}. If this wasn't you, review your payout history.`;
    try {
      const push = await sendPushToUsers([attempt.coachUserId], title, body, {
        type: "coach_payout_account_changed",
        historyId: attempt.historyId,
        proId: attempt.proId,
        organizationId: attempt.organizationId,
        changeKind: attempt.changeKind,
        method: attempt.method,
        retry: true,
      });
      pushDeliverySummary = push;
      status = classifyPushDelivery(push);
      if (status === "failed") {
        error = "push_delivery_failed";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/EXPO.*not configured|PUSH.*not configured|push provider.*not configured|expo access token.*not (set|configured)/i.test(msg)) {
        await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
          pushStatus: "skipped",
          lastPushAt: now,
          lastPushError: "provider_not_configured",
          lastPushRetryAt: now,
          nextPushRetryAt: null,
        }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));
        await writeRetryAuditRow({
          attempt,
          channel: "push",
          status: "skipped",
          attemptNumber: nextAttempts,
          subReason: "provider_not_configured",
          logContext,
        });
        return { channel: "push", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error(
        { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error },
        "[coach-payout-account-change-notify] Push retry failed",
      );
    }
  }

  const exhausted = status === "failed" && nextAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_PUSH_ATTEMPTS;
  await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
    pushStatus: status,
    lastPushAt: now,
    lastPushError: error ?? null,
    pushAttempts: nextAttempts,
    lastPushRetryAt: now,
    nextPushRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    pushRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));

  // Task #1703 — same per-retry breadcrumb as the email retry helper.
  let auditSubReason: string | undefined;
  if (status === "failed") auditSubReason = error;
  else if (status === "opted_out") auditSubReason = "push_opted_out";
  else if (status === "no_address") auditSubReason = "no_push_token";
  await writeRetryAuditRow({
    attempt,
    channel: "push",
    status,
    attemptNumber: nextAttempts,
    subReason: auditSubReason,
    // Task #2122 — include the per-device delivery counters so the
    // retry audit trail mirrors the initial fan-out leg's payload.
    extraPayload: pushDeliverySummary
      ? {
          pushDelivery: {
            attempted: pushDeliverySummary.attempted,
            sent: pushDeliverySummary.sent,
            failed: pushDeliverySummary.failed,
            invalid: pushDeliverySummary.invalid,
          },
        }
      : undefined,
    logContext,
  });

  return { channel: "push", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Task #1864 — re-attempt a previously failed SMS delivery for a single
 * coach-payout-account-change notification. Mirrors {@link
 * retryCoachPayoutAccountChangeEmail} and the wallet-topup-refund SMS
 * retry helper (Task #1508): the `member_comm_prefs` billing-category
 * opt-in is re-checked at retry time, the phone is re-loaded from
 * `club_members.phone`, and a `SMS_PROVIDER not configured` failure
 * flips the row to terminal `skipped` so the cron stops re-selecting it.
 */
export async function retryCoachPayoutAccountChangeSms(opts: {
  attempt: CoachPayoutAccountChangeNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<CoachPayoutAccountChangeNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.smsStatus !== "failed") return null;
  const currentAttempts = attempt.smsAttempts ?? 0;
  if (currentAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS) return null;
  if (attempt.nextSmsRetryAt && attempt.nextSmsRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: CoachPayoutNotifyChannelStatus;
  let error: string | undefined;

  const { phone, smsEnabled } = await loadBillingPrefAndPhone(
    attempt.organizationId,
    attempt.coachUserId,
  );

  if (!smsEnabled) {
    status = "opted_out";
  } else if (!phone) {
    status = "no_address";
  } else {
    const changeKind = attempt.changeKind === "created" ? "created" : "updated";
    const method = attempt.method === "upi" ? "upi" : "bank_account";
    const body = buildShortBodyForChannel(changeKind, method).slice(0, 320);
    try {
      await sendTransactionalSms(phone, body);
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SMS_PROVIDER not configured/i.test(msg)) {
        await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
          smsStatus: "skipped",
          lastSmsAt: now,
          lastSmsError: "provider_not_configured",
          lastSmsRetryAt: now,
          nextSmsRetryAt: null,
        }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));
        await writeRetryAuditRow({
          attempt,
          channel: "sms",
          status: "skipped",
          attemptNumber: nextAttempts,
          subReason: "provider_not_configured",
          logContext,
        });
        return { channel: "sms", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error(
        { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error },
        "[coach-payout-account-change-notify] SMS retry failed",
      );
    }
  }

  const exhausted = status === "failed" && nextAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_SMS_ATTEMPTS;
  await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
    smsStatus: status,
    lastSmsAt: now,
    lastSmsError: error ?? null,
    smsAttempts: nextAttempts,
    lastSmsRetryAt: now,
    nextSmsRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    smsRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));

  let auditSubReason: string | undefined;
  if (status === "failed") auditSubReason = error;
  else if (status === "opted_out") auditSubReason = "sms_opted_out";
  else if (status === "no_address") auditSubReason = "no_phone_on_file";
  await writeRetryAuditRow({
    attempt,
    channel: "sms",
    status,
    attemptNumber: nextAttempts,
    subReason: auditSubReason,
    logContext,
  });

  return { channel: "sms", status, error, attempts: nextAttempts, exhausted };
}

/**
 * Task #1864 — re-attempt a previously failed WhatsApp delivery for a
 * single coach-payout-account-change notification. Mirrors {@link
 * retryCoachPayoutAccountChangeSms} but routes through the WhatsApp
 * Business sender. Provider-not-configured (no WHATSAPP_PROVIDER /
 * WHATSAPP_PROVIDER_API_KEY) flips the row to terminal `skipped` so a
 * misconfigured-provider cluster doesn't burn through the retry budget.
 */
export async function retryCoachPayoutAccountChangeWhatsapp(opts: {
  attempt: CoachPayoutAccountChangeNotifyAttempt;
  logContext?: Record<string, unknown>;
  now?: Date;
}): Promise<CoachPayoutAccountChangeNotifyRetryResult | null> {
  const { attempt, logContext } = opts;
  const now = opts.now ?? new Date();
  if (attempt.whatsappStatus !== "failed") return null;
  const currentAttempts = attempt.whatsappAttempts ?? 0;
  if (currentAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS) return null;
  if (attempt.nextWhatsappRetryAt && attempt.nextWhatsappRetryAt.getTime() > now.getTime()) return null;

  const nextAttempts = currentAttempts + 1;
  let status: CoachPayoutNotifyChannelStatus;
  let error: string | undefined;

  const { phone, whatsappEnabled } = await loadBillingPrefAndPhone(
    attempt.organizationId,
    attempt.coachUserId,
  );

  if (!whatsappEnabled) {
    status = "opted_out";
  } else if (!phone) {
    status = "no_address";
  } else {
    const changeKind = attempt.changeKind === "created" ? "created" : "updated";
    const method = attempt.method === "upi" ? "upi" : "bank_account";
    const body = buildShortBodyForChannel(changeKind, method).slice(0, 1024);
    try {
      await sendTransactionalWhatsapp(phone, body);
      status = "sent";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/WHATSAPP_PROVIDER not configured|WHATSAPP_PROVIDER_API_KEY|WhatsApp.*not configured/i.test(msg)) {
        await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
          whatsappStatus: "skipped",
          lastWhatsappAt: now,
          lastWhatsappError: "provider_not_configured",
          lastWhatsappRetryAt: now,
          nextWhatsappRetryAt: null,
        }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));
        await writeRetryAuditRow({
          attempt,
          channel: "whatsapp",
          status: "skipped",
          attemptNumber: nextAttempts,
          subReason: "provider_not_configured",
          logContext,
        });
        return { channel: "whatsapp", status: "skipped", error: "provider_not_configured", attempts: currentAttempts, exhausted: false };
      }
      status = "failed";
      error = msg;
      logger.error(
        { ...logContext, attemptId: attempt.id, attempt: nextAttempts, errMsg: error },
        "[coach-payout-account-change-notify] WhatsApp retry failed",
      );
    }
  }

  const exhausted = status === "failed" && nextAttempts >= COACH_PAYOUT_ACCOUNT_CHANGE_NOTIFY_MAX_WHATSAPP_ATTEMPTS;
  await db.update(coachPayoutAccountChangeNotifyAttemptsTable).set({
    whatsappStatus: status,
    lastWhatsappAt: now,
    lastWhatsappError: error ?? null,
    whatsappAttempts: nextAttempts,
    lastWhatsappRetryAt: now,
    nextWhatsappRetryAt: status === "failed" && !exhausted ? computeNextRetryAt(nextAttempts, now) : null,
    whatsappRetryExhaustedAt: exhausted ? now : null,
  }).where(eq(coachPayoutAccountChangeNotifyAttemptsTable.id, attempt.id));

  let auditSubReason: string | undefined;
  if (status === "failed") auditSubReason = error;
  else if (status === "opted_out") auditSubReason = "whatsapp_opted_out";
  else if (status === "no_address") auditSubReason = "no_phone_on_file";
  await writeRetryAuditRow({
    attempt,
    channel: "whatsapp",
    status,
    attemptNumber: nextAttempts,
    subReason: auditSubReason,
    logContext,
  });

  return { channel: "whatsapp", status, error: error ?? undefined, attempts: nextAttempts, exhausted };
}
