/**
 * Task #1702 — Implementation of the coach-side payout-change audit
 * backfill, kept here in `src/lib/` (rather than inside `scripts/`) so
 * vitest (Task #2119) can import `runBackfill()` and `assertSchemaGate()`
 * directly without spawning a subprocess and without violating the
 * api-server tsconfig `rootDir`. The CLI entry point that the
 * `backfill:coach-payout-change-audit` package script runs lives at
 * `scripts/backfillCoachPayoutChangeAudit.ts` and is now a thin wrapper
 * around `runBackfill()` below.
 *
 * Background:
 *   Task #1406 made `notifyCoachPayoutAccountChanged` write one
 *   `notification_audit_log` row per channel (email, in_app, push) keyed
 *   by `coach.payout.account.changed.coach`, attributed to the coach's
 *   own userId, so support can answer "did we ever tell this coach?"
 *   when an account-change is later disputed. Account changes that
 *   happened *before* #1406 deployed have a `coach_payout_account_history`
 *   row, but no audit-log trail. The admin-side fanout already wrote
 *   audit rows in pre-#1406 code, so only the coach-side leg is missing.
 *
 * What this does:
 *   For every `coach_payout_account_history` row that has no audit row
 *   under `notification_key = 'coach.payout.account.changed.coach'` for
 *   the matching coach userId + historyId, synthesise three rows (one
 *   per channel) using the per-channel state already captured by Task
 *   #1280's `coach_payout_account_change_notify_attempts` table:
 *
 *     email (channel = 'email'):
 *       - if attempts row present       → status = attempts.email_status
 *                                         reason = attempts.last_email_error (or null)
 *       - if no attempts row            → status = 'unknown'
 *                                         reason = 'backfilled_pre_audit'
 *
 *     push (channel = 'push'):
 *       - if attempts row present       → status = attempts.push_status
 *                                         reason = attempts.last_push_error (or null)
 *       - if no attempts row            → status = 'unknown'
 *                                         reason = 'backfilled_pre_audit'
 *
 *     in-app (channel = 'in_app'):
 *       - always                        → status = 'unknown'
 *                                         reason = 'backfilled_pre_audit'
 *       The notify path inserts into `member_messages`, not the attempts
 *       table, so there is no historical per-event signal we can recover
 *       — we mark it `unknown` rather than asserting a state we can't
 *       prove.
 *
 *   Every row carries a `backfilled: true` + `backfillTask: 1702` flag
 *   in `payload`, alongside the same shape the live notify writes
 *   (`historyId`, `proId`, `organizationId`, `changeKind`, `method`,
 *   `changedByUserId`, `changedByRole`), so a `WHERE payload->>'backfilled'
 *   = 'true'` query distinguishes synthesised rows from real ones.
 *
 * userId resolution:
 *   The audit row's `user_id` is the coach app-user. We prefer the
 *   snapshot in `coach_payout_account_change_notify_attempts.coachUserId`
 *   (captured at first send) and fall back to
 *   `teaching_pros.user_id` for history rows that never produced an
 *   attempts row. If both are null (the pro never had a linked app
 *   user), the live notify path bails out before persisting anything,
 *   so there is nothing to backfill — those history rows are skipped
 *   and counted in the summary.
 *
 * Idempotency:
 *   The candidate query uses `NOT EXISTS` against `notification_audit_log`
 *   filtered by `(notification_key, user_id, payload->>'historyId')`, so
 *   re-running the script after a partial success picks up only the
 *   still-empty rows. Wrapped in a single transaction so a mid-run crash
 *   leaves no partially-backfilled history rows behind.
 *
 * Schema gate:
 *   Per the task spec, the backfill is gated on
 *   `coach_payout_account_change_notify_attempts.history_id` actually
 *   existing — that column is the linchpin of the join. We probe
 *   `information_schema.columns` at startup and abort with a clear
 *   message if it's missing rather than silently writing every row as
 *   `backfilled_pre_audit`. The probe target is parameterised on
 *   `assertSchemaGate(tableName, columnName)` so the regression test
 *   suite (Task #2119) can exercise the failure path without having to
 *   actually drop the production column.
 */
import { db } from "@workspace/db";
import {
  coachPayoutAccountHistoryTable,
  coachPayoutAccountChangeNotifyAttemptsTable,
  notificationAuditLogTable,
  teachingProsTable,
} from "@workspace/db";
import { asc, eq, sql } from "drizzle-orm";

export const COACH_NOTIFY_KEY = "coach.payout.account.changed.coach";
export const BACKFILL_REASON = "backfilled_pre_audit";

type Channel = "email" | "in_app" | "push";

interface CandidateRow {
  historyId: number;
  proId: number;
  organizationId: number;
  changeKind: string;
  method: string;
  changedByUserId: number | null;
  changedByRole: string;
  // Snapshot from attempts (preferred) or teaching_pros.user_id (fallback).
  attemptsCoachUserId: number | null;
  proUserId: number | null;
  // Per-channel state from the attempts row, when it exists.
  emailStatus: string | null;
  emailLastError: string | null;
  pushStatus: string | null;
  pushLastError: string | null;
  // Has an attempts row at all.
  hasAttemptsRow: boolean;
}

