/**
 * Task #2069 — One-shot backfill that recovers a `status` / `reason` for
 * the older `manual_entry_alerts` rows the Task #1658 migration left
 * looking like successful sends.
 *
 * Background:
 *   The Task #1658 migration is "history-starts-here": pre-#1658 rows
 *   default to `status='sent'` / `reason=NULL` because the notifier
 *   never persisted skip outcomes before. That is correct for rows
 *   that did fan out, but the audit dashboard shows a sharp cliff —
 *   every pre-migration row looks like a delivered alert, even the
 *   ones the support team remembers being silent (zero pushes, zero
 *   emails, but a row exists in `manual_entry_alerts` because some
 *   skip branches did insert a zero-counter row).
 *
 *   The structured `[manual-entry-notify] result` log line
 *   (`manualEntryNotify.ts`) has always carried `submissionId` +
 *   `status` + `reason` — i.e. the missing audit-row fields — so we
 *   can replay the last ~90 days of those log lines and patch any
 *   matching audit row that still has the column defaults AND no
 *   channel attempts (the only audit rows we're confident were
 *   actually skip outcomes the notifier observed).
 *
 *   This module is the implementation; the CLI entry point lives at
 *   `scripts/backfillManualEntryAlertSkipReasons.ts` and is gated
 *   behind `--dry-run` by default.
 *
 * Matching contract:
 *   A `manual_entry_alerts` row is eligible to be patched iff ALL of:
 *     - `status = 'sent'`
 *     - `reason IS NULL`
 *     - `push_attempted + push_sent + email_attempted + email_sent = 0`
 *     - `submission_id` matches a `[manual-entry-notify] result` log
 *       line in the retention window whose `status` is `skipped` or
 *       `failed` and whose `reason` is non-empty.
 *
 *   Rows that already have a non-default `status`/`reason` (the
 *   post-#1658 path wrote them) are never touched. Rows with at least
 *   one attempted delivery are never touched either — those are
 *   genuine sent/partially-sent alerts and the column defaults are
 *   the correct retroactive value.
 *
 * Log-line shape:
 *   pino emits one JSON object per line. We accept the canonical pino
 *   shape (`msg` field) AND the bunyan-style alias (`message`) because
 *   some log shippers rewrite the field name. Required keys:
 *     - `time` — milliseconds since epoch (pino default).
 *     - `msg` (or `message`) — must equal `[manual-entry-notify] result`.
 *     - `submissionId` — number.
 *     - `status` — `'sent' | 'skipped' | 'failed'`.
 *     - `reason` — present and non-empty for skipped/failed lines.
 *
 *   Lines that don't match the shape are counted as `invalidLogLines`
 *   and surfaced in the summary so the operator can sanity-check
 *   parser drift.
 *
 * Multi-call submissions:
 *   `notifyManualEntryRound` can be called more than once for the same
 *   submissionId in pathological retry scenarios. We dedupe by
 *   submissionId, keeping the LATEST log line (largest `time`) — the
 *   final outcome is the one that should match the persisted audit
 *   row.
 *
 * Idempotency:
 *   The candidate query keys on `status='sent' AND reason IS NULL` so
 *   any row we previously patched (and therefore set `reason` on) is
 *   automatically excluded from the next run. Re-running on a fresh
 *   batch of log lines is safe.
 */
import { db, manualEntryAlertsTable } from "@workspace/db";
import { and, eq, inArray, isNull } from "drizzle-orm";

export const MANUAL_ENTRY_NOTIFY_LOG_MSG = "[manual-entry-notify] result";

/** Maximum length we will persist into `manual_entry_alerts.reason`. */
const REASON_MAX_LEN = 500;

/**
 * Outcome statuses we are willing to backfill from a log line. `'sent'`
 * is excluded on purpose: a log line saying "sent" but matching a
 * zero-counter audit row is internally inconsistent (sent rows have
 * non-zero counters), so we never overwrite the row on that basis.
 */
const BACKFILLABLE_STATUSES = new Set(["skipped", "failed"]);

export interface ParsedNotifyLogLine {
  time: number;
  submissionId: number;
  status: "skipped" | "failed";
  reason: string;
}

export interface BackfillManualEntrySkipReasonsOptions {
  /** One pino JSON object per element. Order does not matter. */
  logLines: string[];
  /**
   * Cutoff (epoch ms). Log lines with `time < sinceMs` are ignored —
   * the script's main use case is "last ~90 days". Caller decides the
   * window.
   */
  sinceMs: number;
  /**
   * Default `true`. When `true`, no UPDATEs are issued; the result
   * carries `rowsWouldUpdate` so the operator can preview impact.
   */
  dryRun: boolean;
}

