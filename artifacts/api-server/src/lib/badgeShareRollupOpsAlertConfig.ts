/**
 * Tiny config module for the badge-share rollup auto-pager (Task #1478).
 *
 * Extracted into its own file so `badgeShareRollup.ts` (which surfaces
 * the persisted cooldown state on the super-admin panel — Task #1814)
 * and `badgeShareRollupOpsAlert.ts` (which owns the alert job itself)
 * can both reference the same defaults without forming a circular
 * import: the alert module already imports the rollup summary helper
 * from `badgeShareRollup`, so the rollup module cannot in turn import
 * from the alert module.
 */
export const DEFAULT_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS = 6;

/** Resolve the configured cooldown for the auto-pager (env-driven). */
export function getBadgeShareRollupOpsAlertCooldownHours(): number {
  const raw = process.env.OPS_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS;
  if (!raw) return DEFAULT_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0
    ? v
    : DEFAULT_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS;
}