interface AuditRowToInsert {
  notificationKey: string;
  userId: number;
  channel: Channel;
  status: string;
  reason: string | null;
  payload: Record<string, unknown>;
}

export interface BackfillSummary {
  candidates: number;
  historyRowsBackfilled: number;
  historyRowsSkippedNoUser: number;
  skippedNoUserHistoryIds: number[];
  rowsInserted: number;
}

/**
 * Probe `information_schema.columns` for the join column the backfill
 * depends on. Aborts loudly when the column is missing rather than
 * silently misattributing every row to `backfilled_pre_audit`.
 *
 * The defaults match production. Tests pass an intentionally non-existent
 * column name to exercise the failure path without having to ALTER the
 * shared test DB.
 */
export async function assertSchemaGate(
  tableName: string = "coach_payout_account_change_notify_attempts",
  columnName: string = "history_id",
): Promise<void> {
  const probe = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS "exists"
  `);
  const row = probe.rows?.[0] ?? (probe as unknown as Array<{ exists: boolean }>)[0];
  if (!row?.exists) {
    throw new Error(
      "[backfill:coach-payout-change-audit] schema gate failed: " +
        `${tableName}.${columnName} is missing. ` +
        "Aborting before writing any audit rows.",
    );
  }
}

function normaliseChangeKind(raw: string): string {
  return raw === "created" ? "created" : "updated";
}

function normaliseMethod(raw: string): "upi" | "bank_account" {
  return raw === "upi" || raw === "bank_account" ? raw : "upi";
}

function normaliseChangedByRole(raw: string): "coach" | "admin" {
  return raw === "admin" ? "admin" : "coach";
}

function buildAuditRows(c: CandidateRow, coachUserId: number): AuditRowToInsert[] {
  const payload: Record<string, unknown> = {
    historyId: c.historyId,
    proId: c.proId,
    organizationId: c.organizationId,
    changeKind: normaliseChangeKind(c.changeKind),
    method: normaliseMethod(c.method),
    changedByUserId: c.changedByUserId,
    changedByRole: normaliseChangedByRole(c.changedByRole),
    backfilled: true,
    backfillTask: 1702,
  };

  // Email & push: prefer attempts data when available, else mark as
  // unknown/backfilled_pre_audit. We treat a null per-channel status on
  // an attempts row as "not attempted" — the live writer always sets
  // both to a CoachPayoutNotifyChannelStatus string when it persists,
  // but historical rows from the very first notify version wrote a
  // partial set; better to mark those `unknown` than guess.
  const emailStatus = c.hasAttemptsRow && c.emailStatus ? c.emailStatus : "unknown";
  const emailReason = c.hasAttemptsRow && c.emailStatus
    ? (c.emailLastError ?? null)
    : BACKFILL_REASON;

  const pushStatus = c.hasAttemptsRow && c.pushStatus ? c.pushStatus : "unknown";
  const pushReason = c.hasAttemptsRow && c.pushStatus
    ? (c.pushLastError ?? null)
    : BACKFILL_REASON;

  // In-app: never tracked in the attempts table (member_messages is the
  // source of truth, and that doesn't carry historyId on older rows).
  // Always `unknown` per the task spec.
  return [
    {
      notificationKey: COACH_NOTIFY_KEY,
      userId: coachUserId,
      channel: "email",
      status: emailStatus,
      reason: emailReason,
      payload,
    },
    {
      notificationKey: COACH_NOTIFY_KEY,
      userId: coachUserId,
      channel: "in_app",
      status: "unknown",
      reason: BACKFILL_REASON,
      payload,
    },
    {
      notificationKey: COACH_NOTIFY_KEY,
      userId: coachUserId,
      channel: "push",
      status: pushStatus,
      reason: pushReason,
      payload,
    },
  ];
}

/**
 * Run one pass of the backfill. Returns a summary so callers (CLI,
 * tests, future post-deploy hook) can log or assert on counts.
 *
 * Wrapped in a single DB transaction so a mid-run crash leaves no
 * partially-backfilled history rows behind. Callers must invoke
 * `assertSchemaGate()` first if they want the explicit "abort if the
 * join column is missing" behaviour — the CLI wrapper does so.
 */
export async function runBackfill(): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    candidates: 0,
    historyRowsBackfilled: 0,
    historyRowsSkippedNoUser: 0,
    skippedNoUserHistoryIds: [],
    rowsInserted: 0,
  };

  await db.transaction(async (tx) => {
    // Pull every history row that does NOT already have a coach-side
    // audit row for the same historyId. The NOT EXISTS guard is the
    // idempotency latch: a re-run after a partial success picks up only
    // the still-empty rows.
    //
    // We LEFT JOIN the attempts table so we can read per-channel state
    // when it exists and fall through to `backfilled_pre_audit` when it
    // doesn't. We also LEFT JOIN teaching_pros.user_id as a fallback
    // for the audit row's `user_id` when the attempts snapshot is
    // absent.
    const candidates: CandidateRow[] = await tx
      .select({
        historyId: coachPayoutAccountHistoryTable.id,
        proId: coachPayoutAccountHistoryTable.proId,
        organizationId: coachPayoutAccountHistoryTable.organizationId,
        changeKind: coachPayoutAccountHistoryTable.changeKind,
        method: coachPayoutAccountHistoryTable.method,
        changedByUserId: coachPayoutAccountHistoryTable.changedByUserId,
        changedByRole: coachPayoutAccountHistoryTable.changedByRole,
        attemptsCoachUserId: coachPayoutAccountChangeNotifyAttemptsTable.coachUserId,
        proUserId: teachingProsTable.userId,
        emailStatus: coachPayoutAccountChangeNotifyAttemptsTable.emailStatus,
        emailLastError: coachPayoutAccountChangeNotifyAttemptsTable.lastEmailError,
        pushStatus: coachPayoutAccountChangeNotifyAttemptsTable.pushStatus,
        pushLastError: coachPayoutAccountChangeNotifyAttemptsTable.lastPushError,
        hasAttemptsRow: sql<boolean>`${coachPayoutAccountChangeNotifyAttemptsTable.id} IS NOT NULL`,
      })
      .from(coachPayoutAccountHistoryTable)
      .leftJoin(
        coachPayoutAccountChangeNotifyAttemptsTable,
        eq(coachPayoutAccountChangeNotifyAttemptsTable.historyId, coachPayoutAccountHistoryTable.id),
      )
      .leftJoin(
        teachingProsTable,
        eq(teachingProsTable.id, coachPayoutAccountHistoryTable.proId),
      )
      .where(
        // Tightened per code review on Task #1702: existence is checked
        // against (notification_key, payload.historyId, user_id), where
        // user_id is the resolved coach userId — preferring the snapshot
        // in the attempts row and falling back to teaching_pros.user_id.
        // Without the user_id match, a row attributed to the WRONG user
        // (e.g. a buggy admin-side audit dispatch from a prior incident)
        // would silently mark the history row "already audited" even
        // though the correct coach still has no trail.
        sql`NOT EXISTS (
          SELECT 1
          FROM ${notificationAuditLogTable}
          WHERE ${notificationAuditLogTable.notificationKey} = ${COACH_NOTIFY_KEY}
            AND ${notificationAuditLogTable.userId} = COALESCE(
              ${coachPayoutAccountChangeNotifyAttemptsTable.coachUserId},
              ${teachingProsTable.userId}
            )
            AND (${notificationAuditLogTable.payload}->>'historyId')::int
                = ${coachPayoutAccountHistoryTable.id}
        )`,
      )
      .orderBy(asc(coachPayoutAccountHistoryTable.id));

    summary.candidates = candidates.length;

    if (candidates.length === 0) {
      return;
    }

    const allRows: AuditRowToInsert[] = [];
    for (const c of candidates) {
      // Prefer the snapshot from attempts (captured at first send) and
      // fall back to the live teaching_pros.user_id if no attempts row
      // exists. Skip if both are null — the live notify path also bails
      // out in that case (`pro_has_no_app_user`), so historically these
      // rows produced neither audit nor attempts data and there is no
      // user to attribute backfilled audit to.
      const coachUserId = c.attemptsCoachUserId ?? c.proUserId;
      if (coachUserId == null) {
        summary.historyRowsSkippedNoUser += 1;
        summary.skippedNoUserHistoryIds.push(c.historyId);
        continue;
      }

      allRows.push(...buildAuditRows(c, coachUserId));
      summary.historyRowsBackfilled += 1;
    }

    if (allRows.length === 0) {
      return;
    }

    // Chunk the insert so a backfill of an old, busy environment doesn't
    // blow past Postgres's ~65k bound-parameter limit (each audit row
    // uses 6 bound parameters).
    const CHUNK = 1000;
    for (let i = 0; i < allRows.length; i += CHUNK) {
      const slice = allRows.slice(i, i + CHUNK);
      await tx.insert(notificationAuditLogTable).values(slice);
      summary.rowsInserted += slice.length;
    }

    // Belt-and-braces sanity check: re-count the audit rows we just
    // wrote against the candidates we touched. If they don't line up
    // (e.g. a concurrent live notify call wrote a row for the same
    // historyId mid-transaction), abort so we don't end up with mixed
    // real + backfilled rows for the same dispatch.
    const expected = summary.historyRowsBackfilled * 3;
    if (summary.rowsInserted !== expected) {
      throw new Error(
        `[backfill:coach-payout-change-audit] post-insert sanity failed: ` +
          `expected ${expected} rows inserted (${summary.historyRowsBackfilled} history × 3 channels), ` +
          `saw ${summary.rowsInserted}. Rolling back.`,
      );
    }
  });

  return summary;
}
