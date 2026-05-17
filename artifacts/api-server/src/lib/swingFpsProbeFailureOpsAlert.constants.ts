/**
 * Hardcoded defaults for the swing-video fps-probe failure ops alert
 * (Task #1704).
 *
 * Pulled into their own module so other code (cron, dashboards, future
 * settings UIs) can reference them without importing the alert
 * implementation file and dragging the mailer / DB clients along.
 */

/**
 * Default trigger: when the daily retention sweep observes this many
 * (or more) `failed` probe rows in `swing_video_fps_probes`, ops is
 * paged. Picked so a single bad object or one transient storage hiccup
 * (which rarely produces more than a handful of failed rows in a day)
 * does not page on-call, but a systemic regression (bad ffprobe deploy,
 * storage outage corrupting many objects) does.
 */
export const DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD = 25;

/**
 * Default in-process cooldown — the cron interval is already 24h, so a
 * 24h cooldown collapses to "at most one page per day per replica" in
 * practice. A process restart can re-page once inside the cooldown,
 * matching the dedup semantics of every other ops-alert module.
 */
export const DEFAULT_OPS_FPS_PROBE_FAILED_COOLDOWN_HOURS = 24;

/**
 * How many of the most recent `failed` rows we include in the alert
 * email body so ops has actionable swing_video_id / error_message
 * values to start triaging from. The cap keeps the email body bounded
 * even if hundreds of failures piled up at once.
 */
export const DEFAULT_OPS_FPS_PROBE_FAILED_SAMPLE_SIZE = 10;

/**
 * Growth trigger: even when the absolute `failedRetained` count is
 * still below {@link DEFAULT_OPS_FPS_PROBE_FAILED_THRESHOLD}, we page
 * on-call when at least this many *new* `failed` rows showed up inside
 * the most recent {@link DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS}
 * window — i.e. the failure backlog grew materially since the last
 * daily run. Catches a slow week-over-week creep that would otherwise
 * never trip the absolute threshold.
 *
 * The retention sweep does not delete `failed` rows (Task #1412), so
 * counting `failed` rows whose `updated_at` is inside the lookback
 * window gives us the run-over-run growth without needing a persisted
 * "last observed count" — `recordFpsProbeFailure` is the only writer
 * that produces this state and it always stamps `updated_at` on the
 * transition. Stateless by design, so growth checks survive process
 * restarts and replicas trivially.
 */
export const DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_DELTA = 10;

/**
 * Lookback window for the growth trigger. Defaults to 24h so a daily
 * cron tick compares against roughly the previous tick. Operators who
 * run the sweep on a different cadence (e.g. every 12h or every 48h)
 * can widen / narrow this with the env var without redeploying.
 */
export const DEFAULT_OPS_FPS_PROBE_FAILED_GROWTH_LOOKBACK_HOURS = 24;
