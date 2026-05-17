/**
 * Task #2069 — Regression coverage for the manual-entry-alert
 * skip-reason backfill (`src/lib/backfillManualEntryAlertSkipReasons.ts`).
 *
 * The backfill replays structured `[manual-entry-notify] result` log
 * lines (pino JSON, one per line) and patches `manual_entry_alerts`
 * rows that the Task #1658 history-starts-here migration left looking
 * like successful sends but actually were silent skip outcomes (zero
 * channel counters).
 *
 * This test pins down:
 *
 *   1. A zero-counter audit row whose submissionId appears in the log
 *      replay is patched to (status, reason) from the latest matching
 *      log line; reasonBreakdown reflects the patch.
 *   2. The latest log line wins when the same submissionId appears
 *      twice (notify retried).
 *   3. Out-of-window log lines (older than --days) are ignored.
 *   4. Audit rows that ALREADY have a non-default status/reason are
 *      never overwritten, even if a matching log line exists.
 *   5. Audit rows with non-zero channel counters are never touched
 *      (real sent/partially-sent alerts stay as-is).
 *   6. Dry-run mode reports `rowsWouldUpdate` but does not write —
 *      a follow-up `--apply` run on the same input then writes
 *      exactly those rows.
 *   7. Submissions whose log line has `status='sent'` are skipped
 *      entirely (we never overwrite a zero-counter row on the
 *      strength of a "sent" log claim).
 *   8. Invalid lines (malformed JSON, wrong msg, missing fields)
 *      do not crash the run and are surfaced in the summary.
 */
process.env.SESSION_SECRET ||= "test-session-secret-for-backfill-manual-entry-skip-reasons";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  db,
  manualEntryAlertsTable,
  roundSubmissionsTable,
  tournamentsTable,
  organizationsTable,
  playersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import {
  reduceLogLines,
  runBackfill,
  MANUAL_ENTRY_NOTIFY_LOG_MSG,
} from "../lib/backfillManualEntryAlertSkipReasons.js";

// --- Fixture scaffolding -----------------------------------------

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

let organizationId = 0;
let tournamentId = 0;
let playerId = 0;

// One submission per scenario row so we can reason about each test
// case independently. Populated in beforeAll.
const submissionIds = {
  zeroCounterDefault: 0,           // scenario 1: should be patched
  zeroCounterDefaultRetried: 0,    // scenario 2: latest-log wins
  zeroCounterAlreadyPatched: 0,    // scenario 4: must NOT be touched
  nonZeroCounter: 0,               // scenario 5: must NOT be touched
  zeroCounterDryRunOnly: 0,        // scenario 6: dry-run target
  zeroCounterSentLog: 0,           // scenario 7: 'sent' log → skip
  zeroCounterOutOfWindow: 0,       // scenario 3: log too old → skip
};

const insertedAlertIds: number[] = [];
const insertedSubmissionIds: number[] = [];

// `(player_id, round)` is uniquely indexed on `round_submissions`, so each
// scenario gets its own round number to keep the fixtures isolated.
let nextRound = 1;

async function insertSubmission(): Promise<number> {
  const round = nextRound;
  nextRound += 1;
  const [row] = await db
    .insert(roundSubmissionsTable)
    .values({
      tournamentId,
      playerId,
      round,
      status: "countersigned",
    })
    .returning({ id: roundSubmissionsTable.id });
  insertedSubmissionIds.push(row.id);
  return row.id;
}

async function insertAlert(opts: {
  submissionId: number;
  status?: "sent" | "skipped" | "failed";
  reason?: string | null;
  pushAttempted?: number;
  pushSent?: number;
  emailAttempted?: number;
  emailSent?: number;
}): Promise<number> {
  const [row] = await db
    .insert(manualEntryAlertsTable)
    .values({
      submissionId: opts.submissionId,
      tournamentId,
      playerId,
      round: 1,
      manualPct: "75.00",
      manualShots: 30,
      totalShots: 40,
      recipientCount: 0,
      pushAttempted: opts.pushAttempted ?? 0,
      pushSent: opts.pushSent ?? 0,
      emailAttempted: opts.emailAttempted ?? 0,
      emailSent: opts.emailSent ?? 0,
      status: opts.status ?? "sent",
      reason: opts.reason ?? null,
    })
    .returning({ id: manualEntryAlertsTable.id });
  insertedAlertIds.push(row.id);
  return row.id;
}