export interface BackfillManualEntrySkipReasonsResult {
  logLinesScanned: number;
  /** Lines whose `msg` matched but were dropped for being out-of-window. */
  logLinesSkippedOutOfWindow: number;
  /** Lines that parsed JSON but did not match the expected shape. */
  invalidLogLines: number;
  /** Distinct submissionIds with at least one in-window skipped/failed line. */
  uniqueSubmissions: number;
  /**
   * Submissions that had a usable log line but whose `manual_entry_alerts`
   * row either does not exist OR no longer matches the candidate
   * predicate (e.g. it has counters > 0, or it was already patched).
   * Surfaced so the operator can spot a misaligned retention window.
   */
  unmatchedSubmissions: number;
  /** Audit rows that satisfy the candidate predicate AND have a log match. */
  candidateRowsFound: number;
  /** Rows actually UPDATEd (0 in dry-run). */
  rowsUpdated: number;
  /** Rows that WOULD be UPDATEd (mirrors rowsUpdated in non-dry-run). */
  rowsWouldUpdate: number;
  /** Count of patches grouped by reason, for the post-mortem note. */
  reasonBreakdown: Record<string, number>;
}

interface RawLogObject {
  time?: unknown;
  msg?: unknown;
  message?: unknown;
  submissionId?: unknown;
  status?: unknown;
  reason?: unknown;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isPositiveInt(x: unknown): x is number {
  return isFiniteNumber(x) && Number.isInteger(x) && x > 0;
}

/**
 * Parse one raw log line. Returns null when the line is not a
 * `[manual-entry-notify] result` event we can act on. The split
 * between "invalid" and "out-of-window" / "wrong msg" is the
 * caller's job — this helper is concerned only with shape.
 */
function parseLine(raw: string): { kind: "ok"; value: ParsedNotifyLogLine }
  | { kind: "wrong-msg" }
  | { kind: "invalid" }
  | { kind: "not-backfillable" } {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "wrong-msg" };
  let obj: RawLogObject;
  try {
    obj = JSON.parse(trimmed) as RawLogObject;
  } catch {
    return { kind: "invalid" };
  }
  if (obj === null || typeof obj !== "object") return { kind: "invalid" };

  const msg = typeof obj.msg === "string"
    ? obj.msg
    : (typeof obj.message === "string" ? obj.message : null);
  if (msg !== MANUAL_ENTRY_NOTIFY_LOG_MSG) return { kind: "wrong-msg" };

  const time = obj.time;
  const submissionId = obj.submissionId;
  const status = obj.status;
  const reason = obj.reason;

  if (!isFiniteNumber(time)) return { kind: "invalid" };
  if (!isPositiveInt(submissionId)) return { kind: "invalid" };
  if (typeof status !== "string") return { kind: "invalid" };
  if (!BACKFILLABLE_STATUSES.has(status)) return { kind: "not-backfillable" };
  if (typeof reason !== "string" || reason.trim() === "") {
    return { kind: "invalid" };
  }

  const trimmedReason = reason.length > REASON_MAX_LEN
    ? reason.slice(0, REASON_MAX_LEN)
    : reason;

  return {
    kind: "ok",
    value: {
      time,
      submissionId,
      status: status as "skipped" | "failed",
      reason: trimmedReason,
    },
  };
}

/**
 * Reduce a stream of log lines to the latest backfillable outcome per
 * submissionId, after applying the retention-window filter. Surfaced
 * separately so tests can assert the dedupe / window logic without
 * touching the DB.
 */
export function reduceLogLines(
  logLines: string[],
  sinceMs: number,
): {
  perSubmission: Map<number, ParsedNotifyLogLine>;
  scanned: number;
  invalid: number;
  outOfWindow: number;
} {
  const perSubmission = new Map<number, ParsedNotifyLogLine>();
  let scanned = 0;
  let invalid = 0;
  let outOfWindow = 0;

  for (const raw of logLines) {
    scanned += 1;
    const parsed = parseLine(raw);
    if (parsed.kind === "wrong-msg") continue;
    if (parsed.kind === "not-backfillable") continue;
    if (parsed.kind === "invalid") {
      invalid += 1;
      continue;
    }
    const line = parsed.value;
    if (line.time < sinceMs) {
      outOfWindow += 1;
      continue;
    }
    const existing = perSubmission.get(line.submissionId);
    if (!existing || existing.time < line.time) {
      perSubmission.set(line.submissionId, line);
    }
  }

  return { perSubmission, scanned, invalid, outOfWindow };
}

/**
 * Run one pass of the backfill. Wraps the UPDATE in a single
 * transaction so a mid-run crash leaves no partially-patched batch
 * behind. Caller controls dry-run.
 */
