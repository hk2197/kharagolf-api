/**
 * Admin-tunable settings for the ops alerts (Tasks #1305 + #1664).
 *
 * Originally added for the retry-exhaustion ops alert
 * (`./notifyExhaustionOpsAlert.ts`) which used to read its threshold +
 * lookback window exclusively from env vars. That meant changing
 * sensitivity required redeploying the API server, which was clumsy on
 * noisy days when ops just wanted to bump the threshold to silence the
 * alert until the underlying provider issue was fixed.
 *
 * Task #1664 extended the same module to cover the manual-entry alert
 * health auto-page (`./manualEntryAlertHealthOpsAlert.ts`, Task #1387)
 * with four additional tunables: rate threshold percent, min sample,
 * consecutive-zero count, and cooldown hours. The two alerts share one
 * singleton DB row + one audit log so the super-admin UI can surface
 * them side by side.
 *
 * This module backs all six tunables with the singleton settings table
 * (`ops_alert_settings`, see `lib/db/src/schema/golf.ts`):
 *   - The crons / alerts read the row on every run via
 *     {@link resolveOpsAlertConfig}, so changes are picked up without
 *     restarting the API server.
 *   - The super-admin UI calls {@link updateOpsAlertSettings} to write
 *     new values (or NULL to clear an override and fall back to env).
 *   - When a column is NULL we fall back to the env var, and when the
 *     env var is missing/invalid we fall back to the hardcoded default.
 *     This keeps the historical behaviour intact for environments that
 *     never customise anything.
 *
 * A small in-process cache (5s TTL) absorbs request bursts without
 * round-tripping the DB on every cron tick / status read. Five seconds
 * is small enough that a panicked support agent who just edited the
 * threshold sees their change reflected on the next cron run (cron
 * typically runs minutes apart) but large enough to absorb the few
 * back-to-back reads that happen inside one alert evaluation.
 */
import { db, opsAlertSettingsTable, opsAlertSettingsHistoryTable, appUsersTable } from "@workspace/db";
import { aliasedTable, and, desc, eq, gte, lt, lte, sql, type SQL } from "drizzle-orm";
import {
  DEFAULT_OPS_NOTIFY_EXHAUSTION_THRESHOLD,
  DEFAULT_OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS,
} from "./notifyExhaustionOpsAlert.constants";
import {
  DEFAULT_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT,
  DEFAULT_MANUAL_ENTRY_ALERT_MIN_SAMPLE,
  DEFAULT_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO,
  DEFAULT_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS,
  DEFAULT_MANUAL_ENTRY_ALERT_LOOKBACK_HOURS,
  DEFAULT_MANUAL_ENTRY_ALERT_DRY_RUN,
  DEFAULT_MANUAL_ENTRY_ALERT_RECIPIENT_LOOKUP_LIMIT,
} from "./manualEntryAlertHealthOpsAlert.constants";
import { logger } from "./logger";

const SINGLETON_ID = 1;
const CACHE_TTL_MS = 5_000;

/** Provenance label for any one tunable. */
export type OpsAlertSettingSource = "db" | "env" | "default";

/**
 * Source label for the resolved retry-exhaustion ops-alert recipient
 * list (Task #1910). `org_override` when the singleton row holds a
 * non-empty array; `env` when the resolved list came from
 * `OPS_ALERT_EMAILS`. Mirrors the per-tunable provenance shape used
 * elsewhere in this file so the admin UI can render the same
 * "currently inheriting from env" / "stored in DB" line.
 */
export type OpsAlertRecipientsSource = "org_override" | "env";

/**
 * Resolved retry-exhaustion ops-alert recipient list (Task #1910).
 *
 * `effective` is what the cron will actually email — DB override when
 * a non-empty array is stored, otherwise the env-var list. `dbList`
 * is the raw DB-stored override (null when no override is set, []
 * when an admin explicitly cleared it). `envList` is the parsed
 * env-var list, exposed so the UI can label the fallback ("inheriting
 * from OPS_ALERT_EMAILS (a@x.com, b@y.com)").
 *
 * Why empty array → fall back to env: the task explicitly calls for
 * a saved empty list to "visibly fall back to env" so an admin can
 * never accidentally silence the breach email — env recipients are
 * the floor, not the ceiling. The `source` field still distinguishes
 * the two cases for the UI badge.
 */
export interface ResolvedOpsAlertRecipients {
  effective: string[];
  source: OpsAlertRecipientsSource;
  dbList: string[] | null;
  envList: string[];
  envVar: string;
}

/** Resolved manual-entry alert health tunables (Task #1664 + Task #2081). */
export interface ResolvedManualEntryAlertConfig {
  /** Effective rate threshold percentage the cron should compare against. */
  rateThresholdPct: number;
  /** Effective minimum 7d alert sample size before the rate-breach gate fires. */
  minSample: number;
  /** Effective "N consecutive zero-delivery alerts" trigger. */
  consecutiveZero: number;
  /** Effective cooldown in hours between repeat pages. */
  cooldownHours: number;
  /** Task #2081 — effective lookback window (hours) for the muted-skip
   *  pile-up `since` query. */
  lookbackHours: number;
  /** Task #2081 — when true, the cron evaluates breaches and writes a
   *  page-history row but skips email + chat dispatch. */
  dryRun: boolean;
  /** Task #2081 — cap on the deduplicated recipient list before the
   *  email send loop. */
  recipientLookupLimit: number;
  source: {
    rateThresholdPct: OpsAlertSettingSource;
    minSample: OpsAlertSettingSource;
    consecutiveZero: OpsAlertSettingSource;
    cooldownHours: OpsAlertSettingSource;
    lookbackHours: OpsAlertSettingSource;
    dryRun: OpsAlertSettingSource;
    recipientLookupLimit: OpsAlertSettingSource;
  };
  /** DB-stored override values (possibly null when no override is set). */
  dbRateThresholdPct: number | null;
  dbMinSample: number | null;
  dbConsecutiveZero: number | null;
  dbCooldownHours: number | null;
  dbLookbackHours: number | null;
  dbDryRun: boolean | null;
  dbRecipientLookupLimit: number | null;
  /** Env-var values (possibly null when unset / invalid). */
  envRateThresholdPct: number | null;
  envMinSample: number | null;
  envConsecutiveZero: number | null;
  envCooldownHours: number | null;
  envLookbackHours: number | null;
  envDryRun: boolean | null;
  envRecipientLookupLimit: number | null;
  /** Hardcoded defaults — exposed so the UI can label the fallback. */
  defaultRateThresholdPct: number;
  defaultMinSample: number;
  defaultConsecutiveZero: number;
  defaultCooldownHours: number;
  defaultLookbackHours: number;
  defaultDryRun: boolean;
  defaultRecipientLookupLimit: number;
}