function mkLogLine(opts: {
  time: number;
  submissionId: number;
  status: string;
  reason: string | null | undefined;
}): string {
  const obj: Record<string, unknown> = {
    level: 30,
    time: opts.time,
    msg: MANUAL_ENTRY_NOTIFY_LOG_MSG,
    submissionId: opts.submissionId,
    status: opts.status,
  };
  if (opts.reason !== undefined) obj.reason = opts.reason;
  return JSON.stringify(obj);
}

// --- Lifecycle ---------------------------------------------------

beforeAll(async () => {
  // Minimal fixtures: one org → one tournament → one player → one
  // submission per scenario row. The backfill predicate is keyed only
  // by submissionId + counters + status/reason on the alert row, so we
  // don't need to seed users, memberships, or notification prefs here.
  const [org] = await db
    .insert(organizationsTable)
    .values({
      name: `BF Skip Org ${stamp}`,
      slug: `bf-skip-${stamp}`.slice(0, 60),
    })
    .returning({ id: organizationsTable.id });
  organizationId = org.id;

  const [tourn] = await db
    .insert(tournamentsTable)
    .values({
      name: `BF Skip Tournament ${stamp}`,
      organizationId,
      startDate: new Date(),
      endDate: new Date(),
    })
    .returning({ id: tournamentsTable.id });
  tournamentId = tourn.id;

  const [pl] = await db
    .insert(playersTable)
    .values({
      tournamentId,
      firstName: `BFSkip`,
      lastName: stamp.slice(0, 8),
    })
    .returning({ id: playersTable.id });
  playerId = pl.id;

  // Distinct submissions per scenario.
  submissionIds.zeroCounterDefault = await insertSubmission();
  submissionIds.zeroCounterDefaultRetried = await insertSubmission();
  submissionIds.zeroCounterAlreadyPatched = await insertSubmission();
  submissionIds.nonZeroCounter = await insertSubmission();
  submissionIds.zeroCounterDryRunOnly = await insertSubmission();
  submissionIds.zeroCounterSentLog = await insertSubmission();
  submissionIds.zeroCounterOutOfWindow = await insertSubmission();
});

afterAll(async () => {
  if (insertedAlertIds.length > 0) {
    await db
      .delete(manualEntryAlertsTable)
      .where(inArray(manualEntryAlertsTable.id, insertedAlertIds));
  }
  if (insertedSubmissionIds.length > 0) {
    await db
      .delete(roundSubmissionsTable)
      .where(inArray(roundSubmissionsTable.id, insertedSubmissionIds));
  }
  if (playerId) await db.delete(playersTable).where(eq(playersTable.id, playerId));
  if (tournamentId) await db.delete(tournamentsTable).where(eq(tournamentsTable.id, tournamentId));
  if (organizationId) await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
});

beforeEach(async () => {
  // Reset alert rows to a known state per test so cases don't bleed.
  if (insertedAlertIds.length > 0) {
    await db
      .delete(manualEntryAlertsTable)
      .where(inArray(manualEntryAlertsTable.id, insertedAlertIds));
    insertedAlertIds.length = 0;
  }
});

// --- Tests -------------------------------------------------------

