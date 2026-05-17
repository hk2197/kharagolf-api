/**
 * Auto-page on-call when the daily round-weather-cache backfill keeps
 * failing (Task #2002).
 *
 * Background — Task #1612 added a daily cron that walks the trailing
 * 30-day window of rounds and asks Open-Meteo for any observations the
 * cache is still missing. The cron logs a per-pass summary
 * (`filled` / `stillPending` / `failed` / `total`), but if Open-Meteo
 * goes down for an extended period — or its API contract changes and
 * every call starts throwing — nothing surfaces until a human
 * happens to grep the logs.
 *
 * This module closes the loop. The cron now records each pass's
 * outcome into a small in-memory rolling history, then asks
 * `runRoundWeatherBackfillOpsAlertJob` whether any of three streak
 * detectors have tripped:
 *
 *   1. **failed_streak** — the last N consecutive passes each had at
 *      least `failedThreshold` `failed` fetches (default 1 — i.e. ANY
 *      failed call N days running). Catches the "Open-Meteo started
 *      returning HTTP 5xx and we just keep retrying" pattern.
 *
 *   2. **pending_streak** — the last N consecutive passes each had at
 *      least `pendingThreshold` `stillPending` rows (default 25). Some
 *      pile-up is normal because the archive lags ~5 days, but if dozens
 *      of rounds stay pending day after day the archive itself has
 *      stopped catching up.
 *
 *   3. **errored_streak** — the last N consecutive passes threw before
 *      reporting any counts at all. Catches the "the cron itself blew
 *      up for >24h" case from the task spec — e.g. a deploy broke the
 *      DB query, or the Open-Meteo client started throwing on parse.
 *
 * Cooldown: in-process timestamp gates re-sends within
 * `OPS_WEATHER_BACKFILL_COOLDOWN_HOURS` (default 24h). The cron interval
 * itself is 24h, so this collapses to "at most one page per day per
 * replica" in practice. A process restart can re-page once inside the
 * cooldown — acceptable, and matches the dedup semantics of every
 * other ops-alert module in this codebase.
 *
 * Recipients: union of every `super_admin` in `app_users` with a
 * non-null email AND the on-call list parsed from `OPS_ALERT_EMAILS`.
 * Mirrors `swingFpsProbeFailureOpsAlert` so on-call only ever has to
 * configure one address.
 *
 * Configuration (env, all optional):
 *   - `OPS_WEATHER_BACKFILL_FAILED_THRESHOLD`     default 1
 *   - `OPS_WEATHER_BACKFILL_PENDING_THRESHOLD`    default 25
 *   - `OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES`   default 3
 *   - `OPS_WEATHER_BACKFILL_COOLDOWN_HOURS`       default 24
 *   - `OPS_WEATHER_BACKFILL_HISTORY_SIZE`         default 10
 *   - `OPS_ALERT_EMAILS`                          comma-separated on-call list
 *   - `APP_BASE_URL` / `PUBLIC_BASE_URL`          deep-link base
 */
