/**
 * Hardcoded defaults for the round-weather-cache backfill ops alert
 * (Task #2002).
 *
 * Pulled into their own module so other code (cron, future settings UI,
 * tests) can reference them without importing the alert implementation
 * file and dragging the mailer / DB clients along.
 */

/**
 * Default failed-row threshold per pass. Any pass that records this many
 * `failed` fetches (or more) counts as a "failed" pass for the streak
 * detector. Default 1 — a single failed Open-Meteo call is normal noise
 * if it doesn't repeat, but having ANY failures three days running
 * almost always means an upstream change.
 */
export const DEFAULT_OPS_WEATHER_BACKFILL_FAILED_THRESHOLD = 1;

/**
 * Default still-pending threshold per pass. Open-Meteo's archive lags
 * ~5 days, so a small steady-state pile-up of still-pending rows is
 * expected (newly logged rounds always land NULL the first pass and
 * have to wait for the archive to catch up). The default is set high
 * enough that normal lag does not trip the alert; only a sustained
 * pile-up in the dozens-of-rounds range — which would only happen if
 * the archive itself stops catching up — counts as a "stuck" pass.
 */
export const DEFAULT_OPS_WEATHER_BACKFILL_PENDING_THRESHOLD = 25;

/**
 * Number of consecutive passes that must show the same `failed` /
 * `pending` breach before ops is paged. The cron runs every 24h, so 3
 * here means "the issue has persisted for ~3 days". A single bad day
 * (one Open-Meteo blip, one transient deploy) does not page — only a
 * sustained pattern does. Errored-streak detection has its own,
 * tighter knob below: a thrown cron is a much louder signal than a
 * non-zero `failed` count and needs to surface faster (Task #2002
 * spec: "or when the cron itself throws for >24h").
 */
export const DEFAULT_OPS_WEATHER_BACKFILL_CONSECUTIVE_PASSES = 3;

/**
 * Number of consecutive ERRORED passes (cron threw before producing a
 * summary) that must occur before ops is paged. Default 2 — the cron
 * runs every 24h, so two consecutive errored passes spans ~24h between
 * the first and second throw, which is exactly the ">24h" trigger the
 * task spec asks for. Kept separate from the failed/pending streak
 * length because a thrown cron is a structurally louder signal (we
 * have NO data at all) and shouldn't have to wait three days. A
 * single transient throw still won't page — it takes two in a row.
 */
export const DEFAULT_OPS_WEATHER_BACKFILL_ERRORED_CONSECUTIVE_PASSES = 2;

/**
 * Default in-process cooldown — the cron interval is already 24h, so a
 * 24h cooldown collapses to "at most one page per day per replica" in
 * practice. A process restart can re-page once inside the cooldown,
 * matching the dedup semantics of every other ops-alert module.
 */
export const DEFAULT_OPS_WEATHER_BACKFILL_COOLDOWN_HOURS = 24;

/**
 * Cap on the rolling per-pass history buffer kept in memory. The streak
 * detectors only look at the most recent `consecutivePasses` entries,
 * but the buffer is sized larger so the alert email can include a
 * trailing window for context without re-querying anything.
 */
export const DEFAULT_OPS_WEATHER_BACKFILL_HISTORY_SIZE = 10;