/** Effective config values + provenance for each tunable. */
export interface ResolvedOpsAlertConfig {
  /** The numeric threshold the cron should compare against. */
  threshold: number;
  /** The lookback window in hours the cron should query against. */
  windowHours: number;
  /** Where each value came from — exposed so the admin UI can show
   *  "currently inheriting from env (5)" vs "overridden in DB (12)". */
  source: {
    threshold: OpsAlertSettingSource;
    windowHours: OpsAlertSettingSource;
  };
  /** DB-stored values (possibly null when no override is set). */
  dbThreshold: number | null;
  dbWindowHours: number | null;
  /** Env-var values (possibly null when unset / invalid). */
  envThreshold: number | null;
  envWindowHours: number | null;
  /** Hardcoded defaults — exposed so the UI can label the fallback. */
  defaultThreshold: number;
  defaultWindowHours: number;
  /** Task #1664 — manual-entry alert health tunables, resolved with the
   *  same DB → env → default precedence. Grouped under one nested key
   *  so the existing retry-exhaustion fields keep their flat shape and
   *  callers / tests that only care about the original two tunables
   *  don't need to know the manual-entry block exists. */
  manualEntry: ResolvedManualEntryAlertConfig;
  /**
   * Task #1910 — resolved retry-exhaustion ops-alert recipient list,
   * grouped under one nested key for the same reasons as the
   * manual-entry block: callers / tests that only care about the
   * threshold + window keep their flat shape and don't need to know
   * the recipients block exists.
   */
  recipients: ResolvedOpsAlertRecipients;
  /** Audit metadata for the singleton row, when one exists. */
  updatedAt: string | null;
  updatedByUserId: number | null;
  /** Task #1923 — editor's display name / username, joined from
   *  `app_users` so the super-admin card can show "Last edited by
   *  Jane Doe" instead of "Last edited by user #42". Both are null
   *  when the editor row was deleted (FK is ON DELETE SET NULL) or
   *  when the singleton was never written. */
  updatedByDisplayName: string | null;
  updatedByUsername: string | null;
  /** Task #1916 — metadata about the most recent successful "Send test
   *  alert" delivery, surfaced next to the button so admins can see at
   *  a glance whether a fresh test is needed. NULL across all three
   *  fields means no test has ever been recorded on the singleton row. */
  lastTestSentAt: string | null;
  lastTestSentByUserId: number | null;
  lastTestSentByDisplayName: string | null;
  lastTestSentByUsername: string | null;
  lastTestRecipientCount: number | null;
}

interface CacheEntry {
  expiresAt: number;
  value: ResolvedOpsAlertConfig;
}

let cache: CacheEntry | null = null;

/** Test helper — clears the in-process cache so the next read hits the DB. */
export function _resetOpsAlertSettingsCacheForTest(): void {
  cache = null;
}

function parseEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Task #2081 — parse a boolean env var with the same lenient semantics
 * the rest of the codebase uses for ops toggles. Truthy values:
 * `1`, `true`, `yes`, `on` (case-insensitive). Falsy values: `0`,
 * `false`, `no`, `off`. Anything else (including unset / blank) maps
 * to `null` so the resolver can fall through to the hardcoded default
 * instead of silently picking one side.
 */
function parseEnvBool(name: string): boolean | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return null;
}

/** Like parseEnvInt but additionally caps at `max`. Used for the
 *  manual-entry rate threshold percent (must be 1–100). */
function parseEnvIntCapped(name: string, max: number): number | null {
  const v = parseEnvInt(name);
  if (v === null) return null;
  return v <= max ? v : null;
}

interface SingletonRow {
  threshold: number | null;
  windowHours: number | null;
  manualEntryRateThresholdPct: number | null;
  manualEntryMinSample: number | null;
  manualEntryConsecutiveZero: number | null;
  manualEntryCooldownHours: number | null;
  // Task #2081 — three additional manual-entry tunables editable from
  // the same Ops Alert card. Same NULL-means-inherit convention as
  // the four columns above.
  manualEntryLookbackHours: number | null;
  manualEntryDryRun: boolean | null;
  manualEntryRecipientLookupLimit: number | null;
  /** Task #1910 — DB-stored recipient override (null = inherit from env). */
  notifyExhaustionRecipients: string[] | null;
  updatedAt: string | null;
  updatedByUserId: number | null;
  // Task #1923 — joined from `app_users` so the resolved config can
  // expose the editor's friendly name to the UI without a second
  // round-trip. Both null when the FK is null or the user row was
  // deleted (the FK is ON DELETE SET NULL).
  updatedByDisplayName: string | null;
  updatedByUsername: string | null;
  // Task #1916 — last successful "Send test alert" delivery metadata.
  // Joined with `app_users` (a separate alias from the editor join
  // above, since the test sender and the last editor can be different
  // users) so the resolver can return both names in one query.
  lastTestSentAt: string | null;
  lastTestSentByUserId: number | null;
  lastTestSentByDisplayName: string | null;
  lastTestSentByUsername: string | null;
  lastTestRecipientCount: number | null;
}

const EMPTY_SINGLETON_ROW: SingletonRow = {
  threshold: null,
  windowHours: null,
  manualEntryRateThresholdPct: null,
  manualEntryMinSample: null,
  manualEntryConsecutiveZero: null,
  manualEntryCooldownHours: null,
  manualEntryLookbackHours: null,
  manualEntryDryRun: null,
  manualEntryRecipientLookupLimit: null,
  notifyExhaustionRecipients: null,
  updatedAt: null,
  updatedByUserId: null,
  updatedByDisplayName: null,
  updatedByUsername: null,
  lastTestSentAt: null,
  lastTestSentByUserId: null,
  lastTestSentByDisplayName: null,
  lastTestSentByUsername: null,
  lastTestRecipientCount: null,
};

const RECIPIENTS_ENV_VAR = "OPS_ALERT_EMAILS";

/**
 * Parse the comma-separated `OPS_ALERT_EMAILS` env var the same way
 * the cron used to (Task #1910). Pulled out as a helper so the resolver
 * and any future caller never disagree on trim/whitespace rules.
 */
