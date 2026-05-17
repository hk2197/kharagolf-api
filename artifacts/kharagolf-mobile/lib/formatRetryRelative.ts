/**
 * Task #1499 / #1841 — coarse "in 2m 14s" / "5m ago" formatter shared
 * by every notify-retry badge surface on mobile (wallet withdrawal,
 * side-game settlement receipt, wallet top-up refund). Mirrors the web
 * implementation at `artifacts/kharagolf-web/src/lib/formatRetryRelative.ts`
 * verbatim so the two platforms can never silently diverge.
 *
 * Returns `null` for empty / unparseable timestamps so the caller can
 * drop the suffix entirely without rendering "null" or "NaN".
 *
 * Format rules:
 *   - <1s   → "in <1s" / "just now"
 *   - <1m   → "in 42s" / "42s ago"
 *   - <1h   → "in 2m 14s" / "2m 14s ago" (drop "0s" tail)
 *   - <1d   → "in 1h 3m" / "1h 3m ago"   (drop "0m" tail)
 *   - >=1d  → "in 2d 4h" / "2d 4h ago"   (drop "0h" tail)
 */
export function formatRetryRelative(iso: string | null, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const diffMs = t - nowMs;
  const isPast = diffMs < 0;
  let s = Math.floor(Math.abs(diffMs) / 1000);
  if (s < 1) return isPast ? 'just now' : 'in <1s';
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hours = Math.floor(s / 3600); s -= hours * 3600;
  const mins = Math.floor(s / 60); s -= mins * 60;
  let body: string;
  if (days > 0) body = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  else if (hours > 0) body = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  else if (mins > 0) body = s > 0 ? `${mins}m ${s}s` : `${mins}m`;
  else body = `${s}s`;
  return isPast ? `${body} ago` : `in ${body}`;
}