describe("reduceLogLines", () => {
  const sinceMs = 1_000_000;

  it("keeps only `[manual-entry-notify] result` lines in the window", () => {
    const lines = [
      mkLogLine({ time: sinceMs + 100, submissionId: 1, status: "skipped", reason: "org_muted" }),
      mkLogLine({ time: sinceMs - 1, submissionId: 2, status: "skipped", reason: "below_threshold" }),
      JSON.stringify({ level: 30, time: sinceMs + 200, msg: "[other] log", submissionId: 3 }),
      "",
    ];
    const out = reduceLogLines(lines, sinceMs);
    expect(out.scanned).toBe(4);
    expect(out.outOfWindow).toBe(1);
    expect(out.invalid).toBe(0);
    expect(out.perSubmission.size).toBe(1);
    expect(out.perSubmission.get(1)?.reason).toBe("org_muted");
  });

  it("dedupes by submissionId, keeping the latest time", () => {
    const lines = [
      mkLogLine({ time: sinceMs + 100, submissionId: 9, status: "skipped", reason: "tournament_muted" }),
      mkLogLine({ time: sinceMs + 200, submissionId: 9, status: "skipped", reason: "org_muted" }),
      mkLogLine({ time: sinceMs + 50, submissionId: 9, status: "skipped", reason: "below_threshold" }),
    ];
    const out = reduceLogLines(lines, sinceMs);
    expect(out.perSubmission.get(9)?.reason).toBe("org_muted");
    expect(out.perSubmission.get(9)?.time).toBe(sinceMs + 200);
  });

  it("counts malformed/missing-field lines as invalid", () => {
    const lines = [
      "not-json",
      JSON.stringify({ msg: MANUAL_ENTRY_NOTIFY_LOG_MSG, time: sinceMs + 1 }),     // no submissionId
      JSON.stringify({ msg: MANUAL_ENTRY_NOTIFY_LOG_MSG, time: sinceMs + 1, submissionId: 5, status: "skipped" }), // no reason
      JSON.stringify({ msg: MANUAL_ENTRY_NOTIFY_LOG_MSG, time: sinceMs + 1, submissionId: 5, status: "skipped", reason: "" }), // empty reason
    ];
    const out = reduceLogLines(lines, sinceMs);
    expect(out.invalid).toBe(4);
    expect(out.perSubmission.size).toBe(0);
  });

  it("ignores `status='sent'` lines (those should never patch a zero-counter row)", () => {
    const lines = [
      mkLogLine({ time: sinceMs + 1, submissionId: 7, status: "sent", reason: "" }),
    ];
    const out = reduceLogLines(lines, sinceMs);
    expect(out.perSubmission.size).toBe(0);
    // 'sent' is "not-backfillable", which is silent (not counted as invalid).
    expect(out.invalid).toBe(0);
  });
});