import { db, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { sendRoundWeatherBackfillOpsAlertEmail } from "./mailer";
import { sendPushToUsers, type PushDeliveryResult } from "./push";

import {
  DEFAULT_OPS_WEATHER_BACKFILL_FAILED_THRESHOLD,
  DEFAULT_OPS_WEATHER_BACKFILL_PENDING_THRESHOLD,
  DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES,
  DEFAULT_OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES,
  DEFAULT_OPS_WEATHER_BACKFILL_COOLDOWN_HOURS,
  DEFAULT_OPS_WEATHER_BACKFILL_HISTORY_SIZE,
} from "./roundWeatherBackfillOpsAlert.constants";
export {
  DEFAULT_OPS_WEATHER_BACKFILL_FAILED_THRESHOLD,
  DEFAULT_OPS_WEATHER_BACKFILL_PENDING_THRESHOLD,
  DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES,
  DEFAULT_OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES,
  DEFAULT_OPS_WEATHER_BACKFILL_COOLDOWN_HOURS,
  DEFAULT_OPS_WEATHER_BACKFILL_HISTORY_SIZE,
} from "./roundWeatherBackfillOpsAlert.constants";

/**
 * One per-pass entry in the rolling history buffer. Either the cron
 * completed and produced a summary (`completed`) or it threw before it
 * could (`errored`). Both shapes carry a timestamp so the alert email
 * can render a trailing window with absolute times for context.
 */
export type RoundWeatherBackfillPassEntry =
  | {
      kind: "completed";
      at: Date;
      filled: number;
      stillPending: number;
      failed: number;
      total: number;
    }
  | {
      kind: "errored";
      at: Date;
      message: string;
    };

const passHistory: RoundWeatherBackfillPassEntry[] = [];
let lastAlertedAtMs: number | null = null;

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Sentinel value: when a threshold resolves to this, the corresponding
 * streak detector is disabled in the evaluator. Operators can opt out
 * of either detector with `OPS_WEATHER_BACKFILL_FAILED_THRESHOLD=0` or
 * `OPS_WEATHER_BACKFILL_PENDING_THRESHOLD=0` and rely solely on the
 * remaining detectors. We can't use `>= 0` directly in the evaluator
 * because every completed pass with `failed=0` would then trip the
 * gate immediately.
 */
export const OPS_WEATHER_BACKFILL_DISABLED_THRESHOLD = 0;

function parseEnvNonNegative(name: string, fallback: number): number {
  // Zero is a valid value and explicitly DISABLES the corresponding
  // streak detector (see OPS_WEATHER_BACKFILL_DISABLED_THRESHOLD). The
  // evaluator below short-circuits when it sees the sentinel — this is
  // crucial because `>= 0` would otherwise trip on every completed
  // pass and produce a permanent false positive. Negative or
  // non-finite values fall back to the documented default.
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function dedupEmails(emails: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of emails) {
    if (!e) continue;
    const key = e.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e.trim());
  }
  return out;
}

async function loadSuperAdminEmails(): Promise<string[]> {
  const rows = await db
    .select({ email: appUsersTable.email })
    .from(appUsersTable)
    .where(eq(appUsersTable.role, "super_admin"));
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

async function loadSuperAdminUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: appUsersTable.id })
    .from(appUsersTable)
    .where(eq(appUsersTable.role, "super_admin"));
  return rows.map((r) => r.id);
}

function resolveBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? "kharagolf.com"}`
  );
}

/**
 * Push a new pass entry onto the rolling history buffer, trimming to
 * the configured history size. Called by the cron after each pass —
 * `entry.kind === "completed"` when the backfill returned a summary,
 * `entry.kind === "errored"` when the cron's outer try/catch caught a
 * throw before any summary could be produced.
 *
 * The history-size cap can be overridden per-call so tests can pin
 * behaviour without setting env vars; production callers omit it and
 * pick up the env / default fallback.
 */
export function recordRoundWeatherBackfillPass(
  entry: RoundWeatherBackfillPassEntry,
  opts?: { historySize?: number },
): void {
  passHistory.push(entry);
  const historySize =
    opts?.historySize ??
    parseEnvNumber(
      "OPS_WEATHER_BACKFILL_HISTORY_SIZE",
      DEFAULT_OPS_WEATHER_BACKFILL_HISTORY_SIZE,
    );
  while (passHistory.length > Math.max(1, historySize)) {
    passHistory.shift();
  }
}

/** Test-only: reset both the history buffer and the cooldown stamp. */
export function _resetRoundWeatherBackfillOpsAlertForTest(): void {
  passHistory.length = 0;
  lastAlertedAtMs = null;
}

/** Test-only: read the rolling history buffer (snapshot copy). */
export function _getRoundWeatherBackfillPassHistoryForTest(): RoundWeatherBackfillPassEntry[] {
  return passHistory.slice();
}

export type RoundWeatherBackfillBreachKind =
  | "failed_streak"
  | "pending_streak"
  | "errored_streak";

export interface RoundWeatherBackfillBreach {
  kind: RoundWeatherBackfillBreachKind;
  /** Human-readable detail line for the email body / structured log. */
  detail: string;
}

export interface EvaluateRoundWeatherBackfillBreachesInput {
  history: readonly RoundWeatherBackfillPassEntry[];
  failedThreshold: number;
  pendingThreshold: number;
  /**
   * How many consecutive completed passes must each exceed the
   * failed/pending thresholds for `failed_streak` / `pending_streak`
   * to fire. The cron runs every 24h, so 3 here means "the issue has
   * persisted for ~3 days" — long enough to filter transient blips.
   */
  consecutivePasses: number;
  /**
   * How many consecutive ERRORED passes must occur for
   * `errored_streak` to fire. Decoupled from `consecutivePasses`
   * because a thrown cron is a structurally louder signal than a
   * non-zero `failed` count and the task spec asks for ">24h" of
   * cron throws specifically. Default in practice: 2 (~24h between
   * the first and second throw at a 24h cron interval). When omitted
   * the evaluator falls back to `consecutivePasses` for backwards
   * compatibility with callers that haven't been updated.
   */
  erroredConsecutivePasses?: number;
}

/**
 * Pure breach-evaluation function. Tests pin it directly to assert on
 * each detector's behaviour without touching the DB / mailer / history
 * buffer. The runner below glues this to the cooldown gate, recipient
 * resolution, and the email send.
 *
 * Detector ordering note: errored-streak detection runs first AND on
 * its own (independent) window length. When the most recent
 * `erroredConsecutivePasses` entries are all errored, we emit ONLY
 * the `errored_streak` breach. Synthesising a `failed_streak` or
 * `pending_streak` from rows that never produced any counts would be
 * misleading — the underlying signal is "we have no data at all",
 * which `errored_streak` already conveys.
 */
export function evaluateRoundWeatherBackfillBreaches(
  input: EvaluateRoundWeatherBackfillBreachesInput,
): RoundWeatherBackfillBreach[] {
  const {
    history,
    failedThreshold,
    pendingThreshold,
    consecutivePasses,
    erroredConsecutivePasses,
  } = input;
  const breaches: RoundWeatherBackfillBreach[] = [];

  // --- errored_streak (independent window length) --------------------
  // The cron runs every 24h, so paging at the same `consecutivePasses`
  // (default 3) as failed/pending would mean we'd wait ~72h before
  // surfacing a fully-broken cron. The task spec asks for ">24h",
  // which a default of 2 here meets (two consecutive errored passes
  // ~= 24h between the first and second throw).
  const erroredWindow =
    erroredConsecutivePasses != null && erroredConsecutivePasses > 0
      ? erroredConsecutivePasses
      : consecutivePasses;
  if (erroredWindow > 0 && history.length >= erroredWindow) {
    const recentErrored = history.slice(-erroredWindow);
    if (recentErrored.every((e) => e.kind === "errored")) {
      const lastErrored = recentErrored[recentErrored.length - 1] as Extract<
        RoundWeatherBackfillPassEntry,
        { kind: "errored" }
      >;
      breaches.push({
        kind: "errored_streak",
        detail:
          `The last ${erroredWindow} round-weather backfill passes ` +
          `threw before producing a summary. Most recent error: ` +
          `${lastErrored.message}`,
      });
      // We deliberately stop here: a window of all-errored passes
      // never produces meaningful failed/pending counts.
      return breaches;
    }
  }

  // --- failed_streak / pending_streak (shared `consecutivePasses`) ---
  if (consecutivePasses <= 0) return breaches;
  if (history.length < consecutivePasses) return breaches;

  const recent = history.slice(-consecutivePasses);

  // Both streak detectors below require every entry in the window to
  // have completed (an erroring entry breaks the streak by definition).
  const allCompleted = recent.every(
    (e): e is Extract<RoundWeatherBackfillPassEntry, { kind: "completed" }> =>
      e.kind === "completed",
  );
  if (!allCompleted) return breaches;

  // Threshold === 0 disables the corresponding detector. We can't use
  // `>= 0` here because every completed pass with zero failures would
  // then trip the gate immediately, producing a permanent false
  // positive. See OPS_WEATHER_BACKFILL_DISABLED_THRESHOLD.
  if (
    failedThreshold > OPS_WEATHER_BACKFILL_DISABLED_THRESHOLD &&
    recent.every((e) => e.failed >= failedThreshold)
  ) {
    const counts = recent.map((e) => e.failed).join(", ");
    breaches.push({
      kind: "failed_streak",
      detail:
        `The last ${consecutivePasses} round-weather backfill passes each ` +
        `had ${failedThreshold}+ failed Open-Meteo fetches. Failed counts ` +
        `(oldest → newest): ${counts}.`,
    });
  }

  if (
    pendingThreshold > OPS_WEATHER_BACKFILL_DISABLED_THRESHOLD &&
    recent.every((e) => e.stillPending >= pendingThreshold)
  ) {
    const counts = recent.map((e) => e.stillPending).join(", ");
    breaches.push({
      kind: "pending_streak",
      detail:
        `The last ${consecutivePasses} round-weather backfill passes each ` +
        `had ${pendingThreshold}+ rounds still pending an Open-Meteo ` +
        `observation. stillPending counts (oldest → newest): ${counts}.`,
    });
  }

  return breaches;
}

export interface RunRoundWeatherBackfillOpsAlertOpts {
  /** Override the per-pass failed-row threshold (defaults to env / 1). */
  failedThreshold?: number;
  /** Override the per-pass still-pending threshold (defaults to env / 25). */
  pendingThreshold?: number;
  /** Override the failed/pending streak length (defaults to env / 3). */
  consecutivePasses?: number;
  /**
   * Override the errored-streak length (defaults to env / 2 — that's
   * "the cron threw on two consecutive daily passes" ≈ ">24h" of
   * cron throws, which is the trigger the task spec asks for).
   */
  erroredConsecutivePasses?: number;
  /** Override the cooldown in hours (defaults to env / 24). */
  cooldownHours?: number;
  /**
   * Override the recipient list. When unset, the union of all
   * super_admin emails and `OPS_ALERT_EMAILS` is used.
   */
  recipients?: string[];
  /**
   * Override the super-admin push recipients (user ids). When unset,
   * we look them up from `app_users` so a real super_admin gets a push
   * to every device they've registered. Pass an empty array to skip
   * the push leg in tests.
   */
  pushUserIds?: number[];
  /** Override the deep-link base URL. */
  baseUrl?: string;
  /**
   * Override the history buffer the evaluator reads. Used by tests so
   * they don't have to call `recordRoundWeatherBackfillPass` to
   * arrange state. Production callers omit it and read the in-process
   * buffer.
   */
  historyOverride?: readonly RoundWeatherBackfillPassEntry[];
  /** Bypass the cooldown (used by tests / manual triggers). */
  force?: boolean;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

export interface RunRoundWeatherBackfillOpsAlertResult {
  alerted: boolean;
  reason?: "no_breach" | "in_cooldown" | "no_recipients" | "send_failed";
  breaches: RoundWeatherBackfillBreach[];
  failedThreshold: number;
  pendingThreshold: number;
  consecutivePasses: number;
  /**
   * Resolved errored-streak length (env / opts / default). Surfaced
   * separately so dashboards can show the actual ">24h" threshold
   * the cron is evaluating against.
   */
  erroredConsecutivePasses: number;
  cooldownHours: number;
  /** The slice of history the evaluator considered (oldest → newest). */
  windowHistory: RoundWeatherBackfillPassEntry[];
  recipientsAttempted: number;
  recipientsEmailed: number;
  /** Number of super-admin user ids we attempted to push to. */
  pushUsersAttempted: number;
  /**
   * Push delivery result from `sendPushToUsers` (Expo). `null` when
   * the push leg was skipped because there were no super_admin push
   * recipients to dispatch to.
   */
  pushDelivery: PushDeliveryResult | null;
}

/**
 * Daily job: read the rolling per-pass history, decide whether any of
 * the streak detectors are tripped, and email super-admins + on-call
 * when they are. Returns a structured result so cron / tests can
 * assert on the outcome without scraping logs.
 */
export async function runRoundWeatherBackfillOpsAlertJob(
  opts: RunRoundWeatherBackfillOpsAlertOpts = {},
): Promise<RunRoundWeatherBackfillOpsAlertResult> {
  const now = opts.now ?? new Date();

  const failedThreshold =
    opts.failedThreshold ??
    parseEnvNonNegative(
      "OPS_WEATHER_BACKFILL_FAILED_THRESHOLD",
      DEFAULT_OPS_WEATHER_BACKFILL_FAILED_THRESHOLD,
    );
  const pendingThreshold =
    opts.pendingThreshold ??
    parseEnvNonNegative(
      "OPS_WEATHER_BACKFILL_PENDING_THRESHOLD",
      DEFAULT_OPS_WEATHER_BACKFILL_PENDING_THRESHOLD,
    );
  const consecutivePasses =
    opts.consecutivePasses ??
    parseEnvNumber(
      "OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES",
      DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES,
    );
  const erroredConsecutivePasses =
    opts.erroredConsecutivePasses ??
    parseEnvNumber(
      "OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES",
      DEFAULT_OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES,
    );
  const cooldownHours =
    opts.cooldownHours ??
    parseEnvNumber(
      "OPS_WEATHER_BACKFILL_COOLDOWN_HOURS",
      DEFAULT_OPS_WEATHER_BACKFILL_COOLDOWN_HOURS,
    );

  const history = opts.historyOverride ?? passHistory;
  const windowHistory =
    history.length >= consecutivePasses
      ? history.slice(-consecutivePasses)
      : history.slice();

  const breaches = evaluateRoundWeatherBackfillBreaches({
    history,
    failedThreshold,
    pendingThreshold,
    consecutivePasses,
    erroredConsecutivePasses,
  });

  const baseResult: Omit<
    RunRoundWeatherBackfillOpsAlertResult,
    | "alerted"
    | "reason"
    | "recipientsAttempted"
    | "recipientsEmailed"
    | "pushUsersAttempted"
    | "pushDelivery"
  > = {
    breaches,
    failedThreshold,
    pendingThreshold,
    consecutivePasses,
    erroredConsecutivePasses,
    cooldownHours,
    windowHistory,
  };

  if (breaches.length === 0) {
    return {
      ...baseResult,
      alerted: false,
      reason: "no_breach",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      pushUsersAttempted: 0,
      pushDelivery: null,
    };
  }

  // Cooldown gate — keep a sustained outage to one page per cooldown
  // window. `force` lets manual triggers / tests bypass.
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  if (
    !opts.force &&
    lastAlertedAtMs != null &&
    now.getTime() - lastAlertedAtMs < cooldownMs
  ) {
    return {
      ...baseResult,
      alerted: false,
      reason: "in_cooldown",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      pushUsersAttempted: 0,
      pushDelivery: null,
    };
  }

  // Resolve email recipients (union of super_admin emails + OPS_ALERT_EMAILS)
  // and the super_admin user-id list for the push leg in a single pair
  // of round-trips. Tests can override either via `recipients` /
  // `pushUserIds` so they don't have to mock the DB layer.
  let recipients = opts.recipients;
  let pushUserIds = opts.pushUserIds;
  if (!recipients || !pushUserIds) {
    const needEmails = !recipients;
    const needPushIds = !pushUserIds;
    const [superAdminEmails, superAdminIds] = await Promise.all([
      needEmails ? loadSuperAdminEmails() : Promise.resolve<string[]>([]),
      needPushIds ? loadSuperAdminUserIds() : Promise.resolve<number[]>([]),
    ]);
    if (!recipients) {
      const onCall = parseRecipients(process.env.OPS_ALERT_EMAILS);
      recipients = dedupEmails([...superAdminEmails, ...onCall]);
    } else {
      recipients = dedupEmails(recipients);
    }
    if (!pushUserIds) {
      pushUserIds = superAdminIds;
    }
  } else {
    recipients = dedupEmails(recipients);
  }

  // No recipients at ALL — neither an email nor a push target — is the
  // only "nothing we can do" branch. If we have super_admin push targets
  // but no email recipients, the push still goes out (and vice versa);
  // the alert is whatever delivery channel(s) we can reach.
  if (recipients.length === 0 && pushUserIds.length === 0) {
    logger.warn(
      { breaches, windowHistory },
      "[ops-alert] round-weather backfill streak detected but no super_admin or OPS_ALERT_EMAILS recipient is configured; skipping email + push",
    );
    return {
      ...baseResult,
      alerted: false,
      reason: "no_recipients",
      recipientsAttempted: 0,
      recipientsEmailed: 0,
      pushUsersAttempted: 0,
      pushDelivery: null,
    };
  }

  const dashboardUrl =
    (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "") +
    "/super-admin/round-weather-cache";

  let emailed = 0;
  for (const to of recipients) {
    try {
      await sendRoundWeatherBackfillOpsAlertEmail({
        to,
        breaches,
        windowHistory,
        failedThreshold,
        pendingThreshold,
        consecutivePasses,
        cooldownHours,
        dashboardUrl,
        now,
      });
      emailed += 1;
    } catch (err) {
      logger.warn(
        { err, to },
        "[ops-alert] failed to send round-weather backfill ops alert email",
      );
    }
  }

  // Super-admin push leg — explicitly required by Task #2002 ("email
  // to OPS_ALERT_EMAILS + super-admin push"). We send a single fan-out
  // call with a short, scannable title/body and a structured `data`
  // payload the mobile app can use to deep-link straight into the
  // round-weather-cache super-admin screen. Push errors are caught so
  // they never prevent the email from counting as a successful page.
  let pushDelivery: PushDeliveryResult | null = null;
  if (pushUserIds.length > 0) {
    const breachLabels = breaches
      .map((b) =>
        b.kind === "errored_streak"
          ? "errored"
          : b.kind === "failed_streak"
            ? "failed"
            : b.kind === "pending_streak"
              ? "stuck"
              : b.kind,
      )
      .join(" + ");
    const pushTitle = "Round-weather backfill unhealthy";
    const pushBody = `${consecutivePasses} consecutive passes ${breachLabels}. Tap to investigate.`;
    try {
      pushDelivery = await sendPushToUsers(pushUserIds, pushTitle, pushBody, {
        type: "ops_alert_round_weather_backfill",
        breachKinds: breaches.map((b) => b.kind),
        consecutivePasses,
        dashboardUrl,
      });
    } catch (err) {
      logger.warn(
        { err, pushUserIds },
        "[ops-alert] failed to send round-weather backfill ops alert push",
      );
      pushDelivery = {
        attempted: pushUserIds.length,
        sent: 0,
        failed: pushUserIds.length,
        invalid: 0,
      };
    }
  }

  // We count the page as "alerted" if EITHER channel delivered to at
  // least one recipient. The cooldown stamp is set on the same
  // condition so a transient mailer outage doesn't burn the cooldown
  // when the push also failed (we'd want to retry on the next pass).
  const pushSent = pushDelivery?.sent ?? 0;
  if (emailed > 0 || pushSent > 0) {
    lastAlertedAtMs = now.getTime();
    logger.warn(
      {
        breaches,
        windowHistory,
        recipientsEmailed: emailed,
        pushUsersAttempted: pushUserIds.length,
        pushSent,
      },
      "[ops-alert] round-weather backfill streak detected — ops paged",
    );
    return {
      ...baseResult,
      alerted: true,
      recipientsAttempted: recipients.length,
      recipientsEmailed: emailed,
      pushUsersAttempted: pushUserIds.length,
      pushDelivery,
    };
  }

  return {
    ...baseResult,
    alerted: false,
    reason: "send_failed",
    recipientsAttempted: recipients.length,
    recipientsEmailed: 0,
    pushUsersAttempted: pushUserIds.length,
    pushDelivery,
  };
}