function parseRecipientsEnv(): string[] {
  const raw = process.env[RECIPIENTS_ENV_VAR];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the effective ops-alert recipient list (Task #1910).
 *
 * DB override → env var, with one twist: an explicitly empty
 * DB-stored array still falls back to env. The task spec calls this
 * out — the floor is the env recipient list so an admin can never
 * accidentally silence the breach email by clearing the override.
 * The `source` field still distinguishes "non-empty override" vs
 * "inheriting from env", so the UI can show the right badge / explain
 * why an empty save didn't take effect.
 */
function resolveRecipients(dbList: string[] | null): ResolvedOpsAlertRecipients {
  const envList = parseRecipientsEnv();
  if (dbList !== null && dbList.length > 0) {
    return { effective: dbList, source: "org_override", dbList, envList, envVar: RECIPIENTS_ENV_VAR };
  }
  return { effective: envList, source: "env", dbList, envList, envVar: RECIPIENTS_ENV_VAR };
}

async function loadSingletonRow(): Promise<SingletonRow> {
  try {
    // Task #1923 — left-join `app_users` so the editor's display name +
    // username come back in the same query that loads the singleton.
    // Mirrors what `listOpsAlertSettingsHistory` already does for the
    // audit list, so the "Last edited" line on the card and the
    // "Recent changes" rows below it stay visually consistent.
    // Two aliased joins on `app_users`: one for the row's editor (Task
    // #1923) and a separate one for the user who last fired a test
    // (Task #1916). Without separate aliases, drizzle would collapse
    // them to one join and we'd only ever see the editor's name (or
    // worse, mismatch the names when the two are different users).
    const editorUsers = aliasedTable(appUsersTable, "ops_editor_users");
    const lastTestUsers = aliasedTable(appUsersTable, "ops_last_test_users");
    const [row] = await db
      .select({
        threshold: opsAlertSettingsTable.notifyExhaustionThreshold,
        windowHours: opsAlertSettingsTable.notifyExhaustionWindowHours,
        manualEntryRateThresholdPct: opsAlertSettingsTable.manualEntryRateThresholdPct,
        manualEntryMinSample: opsAlertSettingsTable.manualEntryMinSample,
        manualEntryConsecutiveZero: opsAlertSettingsTable.manualEntryConsecutiveZero,
        manualEntryCooldownHours: opsAlertSettingsTable.manualEntryCooldownHours,
        // Task #2081 — three additional manual-entry tunables. Same
        // explicit-projection rule as the recipient-list comment below.
        manualEntryLookbackHours: opsAlertSettingsTable.manualEntryLookbackHours,
        manualEntryDryRun: opsAlertSettingsTable.manualEntryDryRun,
        manualEntryRecipientLookupLimit: opsAlertSettingsTable.manualEntryRecipientLookupLimit,
        // Task #1910 — must be projected explicitly: previously the
        // call used `.select()` (all columns) so this field was implicit.
        // Forgetting to list it here silently disables DB recipient
        // overrides because `resolveRecipients` then sees `undefined`.
        notifyExhaustionRecipients: opsAlertSettingsTable.notifyExhaustionRecipients,
        updatedAt: opsAlertSettingsTable.updatedAt,
        updatedByUserId: opsAlertSettingsTable.updatedByUserId,
        // Task #1923 — editor name from the editor-aliased join.
        editorDisplayName: editorUsers.displayName,
        editorUsername: editorUsers.username,
        // Task #1916 — last-test fields + sender name from the
        // separately-aliased last-test join.
        lastTestSentAt: opsAlertSettingsTable.lastTestSentAt,
        lastTestSentByUserId: opsAlertSettingsTable.lastTestSentByUserId,
        lastTestRecipientCount: opsAlertSettingsTable.lastTestRecipientCount,
        lastTestEditorDisplayName: lastTestUsers.displayName,
        lastTestEditorUsername: lastTestUsers.username,
      })
      .from(opsAlertSettingsTable)
      .leftJoin(editorUsers, eq(editorUsers.id, opsAlertSettingsTable.updatedByUserId))
      .leftJoin(lastTestUsers, eq(lastTestUsers.id, opsAlertSettingsTable.lastTestSentByUserId))
      .where(eq(opsAlertSettingsTable.id, SINGLETON_ID))
      .limit(1);
    if (!row) {
      return { ...EMPTY_SINGLETON_ROW };
    }
    return {
      threshold: row.threshold,
      windowHours: row.windowHours,
      manualEntryRateThresholdPct: row.manualEntryRateThresholdPct,
      manualEntryMinSample: row.manualEntryMinSample,
      manualEntryConsecutiveZero: row.manualEntryConsecutiveZero,
      manualEntryCooldownHours: row.manualEntryCooldownHours,
      manualEntryLookbackHours: row.manualEntryLookbackHours,
      manualEntryDryRun: row.manualEntryDryRun,
      manualEntryRecipientLookupLimit: row.manualEntryRecipientLookupLimit,
      notifyExhaustionRecipients: row.notifyExhaustionRecipients ?? null,
      updatedAt: row.updatedAt.toISOString(),
      updatedByUserId: row.updatedByUserId,
      updatedByDisplayName: row.editorDisplayName ?? null,
      updatedByUsername: row.editorUsername ?? null,
      lastTestSentAt: row.lastTestSentAt ? row.lastTestSentAt.toISOString() : null,
      lastTestSentByUserId: row.lastTestSentByUserId,
      lastTestSentByDisplayName: row.lastTestEditorDisplayName ?? null,
      lastTestSentByUsername: row.lastTestEditorUsername ?? null,
      lastTestRecipientCount: row.lastTestRecipientCount,
    };
  } catch (err) {
    // The migration may not have run yet on a brand-new env (cron should
    // still alert with env defaults). Log once and degrade gracefully —
    // the env-var path was the only behaviour before this task anyway.
    logger.warn(
      { err },
      "[ops-alert-settings] Failed to read ops_alert_settings; falling back to env vars",
    );
    return { ...EMPTY_SINGLETON_ROW };
  }
}

/** Pick the effective value + source label for one tunable, following
 *  the standard DB → env → default precedence. Pulled into a helper so
 *  every column reads the same way. */
function pickValue(
  dbValue: number | null,
  envValue: number | null,
  defaultValue: number,
): { value: number; source: OpsAlertSettingSource } {
  if (dbValue !== null) return { value: dbValue, source: "db" };
  if (envValue !== null) return { value: envValue, source: "env" };
  return { value: defaultValue, source: "default" };
}

function buildResolved(row: SingletonRow): ResolvedOpsAlertConfig {
  const envThreshold = parseEnvInt("OPS_NOTIFY_EXHAUSTION_THRESHOLD");
  const envWindowHours = parseEnvInt("OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS");

  const t = pickValue(row.threshold, envThreshold, DEFAULT_OPS_NOTIFY_EXHAUSTION_THRESHOLD);
  const w = pickValue(row.windowHours, envWindowHours, DEFAULT_OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS);

  // Manual-entry tunables (Task #1664). Same DB → env → default
  // precedence per column. The rate threshold env reader caps at 100
  // to match the singleton's CHECK constraint — a stale env var of
  // 1000% would otherwise silently disable the rate-breach trigger.
  const envMeRate = parseEnvIntCapped("OPS_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT", 100);
  const envMeMinSample = parseEnvInt("OPS_MANUAL_ENTRY_ALERT_MIN_SAMPLE");
  const envMeConsecZero = parseEnvInt("OPS_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO");
  const envMeCooldown = parseEnvInt("OPS_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS");
  // Task #2081 — env vars for the three additional manual-entry tunables.
  const envMeLookback = parseEnvInt("OPS_MANUAL_ENTRY_ALERT_LOOKBACK_HOURS");
  const envMeDryRun = parseEnvBool("OPS_MANUAL_ENTRY_ALERT_DRY_RUN");
  const envMeRecipientLookupLimit = parseEnvInt("OPS_MANUAL_ENTRY_ALERT_RECIPIENT_LOOKUP_LIMIT");

  const meRate = pickValue(row.manualEntryRateThresholdPct, envMeRate, DEFAULT_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT);
  const meMinSample = pickValue(row.manualEntryMinSample, envMeMinSample, DEFAULT_MANUAL_ENTRY_ALERT_MIN_SAMPLE);
  const meConsecZero = pickValue(row.manualEntryConsecutiveZero, envMeConsecZero, DEFAULT_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO);
  const meCooldown = pickValue(row.manualEntryCooldownHours, envMeCooldown, DEFAULT_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS);
  const meLookback = pickValue(row.manualEntryLookbackHours, envMeLookback, DEFAULT_MANUAL_ENTRY_ALERT_LOOKBACK_HOURS);
  const meRecipientLookupLimit = pickValue(
    row.manualEntryRecipientLookupLimit,
    envMeRecipientLookupLimit,
    DEFAULT_MANUAL_ENTRY_ALERT_RECIPIENT_LOOKUP_LIMIT,
  );
  // Dry-run is a boolean — `pickValue` is integer-only, so resolve
  // the same DB → env → default precedence inline.
  const meDryRunSource: OpsAlertSettingSource =
    row.manualEntryDryRun !== null ? "db"
    : envMeDryRun !== null ? "env"
    : "default";
  const meDryRunValue: boolean =
    row.manualEntryDryRun !== null ? row.manualEntryDryRun
    : envMeDryRun !== null ? envMeDryRun
    : DEFAULT_MANUAL_ENTRY_ALERT_DRY_RUN;

  return {
    threshold: t.value,
    windowHours: w.value,
    source: { threshold: t.source, windowHours: w.source },
    dbThreshold: row.threshold,
    dbWindowHours: row.windowHours,
    envThreshold,
    envWindowHours,
    defaultThreshold: DEFAULT_OPS_NOTIFY_EXHAUSTION_THRESHOLD,
    defaultWindowHours: DEFAULT_OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS,
    manualEntry: {
      rateThresholdPct: meRate.value,
      minSample: meMinSample.value,
      consecutiveZero: meConsecZero.value,
      cooldownHours: meCooldown.value,
      lookbackHours: meLookback.value,
      dryRun: meDryRunValue,
      recipientLookupLimit: meRecipientLookupLimit.value,
      source: {
        rateThresholdPct: meRate.source,
        minSample: meMinSample.source,
        consecutiveZero: meConsecZero.source,
        cooldownHours: meCooldown.source,
        lookbackHours: meLookback.source,
        dryRun: meDryRunSource,
        recipientLookupLimit: meRecipientLookupLimit.source,
      },
      dbRateThresholdPct: row.manualEntryRateThresholdPct,
      dbMinSample: row.manualEntryMinSample,
      dbConsecutiveZero: row.manualEntryConsecutiveZero,
      dbCooldownHours: row.manualEntryCooldownHours,
      dbLookbackHours: row.manualEntryLookbackHours,
      dbDryRun: row.manualEntryDryRun,
      dbRecipientLookupLimit: row.manualEntryRecipientLookupLimit,
      envRateThresholdPct: envMeRate,
      envMinSample: envMeMinSample,
      envConsecutiveZero: envMeConsecZero,
      envCooldownHours: envMeCooldown,
      envLookbackHours: envMeLookback,
      envDryRun: envMeDryRun,
      envRecipientLookupLimit: envMeRecipientLookupLimit,
      defaultRateThresholdPct: DEFAULT_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT,
      defaultMinSample: DEFAULT_MANUAL_ENTRY_ALERT_MIN_SAMPLE,
      defaultConsecutiveZero: DEFAULT_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO,
      defaultCooldownHours: DEFAULT_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS,
      defaultLookbackHours: DEFAULT_MANUAL_ENTRY_ALERT_LOOKBACK_HOURS,
      defaultDryRun: DEFAULT_MANUAL_ENTRY_ALERT_DRY_RUN,
      defaultRecipientLookupLimit: DEFAULT_MANUAL_ENTRY_ALERT_RECIPIENT_LOOKUP_LIMIT,
    },
    recipients: resolveRecipients(row.notifyExhaustionRecipients),
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
    updatedByDisplayName: row.updatedByDisplayName,
    updatedByUsername: row.updatedByUsername,
    lastTestSentAt: row.lastTestSentAt,
    lastTestSentByUserId: row.lastTestSentByUserId,
    lastTestSentByDisplayName: row.lastTestSentByDisplayName,
    lastTestSentByUsername: row.lastTestSentByUsername,
    lastTestRecipientCount: row.lastTestRecipientCount,
  };
}

/**
 * Resolve the effective threshold + window the cron should use right
 * now. DB row → env var → hardcoded default, per tunable independently.
 */
export async function resolveOpsAlertConfig(): Promise<ResolvedOpsAlertConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const row = await loadSingletonRow();
  const value = buildResolved(row);
  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

export interface UpdateOpsAlertSettingsInput {
  /** New threshold (positive integer), or `null` to clear and fall back to env / default. */
  notifyExhaustionThreshold?: number | null;
  /** New lookback window in hours (positive integer), or `null` to clear. */
  notifyExhaustionWindowHours?: number | null;
  /** Task #1664 — new manual-entry rate threshold percent (1–100), or `null` to clear. */
  manualEntryRateThresholdPct?: number | null;
  /** Task #1664 — new manual-entry min sample (positive integer), or `null` to clear. */
  manualEntryMinSample?: number | null;
  /** Task #1664 — new consecutive-zero trigger count (positive integer), or `null` to clear. */
  manualEntryConsecutiveZero?: number | null;
  /** Task #1664 — new cooldown in hours (positive integer), or `null` to clear. */
  manualEntryCooldownHours?: number | null;
  /** Task #2081 — new manual-entry lookback hours (positive integer), or `null` to clear. */
  manualEntryLookbackHours?: number | null;
  /** Task #2081 — new manual-entry dry-run flag (boolean), or `null` to clear. */
  manualEntryDryRun?: boolean | null;
  /** Task #2081 — new manual-entry recipient lookup limit (positive integer), or `null` to clear. */
  manualEntryRecipientLookupLimit?: number | null;
  /**
   * Task #1910 — DB-backed override for the retry-exhaustion ops-alert
   * recipient list. Pass an array of email addresses to set the
   * override (de-duplicated, lowercased, stripped of whitespace), or
   * `null` to clear it. An empty array is also accepted and stored
   * as-is — the resolver treats an explicit `[]` the same as `null`
   * (falls back to env), per task spec.
   */
  notifyExhaustionRecipients?: string[] | null;
  /** App user id for audit. */
  userId?: number | null;
}

export type UpdateOpsAlertSettingsErrorKind =
  | "invalid_threshold"
  | "invalid_window_hours"
  | "invalid_manual_entry_rate_threshold_pct"
  | "invalid_manual_entry_min_sample"
  | "invalid_manual_entry_consecutive_zero"
  | "invalid_manual_entry_cooldown_hours"
  // Task #2081 — three additional manual-entry tunables.
  | "invalid_manual_entry_lookback_hours"
  | "invalid_manual_entry_dry_run"
  | "invalid_manual_entry_recipient_lookup_limit"
  | "invalid_notify_exhaustion_recipients";

export type UpdateOpsAlertSettingsError = { kind: UpdateOpsAlertSettingsErrorKind };

/**
 * Validate + normalize a recipient list override (Task #1910).
 *
 * Returns the canonical form to persist (trimmed, lowercased,
 * de-duplicated, original order preserved) or a structured error if
 * any entry is not a syntactically valid email. The validation is
 * deliberately a basic `local@domain.tld` check — it matches what
 * the email send pipeline accepts and is enough to catch the obvious
 * typo case ("foo bar baz") that would otherwise just fail silently
 * at SMTP send time. We don't try to be smarter than that here.
 *
 * `null` and `[]` both pass validation; the resolver collapses an
 * empty array back to "inherit from env" at read time.
 */
function validateAndNormalizeRecipients(
  value: string[] | null | undefined,
): { ok: true; value: string[] | null } | { ok: false; error: UpdateOpsAlertSettingsError } {
  if (value === undefined) return { ok: true, value: null };
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return { ok: false, error: { kind: "invalid_notify_exhaustion_recipients" } };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  // Reasonable cap so a runaway client can't try to store ten
  // thousand "recipients" (the cron's CC line + email send latency
  // would explode and the audit row would become unwieldy). 50 is
  // far above any real-world ops-alert distribution list.
  if (value.length > 50) {
    return { ok: false, error: { kind: "invalid_notify_exhaustion_recipients" } };
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const raw of value) {
    if (typeof raw !== "string") {
      return { ok: false, error: { kind: "invalid_notify_exhaustion_recipients" } };
    }
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue; // silently drop blank entries (e.g. trailing comma in UI)
    if (!EMAIL_RE.test(trimmed)) {
      return { ok: false, error: { kind: "invalid_notify_exhaustion_recipients" } };
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

/** Validate one positive-integer override field (or `null` to clear). */
function validatePositiveInt(
  value: number | null | undefined,
  errorKind: UpdateOpsAlertSettingsErrorKind,
): { ok: true } | { ok: false; error: UpdateOpsAlertSettingsError } {
  if (value === undefined || value === null) return { ok: true };
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: { kind: errorKind } };
  }
  return { ok: true };
}

/**
 * Upsert the singleton settings row. Each field is partially editable:
 *   - Pass a positive integer to set an explicit override.
 *   - Pass `null` to clear that override (cron falls back to env/default).
 *   - Omit the field entirely to leave the existing stored value untouched.
 */
export async function updateOpsAlertSettings(
  input: UpdateOpsAlertSettingsInput,
): Promise<
  | { ok: true; config: ResolvedOpsAlertConfig }
  | { ok: false; error: UpdateOpsAlertSettingsError }
> {
  // Validate up-front so a bad payload is rejected with a structured
  // error instead of leaking a Postgres CHECK violation to the client.
  const validations: Array<{ value: number | null | undefined; kind: UpdateOpsAlertSettingsErrorKind }> = [
    { value: input.notifyExhaustionThreshold, kind: "invalid_threshold" },
    { value: input.notifyExhaustionWindowHours, kind: "invalid_window_hours" },
    { value: input.manualEntryMinSample, kind: "invalid_manual_entry_min_sample" },
    { value: input.manualEntryConsecutiveZero, kind: "invalid_manual_entry_consecutive_zero" },
    { value: input.manualEntryCooldownHours, kind: "invalid_manual_entry_cooldown_hours" },
    // Task #2081 — lookback hours + recipient lookup limit reuse the
    // standard positive-integer validator. Dry-run is boolean and is
    // validated separately below.
    { value: input.manualEntryLookbackHours, kind: "invalid_manual_entry_lookback_hours" },
    { value: input.manualEntryRecipientLookupLimit, kind: "invalid_manual_entry_recipient_lookup_limit" },
  ];
  for (const v of validations) {
    const r = validatePositiveInt(v.value, v.kind);
    if (!r.ok) return r;
  }
  // Rate threshold has the same positive-int rule plus an upper bound
  // of 100 (validated separately so the error label points at the
  // correct field).
  if (input.manualEntryRateThresholdPct !== undefined && input.manualEntryRateThresholdPct !== null) {
    const v = input.manualEntryRateThresholdPct;
    if (!Number.isInteger(v) || v <= 0 || v > 100) {
      return { ok: false, error: { kind: "invalid_manual_entry_rate_threshold_pct" } };
    }
  }
  // Task #2081 — dry-run is a boolean override (or `null` to clear).
  // Reject anything that isn't strictly `true` / `false` / `null` so a
  // typo'd `"true"` payload from a misbehaving client is rejected with
  // a structured error instead of silently coerced.
  if (
    input.manualEntryDryRun !== undefined &&
    input.manualEntryDryRun !== null &&
    typeof input.manualEntryDryRun !== "boolean"
  ) {
    return { ok: false, error: { kind: "invalid_manual_entry_dry_run" } };
  }
  // Task #1910 — validate + normalize recipients up-front, in case the
  // PATCH includes the field. We need both the validity decision and
  // the canonical (lowercased / de-duped) array to persist below.
  const hasRecipients = Object.prototype.hasOwnProperty.call(input, "notifyExhaustionRecipients");
  const recipientsResult = hasRecipients
    ? validateAndNormalizeRecipients(input.notifyExhaustionRecipients)
    : ({ ok: true, value: null } as const);
  if (!recipientsResult.ok) return recipientsResult;
  // Task #1910 — collapse an empty array to null at the persistence
  // layer. The resolver already treats both as "inherit from env", but
  // storing NULL keeps the DB state unambiguous (no row stores `[]`),
  // makes the audit row read as a real `prev → null` transition when
  // an admin clears the override via empty save, and keeps the super
  // admin "Reset to inherit" enabled-disabled check (`dbList === null`)
  // accurate for the cleared case.
  const normalizedRecipients =
    recipientsResult.value !== null && recipientsResult.value.length === 0
      ? null
      : recipientsResult.value;

  const userId = typeof input.userId === "number" && Number.isFinite(input.userId)
    ? input.userId
    : null;
  const now = new Date();

  const hasThreshold = Object.prototype.hasOwnProperty.call(input, "notifyExhaustionThreshold");
  const hasWindow = Object.prototype.hasOwnProperty.call(input, "notifyExhaustionWindowHours");
  const hasMeRate = Object.prototype.hasOwnProperty.call(input, "manualEntryRateThresholdPct");
  const hasMeMinSample = Object.prototype.hasOwnProperty.call(input, "manualEntryMinSample");
  const hasMeConsecZero = Object.prototype.hasOwnProperty.call(input, "manualEntryConsecutiveZero");
  const hasMeCooldown = Object.prototype.hasOwnProperty.call(input, "manualEntryCooldownHours");
  // Task #2081 — three additional manual-entry tunables.
  const hasMeLookback = Object.prototype.hasOwnProperty.call(input, "manualEntryLookbackHours");
  const hasMeDryRun = Object.prototype.hasOwnProperty.call(input, "manualEntryDryRun");
  const hasMeRecipientLookupLimit = Object.prototype.hasOwnProperty.call(input, "manualEntryRecipientLookupLimit");

  // Build the SET clause from only the keys the caller actually
  // provided so a PATCH that only edits the threshold doesn't wipe out
  // the previously-stored window override.
  const setClause: Record<string, unknown> = {
    updatedByUserId: userId,
    updatedAt: now,
  };
  if (hasThreshold) setClause.notifyExhaustionThreshold = input.notifyExhaustionThreshold ?? null;
  if (hasWindow) setClause.notifyExhaustionWindowHours = input.notifyExhaustionWindowHours ?? null;
  if (hasMeRate) setClause.manualEntryRateThresholdPct = input.manualEntryRateThresholdPct ?? null;
  if (hasMeMinSample) setClause.manualEntryMinSample = input.manualEntryMinSample ?? null;
  if (hasMeConsecZero) setClause.manualEntryConsecutiveZero = input.manualEntryConsecutiveZero ?? null;
  if (hasMeCooldown) setClause.manualEntryCooldownHours = input.manualEntryCooldownHours ?? null;
  if (hasMeLookback) setClause.manualEntryLookbackHours = input.manualEntryLookbackHours ?? null;
  if (hasMeDryRun) setClause.manualEntryDryRun = input.manualEntryDryRun ?? null;
  if (hasMeRecipientLookupLimit) setClause.manualEntryRecipientLookupLimit = input.manualEntryRecipientLookupLimit ?? null;
  if (hasRecipients) setClause.notifyExhaustionRecipients = normalizedRecipients;

  // Wrap the previous-row read, the upsert, and the audit insert in one
  // transaction so we never end up with a settings change that lacks a
  // history row (or vice versa) if the connection blips mid-write.
  // Task #1546.
  await db.transaction(async (tx) => {
    const [prevRow] = await tx
      .select({
        threshold: opsAlertSettingsTable.notifyExhaustionThreshold,
        windowHours: opsAlertSettingsTable.notifyExhaustionWindowHours,
        meRate: opsAlertSettingsTable.manualEntryRateThresholdPct,
        meMinSample: opsAlertSettingsTable.manualEntryMinSample,
        meConsecZero: opsAlertSettingsTable.manualEntryConsecutiveZero,
        meCooldown: opsAlertSettingsTable.manualEntryCooldownHours,
        // Task #2081
        meLookback: opsAlertSettingsTable.manualEntryLookbackHours,
        meDryRun: opsAlertSettingsTable.manualEntryDryRun,
        meRecipientLookupLimit: opsAlertSettingsTable.manualEntryRecipientLookupLimit,
        recipients: opsAlertSettingsTable.notifyExhaustionRecipients,
      })
      .from(opsAlertSettingsTable)
      .where(eq(opsAlertSettingsTable.id, SINGLETON_ID))
      .limit(1);
    const prevThreshold = prevRow?.threshold ?? null;
    const prevWindowHours = prevRow?.windowHours ?? null;
    const prevMeRate = prevRow?.meRate ?? null;
    const prevMeMinSample = prevRow?.meMinSample ?? null;
    const prevMeConsecZero = prevRow?.meConsecZero ?? null;
    const prevMeCooldown = prevRow?.meCooldown ?? null;
    const prevMeLookback = prevRow?.meLookback ?? null;
    const prevMeDryRun = prevRow?.meDryRun ?? null;
    const prevMeRecipientLookupLimit = prevRow?.meRecipientLookupLimit ?? null;
    const prevRecipients = prevRow?.recipients ?? null;

    await tx
      .insert(opsAlertSettingsTable)
      .values({
        id: SINGLETON_ID,
        notifyExhaustionThreshold: hasThreshold ? (input.notifyExhaustionThreshold ?? null) : null,
        notifyExhaustionWindowHours: hasWindow ? (input.notifyExhaustionWindowHours ?? null) : null,
        manualEntryRateThresholdPct: hasMeRate ? (input.manualEntryRateThresholdPct ?? null) : null,
        manualEntryMinSample: hasMeMinSample ? (input.manualEntryMinSample ?? null) : null,
        manualEntryConsecutiveZero: hasMeConsecZero ? (input.manualEntryConsecutiveZero ?? null) : null,
        manualEntryCooldownHours: hasMeCooldown ? (input.manualEntryCooldownHours ?? null) : null,
        manualEntryLookbackHours: hasMeLookback ? (input.manualEntryLookbackHours ?? null) : null,
        manualEntryDryRun: hasMeDryRun ? (input.manualEntryDryRun ?? null) : null,
        manualEntryRecipientLookupLimit: hasMeRecipientLookupLimit ? (input.manualEntryRecipientLookupLimit ?? null) : null,
        notifyExhaustionRecipients: hasRecipients ? normalizedRecipients : null,
        updatedByUserId: userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: opsAlertSettingsTable.id,
        set: setClause,
      });

    // For fields the PATCH didn't touch, the "new" value is whatever
    // was already stored — we mirror prev so the audit row reflects
    // the actual post-update state, not a misleading NULL.
    const newThreshold = hasThreshold ? (input.notifyExhaustionThreshold ?? null) : prevThreshold;
    const newWindowHours = hasWindow ? (input.notifyExhaustionWindowHours ?? null) : prevWindowHours;
    const newMeRate = hasMeRate ? (input.manualEntryRateThresholdPct ?? null) : prevMeRate;
    const newMeMinSample = hasMeMinSample ? (input.manualEntryMinSample ?? null) : prevMeMinSample;
    const newMeConsecZero = hasMeConsecZero ? (input.manualEntryConsecutiveZero ?? null) : prevMeConsecZero;
    const newMeCooldown = hasMeCooldown ? (input.manualEntryCooldownHours ?? null) : prevMeCooldown;
    const newMeLookback = hasMeLookback ? (input.manualEntryLookbackHours ?? null) : prevMeLookback;
    const newMeDryRun = hasMeDryRun ? (input.manualEntryDryRun ?? null) : prevMeDryRun;
    const newMeRecipientLookupLimit = hasMeRecipientLookupLimit
      ? (input.manualEntryRecipientLookupLimit ?? null)
      : prevMeRecipientLookupLimit;
    const newRecipients = hasRecipients ? normalizedRecipients : prevRecipients;

    await tx.insert(opsAlertSettingsHistoryTable).values({
      changedAt: now,
      changedByUserId: userId,
      prevThreshold,
      newThreshold,
      prevWindowHours,
      newWindowHours,
      prevManualEntryRateThresholdPct: prevMeRate,
      newManualEntryRateThresholdPct: newMeRate,
      prevManualEntryMinSample: prevMeMinSample,
      newManualEntryMinSample: newMeMinSample,
      prevManualEntryConsecutiveZero: prevMeConsecZero,
      newManualEntryConsecutiveZero: newMeConsecZero,
      prevManualEntryCooldownHours: prevMeCooldown,
      newManualEntryCooldownHours: newMeCooldown,
      // Task #2081 — three additional manual-entry tunables.
      prevManualEntryLookbackHours: prevMeLookback,
      newManualEntryLookbackHours: newMeLookback,
      prevManualEntryDryRun: prevMeDryRun,
      newManualEntryDryRun: newMeDryRun,
      prevManualEntryRecipientLookupLimit: prevMeRecipientLookupLimit,
      newManualEntryRecipientLookupLimit: newMeRecipientLookupLimit,
      prevNotifyExhaustionRecipients: prevRecipients,
      newNotifyExhaustionRecipients: newRecipients,
    });
  });

  // Bust the cache so the very next read sees the new values
  // (the read-after-write the admin UI does as part of save).
  cache = null;

  const config = await resolveOpsAlertConfig();
  return { ok: true, config };
}

/** A single audit row for the super-admin "Recent changes" list. */
export interface OpsAlertSettingsHistoryEntry {
  id: number;
  changedAt: string;
  changedByUserId: number | null;
  changedByDisplayName: string | null;
  changedByUsername: string | null;
  prevThreshold: number | null;
  newThreshold: number | null;
  prevWindowHours: number | null;
  newWindowHours: number | null;
  // Task #1664 — manual-entry alert health prev/new values per row.
  prevManualEntryRateThresholdPct: number | null;
  newManualEntryRateThresholdPct: number | null;
  prevManualEntryMinSample: number | null;
  newManualEntryMinSample: number | null;
  prevManualEntryConsecutiveZero: number | null;
  newManualEntryConsecutiveZero: number | null;
  prevManualEntryCooldownHours: number | null;
  newManualEntryCooldownHours: number | null;
  // Task #2081 — three additional manual-entry tunables prev/new
  // audit values. Same NULL-on-either-side convention as the four
  // pairs above.
  prevManualEntryLookbackHours: number | null;
  newManualEntryLookbackHours: number | null;
  prevManualEntryDryRun: boolean | null;
  newManualEntryDryRun: boolean | null;
  prevManualEntryRecipientLookupLimit: number | null;
  newManualEntryRecipientLookupLimit: number | null;
  // Task #1910 — recipient list override prev/new audit values. NULL
  // on either side means "the cron was inheriting from
  // OPS_ALERT_EMAILS at that point in time" (the resolver also
  // collapses an empty array back to env, but that distinction is
  // preserved here so the audit row can still show what was stored).
  prevNotifyExhaustionRecipients: string[] | null;
  newNotifyExhaustionRecipients: string[] | null;
}

/** Hard cap on the per-page row count returned by
 *  {@link listOpsAlertSettingsHistory} / the GET history endpoint.
 *  The dashboard "Recent changes" card asks for 10, the "Show all"
 *  paginated browser (Task #1924) asks for 25 by default — clamping
 *  at 100 leaves comfortable headroom for a one-off "give me
 *  everything for the postmortem" request without letting a misuse
 *  ship the full table over the wire. */
export const OPS_ALERT_HISTORY_MAX_LIMIT = 100;

/** Filter / pagination knobs for the audit history endpoint
 *  (Task #1924). All fields are optional — omit any of them and the
 *  query falls back to "no filter on this column". */
export interface ListOpsAlertSettingsHistoryOptions {
  /** Page size. Clamped to 1..{@link OPS_ALERT_HISTORY_MAX_LIMIT}. */
  limit?: number;
  /** Skip the first N rows (after applying filters). Negative values
   *  are clamped to 0. */
  offset?: number;
  /** Inclusive lower bound on `changed_at`. Rows with an earlier
   *  timestamp are excluded. */
  fromDate?: Date | null;
  /** Inclusive upper bound on `changed_at`. Rows with a later
   *  timestamp are excluded. */
  toDate?: Date | null;
  /** Restrict to changes made by this app user id. Pass `null` to
   *  match the system / unattributed rows where `changed_by_user_id`
   *  is NULL. Omit to skip the filter. */
  editorUserId?: number | null;
}

interface ResolvedHistoryFilters {
  whereClause: SQL | undefined;
  hasEditorFilter: boolean;
}

/** Build the shared WHERE clause used by both the list query and the
 *  count query so they always agree on which rows are in scope. */
function buildHistoryWhere(opts: ListOpsAlertSettingsHistoryOptions): ResolvedHistoryFilters {
  const conds: SQL[] = [];
  if (opts.fromDate instanceof Date && !Number.isNaN(opts.fromDate.getTime())) {
    conds.push(gte(opsAlertSettingsHistoryTable.changedAt, opts.fromDate));
  }
  if (opts.toDate instanceof Date && !Number.isNaN(opts.toDate.getTime())) {
    conds.push(lte(opsAlertSettingsHistoryTable.changedAt, opts.toDate));
  }
  const hasEditorFilter = Object.prototype.hasOwnProperty.call(opts, "editorUserId");
  if (hasEditorFilter) {
    if (opts.editorUserId === null) {
      conds.push(sql`${opsAlertSettingsHistoryTable.changedByUserId} is null`);
    } else if (typeof opts.editorUserId === "number" && Number.isInteger(opts.editorUserId)) {
      conds.push(eq(opsAlertSettingsHistoryTable.changedByUserId, opts.editorUserId));
    }
  }
  return {
    whereClause: conds.length === 0 ? undefined : and(...conds),
    hasEditorFilter,
  };
}

/** Total number of audit rows matching the supplied filters. Used by
 *  the "Show all" paginated browser to render the "X of Y" footer
 *  and disable the Next button on the last page. */
export async function countOpsAlertSettingsHistory(
  opts: Pick<ListOpsAlertSettingsHistoryOptions, "fromDate" | "toDate" | "editorUserId"> = {},
): Promise<number> {
  const { whereClause } = buildHistoryWhere(opts);
  const query = db
    .select({ count: sql<number>`count(*)::int` })
    .from(opsAlertSettingsHistoryTable);
  const rows = whereClause ? await query.where(whereClause) : await query;
  return rows[0]?.count ?? 0;
}

/**
 * Return audit entries (newest first) for the super-admin dashboard's
 * "Recent changes" list and the "Show all" paginated browser
 * (Task #1924).
 *
 * Defaults to the first 10 newest rows so the original dashboard
 * caller keeps its old shape. Pass `offset` + smaller/larger `limit`
 * for paging, and the date / editor filters to scope the result set.
 *
 * Backward-compat: callers may still pass a bare number for the
 * limit (matching the pre-Task #1924 signature).
 */
export async function listOpsAlertSettingsHistory(
  optsOrLimit: ListOpsAlertSettingsHistoryOptions | number = {},
): Promise<OpsAlertSettingsHistoryEntry[]> {
  const opts: ListOpsAlertSettingsHistoryOptions =
    typeof optsOrLimit === "number" ? { limit: optsOrLimit } : optsOrLimit;
  const limit = Math.max(
    1,
    Math.min(
      typeof opts.limit === "number" && Number.isFinite(opts.limit) ? Math.floor(opts.limit) : 10,
      OPS_ALERT_HISTORY_MAX_LIMIT,
    ),
  );
  const offset = Math.max(
    0,
    typeof opts.offset === "number" && Number.isFinite(opts.offset) ? Math.floor(opts.offset) : 0,
  );
  const { whereClause } = buildHistoryWhere(opts);

  const baseQuery = db
    .select({
      id: opsAlertSettingsHistoryTable.id,
      changedAt: opsAlertSettingsHistoryTable.changedAt,
      changedByUserId: opsAlertSettingsHistoryTable.changedByUserId,
      prevThreshold: opsAlertSettingsHistoryTable.prevThreshold,
      newThreshold: opsAlertSettingsHistoryTable.newThreshold,
      prevWindowHours: opsAlertSettingsHistoryTable.prevWindowHours,
      newWindowHours: opsAlertSettingsHistoryTable.newWindowHours,
      prevMeRate: opsAlertSettingsHistoryTable.prevManualEntryRateThresholdPct,
      newMeRate: opsAlertSettingsHistoryTable.newManualEntryRateThresholdPct,
      prevMeMinSample: opsAlertSettingsHistoryTable.prevManualEntryMinSample,
      newMeMinSample: opsAlertSettingsHistoryTable.newManualEntryMinSample,
      prevMeConsecZero: opsAlertSettingsHistoryTable.prevManualEntryConsecutiveZero,
      newMeConsecZero: opsAlertSettingsHistoryTable.newManualEntryConsecutiveZero,
      prevMeCooldown: opsAlertSettingsHistoryTable.prevManualEntryCooldownHours,
      newMeCooldown: opsAlertSettingsHistoryTable.newManualEntryCooldownHours,
      // Task #2081 — three additional manual-entry tunables.
      prevMeLookback: opsAlertSettingsHistoryTable.prevManualEntryLookbackHours,
      newMeLookback: opsAlertSettingsHistoryTable.newManualEntryLookbackHours,
      prevMeDryRun: opsAlertSettingsHistoryTable.prevManualEntryDryRun,
      newMeDryRun: opsAlertSettingsHistoryTable.newManualEntryDryRun,
      prevMeRecipientLookupLimit: opsAlertSettingsHistoryTable.prevManualEntryRecipientLookupLimit,
      newMeRecipientLookupLimit: opsAlertSettingsHistoryTable.newManualEntryRecipientLookupLimit,
      prevRecipients: opsAlertSettingsHistoryTable.prevNotifyExhaustionRecipients,
      newRecipients: opsAlertSettingsHistoryTable.newNotifyExhaustionRecipients,
      displayName: appUsersTable.displayName,
      username: appUsersTable.username,
    })
    .from(opsAlertSettingsHistoryTable)
    .leftJoin(appUsersTable, eq(appUsersTable.id, opsAlertSettingsHistoryTable.changedByUserId));

  const filtered = whereClause ? baseQuery.where(whereClause) : baseQuery;
  const rows = await filtered
    .orderBy(desc(opsAlertSettingsHistoryTable.changedAt), desc(opsAlertSettingsHistoryTable.id))
    .limit(limit)
    .offset(offset);

  return rows.map((r) => ({
    id: r.id,
    changedAt: r.changedAt.toISOString(),
    changedByUserId: r.changedByUserId,
    changedByDisplayName: r.displayName ?? null,
    changedByUsername: r.username ?? null,
    prevThreshold: r.prevThreshold,
    newThreshold: r.newThreshold,
    prevWindowHours: r.prevWindowHours,
    newWindowHours: r.newWindowHours,
    prevManualEntryRateThresholdPct: r.prevMeRate,
    newManualEntryRateThresholdPct: r.newMeRate,
    prevManualEntryMinSample: r.prevMeMinSample,
    newManualEntryMinSample: r.newMeMinSample,
    prevManualEntryConsecutiveZero: r.prevMeConsecZero,
    newManualEntryConsecutiveZero: r.newMeConsecZero,
    prevManualEntryCooldownHours: r.prevMeCooldown,
    newManualEntryCooldownHours: r.newMeCooldown,
    prevManualEntryLookbackHours: r.prevMeLookback,
    newManualEntryLookbackHours: r.newMeLookback,
    prevManualEntryDryRun: r.prevMeDryRun,
    newManualEntryDryRun: r.newMeDryRun,
    prevManualEntryRecipientLookupLimit: r.prevMeRecipientLookupLimit,
    newManualEntryRecipientLookupLimit: r.newMeRecipientLookupLimit,
    prevNotifyExhaustionRecipients: r.prevRecipients ?? null,
    newNotifyExhaustionRecipients: r.newRecipients ?? null,
  }));
}

/**
 * Default retention window for `ops_alert_settings_history` rows.
 *
 * Task #1925 — the audit log appends one row per PATCH and was never
 * pruned. In normal operation that's a handful of rows a year, but a
 * misbehaving script (or a noisy incident with frequent toggles) could
 * grow the table without bound. Audit rows have no operational value
 * once they're months old (the super-admin UI only renders the last
 * handful), so a yearly retention window keeps recent forensic value
 * intact without letting the table balloon. Tunable via the
 * `OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS` env var.
 */
export const DEFAULT_OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS = 365;

function resolveHistoryRetentionDays(): number {
  const raw = process.env.OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS;
  if (!raw) return DEFAULT_OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn(
      { value: raw },
      "[ops-alert-settings] Invalid OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS; using default",
    );
    return DEFAULT_OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS;
  }
  return n;
}

/**
 * Delete `ops_alert_settings_history` rows whose `changedAt` is older
 * than the configured retention window. Returns the number of rows
 * deleted plus the cutoff used so callers (cron) can log a single
 * structured summary.
 *
 * Designed to be invoked by the daily cron (see `cron.ts`) — the
 * `changedAt` index makes the WHERE cheap even for a backlog, and the
 * delete runs in one statement rather than batching since the expected
 * row volume is low (one row per admin PATCH, capped further by this
 * very prune).
 *
 * @param retentionDays Optional override (must be > 0). When omitted,
 *   resolves from `OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS` env →
 *   `DEFAULT_OPS_ALERT_SETTINGS_HISTORY_RETENTION_DAYS`.
 */
export async function pruneOpsAlertSettingsHistory(
  retentionDays?: number,
): Promise<{ deleted: number; cutoff: string; retentionDays: number }> {
  const days = typeof retentionDays === "number" && Number.isFinite(retentionDays) && retentionDays > 0
    ? retentionDays
    : resolveHistoryRetentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(opsAlertSettingsHistoryTable)
    .where(lt(opsAlertSettingsHistoryTable.changedAt, cutoff))
    .returning({ id: opsAlertSettingsHistoryTable.id });
  if (deleted.length > 0) {
    logger.info(
      { deleted: deleted.length, cutoff: cutoff.toISOString(), retentionDays: days },
      "[ops-alert-settings] pruned old ops_alert_settings_history rows",
    );
  }
  return { deleted: deleted.length, cutoff: cutoff.toISOString(), retentionDays: days };
}

/**
 * Task #1916 — record a successful "Send test alert" delivery on the
 * singleton settings row so the super-admin Ops Alert card can show
 * "Last test sent <relative time> ago to N recipient(s)" beside the
 * button.
 *
 * This is intentionally split off from {@link updateOpsAlertSettings}:
 * a test send is not a tunable change (it must NOT touch any of the six
 * threshold / window override columns or the `updated_*` audit fields),
 * and it must NOT append a row to `ops_alert_settings_history`. It only
 * stamps the three `last_test_*` columns.
 *
 * If the singleton row doesn't exist yet (a fresh deploy where no admin
 * has saved an override yet), we insert it with NULL overrides so the
 * stamp lands cleanly and future PATCHes can update around it.
 *
 * Safe to call after the test email succeeds; if the stamp itself
 * fails, the caller should log + ignore so a transient DB blip doesn't
 * mask the successful test send to the admin.
 */
export async function recordOpsAlertTestSent(opts: {
  recipientCount: number;
  userId: number | null;
  now?: Date;
}): Promise<void> {
  const recipientCount = Math.max(0, Math.floor(opts.recipientCount));
  const userId = typeof opts.userId === "number" && Number.isFinite(opts.userId)
    ? opts.userId
    : null;
  const now = opts.now ?? new Date();

  await db
    .insert(opsAlertSettingsTable)
    .values({
      id: SINGLETON_ID,
      lastTestSentAt: now,
      lastTestSentByUserId: userId,
      lastTestRecipientCount: recipientCount,
    })
    .onConflictDoUpdate({
      target: opsAlertSettingsTable.id,
      set: {
        lastTestSentAt: now,
        lastTestSentByUserId: userId,
        lastTestRecipientCount: recipientCount,
      },
    });

  // Bust the cache so the very next read by the admin UI's
  // read-after-write sees the fresh stamp instead of the previous
  // (or NULL) timestamp.
  cache = null;
}