describe("runBackfill", () => {
  it("patches zero-counter default rows from matching log lines (apply mode)", async () => {
    await insertAlert({ submissionId: submissionIds.zeroCounterDefault });

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logLines = [
      mkLogLine({
        time: Date.now() - 60_000,
        submissionId: submissionIds.zeroCounterDefault,
        status: "skipped",
        reason: "org_muted",
      }),
    ];

    const result = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(result.uniqueSubmissions).toBe(1);
    expect(result.candidateRowsFound).toBe(1);
    expect(result.rowsUpdated).toBe(1);
    expect(result.rowsWouldUpdate).toBe(1);
    expect(result.reasonBreakdown).toEqual({ org_muted: 1 });

    const [patched] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.zeroCounterDefault));
    expect(patched.status).toBe("skipped");
    expect(patched.reason).toBe("org_muted");
  });

  it("uses the latest log line when notify was called multiple times", async () => {
    await insertAlert({ submissionId: submissionIds.zeroCounterDefaultRetried });

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logLines = [
      mkLogLine({
        time: Date.now() - 5 * 60_000,
        submissionId: submissionIds.zeroCounterDefaultRetried,
        status: "skipped",
        reason: "tournament_muted",
      }),
      mkLogLine({
        time: Date.now() - 60_000,
        submissionId: submissionIds.zeroCounterDefaultRetried,
        status: "skipped",
        reason: "org_muted",
      }),
    ];

    const result = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(result.rowsUpdated).toBe(1);

    const [patched] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.zeroCounterDefaultRetried));
    expect(patched.reason).toBe("org_muted");
  });

  it("never overwrites a row that already has a non-default status/reason", async () => {
    await insertAlert({
      submissionId: submissionIds.zeroCounterAlreadyPatched,
      status: "skipped",
      reason: "below_threshold",
    });

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logLines = [
      mkLogLine({
        time: Date.now() - 60_000,
        submissionId: submissionIds.zeroCounterAlreadyPatched,
        status: "skipped",
        reason: "org_muted",
      }),
    ];

    const result = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(result.uniqueSubmissions).toBe(1);
    expect(result.candidateRowsFound).toBe(0);
    expect(result.unmatchedSubmissions).toBe(1);
    expect(result.rowsUpdated).toBe(0);

    const [unchanged] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.zeroCounterAlreadyPatched));
    expect(unchanged.reason).toBe("below_threshold");
  });

  it("never touches rows with at least one channel attempt", async () => {
    await insertAlert({
      submissionId: submissionIds.nonZeroCounter,
      pushAttempted: 2,
      pushSent: 2,
      emailAttempted: 2,
      emailSent: 1,
    });

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logLines = [
      mkLogLine({
        time: Date.now() - 60_000,
        submissionId: submissionIds.nonZeroCounter,
        status: "failed",
        reason: "smtp 500",
      }),
    ];

    const result = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(result.candidateRowsFound).toBe(0);
    expect(result.rowsUpdated).toBe(0);

    const [unchanged] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.nonZeroCounter));
    expect(unchanged.status).toBe("sent");
    expect(unchanged.reason).toBeNull();
    expect(unchanged.pushSent).toBe(2);
  });

  it("ignores log lines older than the retention window", async () => {
    await insertAlert({ submissionId: submissionIds.zeroCounterOutOfWindow });

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logLines = [
      mkLogLine({
        time: sinceMs - 1_000,
        submissionId: submissionIds.zeroCounterOutOfWindow,
        status: "skipped",
        reason: "org_muted",
      }),
    ];

    const result = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(result.logLinesSkippedOutOfWindow).toBe(1);
    expect(result.uniqueSubmissions).toBe(0);
    expect(result.rowsUpdated).toBe(0);

    const [unchanged] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.zeroCounterOutOfWindow));
    expect(unchanged.status).toBe("sent");
    expect(unchanged.reason).toBeNull();
  });

  it("dry-run reports rowsWouldUpdate without writing; --apply then writes exactly those rows", async () => {
    await insertAlert({ submissionId: submissionIds.zeroCounterDryRunOnly });

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logLines = [
      mkLogLine({
        time: Date.now() - 60_000,
        submissionId: submissionIds.zeroCounterDryRunOnly,
        status: "skipped",
        reason: "no_recipients",
      }),
    ];

    const dry = await runBackfill({ logLines, sinceMs, dryRun: true });
    expect(dry.candidateRowsFound).toBe(1);
    expect(dry.rowsWouldUpdate).toBe(1);
    expect(dry.rowsUpdated).toBe(0);
    expect(dry.reasonBreakdown).toEqual({ no_recipients: 1 });

    const [stillDefault] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.zeroCounterDryRunOnly));
    expect(stillDefault.status).toBe("sent");
    expect(stillDefault.reason).toBeNull();

    const applied = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(applied.rowsUpdated).toBe(1);

    const [patched] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.zeroCounterDryRunOnly));
    expect(patched.status).toBe("skipped");
    expect(patched.reason).toBe("no_recipients");

    // Re-running on the same input is a no-op — the candidate predicate
    // excludes rows we already patched.
    const rerun = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(rerun.candidateRowsFound).toBe(0);
    expect(rerun.rowsUpdated).toBe(0);
  });

  it("never patches a zero-counter row from a `status='sent'` log line", async () => {
    await insertAlert({ submissionId: submissionIds.zeroCounterSentLog });

    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const logLines = [
      mkLogLine({
        time: Date.now() - 60_000,
        submissionId: submissionIds.zeroCounterSentLog,
        status: "sent",
        reason: "",
      }),
    ];

    const result = await runBackfill({ logLines, sinceMs, dryRun: false });
    expect(result.uniqueSubmissions).toBe(0);
    expect(result.rowsUpdated).toBe(0);

    const [unchanged] = await db
      .select()
      .from(manualEntryAlertsTable)
      .where(eq(manualEntryAlertsTable.submissionId, submissionIds.zeroCounterSentLog));
    expect(unchanged.status).toBe("sent");
    expect(unchanged.reason).toBeNull();
  });
});
