/**
 * Hardcoded defaults for the wallet-topup-refund SMS / WhatsApp retry
 * exhaustion ops alert (Task #1863).
 *
 * Pulled into their own module so cron, dashboards, and tests can
 * reference the defaults without importing the alert implementation
 * file (which drags in the mailer + DB clients).
 */

/**
 * Default per-organization threshold. When the lookback window
 * contains this many (or more) wallet-topup-refund attempt rows
 * stamped with `smsRetryExhaustedAt` / `whatsappRetryExhaustedAt`
 * inside a single organization, ops is paged.
 *
 * Picked so a single member with a permanently bad phone number does
 * not page on-call — that's a normal `no_address` / opted-out tail
 * — but a Twilio outage / SMS_PROVIDER misconfiguration that drains
 * the 5-attempt budget across multiple refunds inside an hour does.
 */
export const DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD = 3;

/**
 * Default lookback window. The cron tick is hourly, so a one-hour
 * window keeps the alert focused on "what just broke" rather than
 * smearing across days. Operators who run the cron on a different
 * cadence can widen / narrow this with the env var without
 * redeploying.
 */
export const DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS = 1;

/**
 * Default in-process cooldown — matches the lookback window so a
 * sustained outage stays at one page per replica per hour. A process
 * restart can re-page once inside the cooldown, matching the dedup
 * semantics of every other ops-alert module.
 */
export const DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS = 1;

/**
 * How many distinct provider error strings (per channel, per org) we
 * include in the alert body so on-call has actionable evidence of the
 * underlying failure mode (e.g. "Twilio: 21610 — Recipient unsubscribed",
 * "Twilio: 30007 — Carrier blocked"). Cap keeps the email body bounded
 * even if dozens of refunds piled up at once.
 */
export const DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE = 5;