export async function runBackfill(
  options: BackfillManualEntrySkipReasonsOptions,
): Promise<BackfillManualEntrySkipReasonsResult> {
  const { logLines, sinceMs, dryRun } = options;

  const { perSubmission, scanned, invalid, outOfWindow } = reduceLogLines(
    logLines,
    sinceMs,
  );

  const result: BackfillManualEntrySkipReasonsResult = {
    logLinesScanned: scanned,
    logLinesSkippedOutOfWindow: outOfWindow,
    invalidLogLines: invalid,
    uniqueSubmissions: perSubmission.size,
    unmatchedSubmissions: 0,
    candidateRowsFound: 0,
    rowsUpdated: 0,
    rowsWouldUpdate: 0,
    reasonBreakdown: {},
  };

  if (perSubmission.size === 0) return result;

  const submissionIds = Array.from(perSubmission.keys());

  await db.transaction(async (tx) => {
    // Find every audit row that:
    //   - matches one of our submissionIds AND
    //   - still carries the migration-default `status='sent' / reason
    //     IS NULL` shape AND
    //   - has zero across all four channel counters (i.e. was never an
    //     actual delivery attempt — the only rows we are confident
    //     were silent skip outcomes the team remembers).
    //
    // The query returns at most one row per submissionId because the
    // notifier inserts one row per call AND submissionId is unique on
    // the success path; in the rare case of multiple matching rows
    // (older retries that all wrote zero-counter rows), we patch them
    // all to the same outcome — they all describe the same notify
    // call.
    const candidates = await tx
      .select({
        id: manualEntryAlertsTable.id,
        submissionId: manualEntryAlertsTable.submissionId,
      })
      .from(manualEntryAlertsTable)
      .where(
        and(
          inArray(manualEntryAlertsTable.submissionId, submissionIds),
          eq(manualEntryAlertsTable.status, "sent"),
          isNull(manualEntryAlertsTable.reason),
          eq(manualEntryAlertsTable.pushAttempted, 0),
          eq(manualEntryAlertsTable.pushSent, 0),
          eq(manualEntryAlertsTable.emailAttempted, 0),
          eq(manualEntryAlertsTable.emailSent, 0),
        ),
      );

    result.candidateRowsFound = candidates.length;

    const matchedSubmissionIds = new Set(candidates.map((c) => c.submissionId));
    for (const id of submissionIds) {
      if (!matchedSubmissionIds.has(id)) result.unmatchedSubmissions += 1;
    }

    if (candidates.length === 0) return;

    // Group candidate row ids by the (status, reason) we'd write so we
    // can issue one UPDATE per distinct outcome rather than one UPDATE
    // per row. The combined cardinality is bounded by the number of
    // distinct reason strings observed in the logs (~handful for the
    // canonical MANUAL_ENTRY_NOTIFY_REASONS set, plus any free-form
    // failure messages from the `failed` path).
    const groups = new Map<string, { status: "skipped" | "failed"; reason: string; ids: number[] }>();
    for (const cand of candidates) {
      const log = perSubmission.get(cand.submissionId);
      // Defensive — the candidate query was filtered by submissionIds
      // pulled from `perSubmission`, so this branch is dead.
      if (!log) continue;
      const key = `${log.status}\x00${log.reason}`;
      const existing = groups.get(key);
      if (existing) existing.ids.push(cand.id);
      else groups.set(key, { status: log.status, reason: log.reason, ids: [cand.id] });

      result.reasonBreakdown[log.reason] =
        (result.reasonBreakdown[log.reason] ?? 0) + 1;
    }

    for (const group of groups.values()) {
      if (dryRun) {
        result.rowsWouldUpdate += group.ids.length;
        continue;
      }
      // Re-assert the candidate predicate inside the UPDATE so a
      // concurrent post-#1658 write that flipped status/reason
      // between SELECT and UPDATE wins (we never clobber a real
      // outcome with a backfilled one).
      const updated = await tx
        .update(manualEntryAlertsTable)
        .set({ status: group.status, reason: group.reason })
        .where(
          and(
            inArray(manualEntryAlertsTable.id, group.ids),
            eq(manualEntryAlertsTable.status, "sent"),
            isNull(manualEntryAlertsTable.reason),
            eq(manualEntryAlertsTable.pushAttempted, 0),
            eq(manualEntryAlertsTable.pushSent, 0),
            eq(manualEntryAlertsTable.emailAttempted, 0),
            eq(manualEntryAlertsTable.emailSent, 0),
          ),
        )
        .returning({ id: manualEntryAlertsTable.id });
      result.rowsUpdated += updated.length;
      result.rowsWouldUpdate += updated.length;
    }
  });

  return result;
}
