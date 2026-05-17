// Cooldown duration must match PORTAL_DATA_REQUEST_RESEND_COOLDOWN_MS in
// artifacts/api-server/src/routes/portal.ts.
export const RESEND_COOLDOWN_MS = 5 * 60 * 1000;

export interface CooldownRequest {
  lastNotifiedAt: string | null;
  lastEmailStatus: string | null;
  lastPushStatus: string | null;
  lastSmsStatus: string | null;
}

export function channelNeedsRetry(r: CooldownRequest): boolean {
  return (
    r.lastEmailStatus === "failed" ||
    r.lastPushStatus === "failed" ||
    r.lastSmsStatus === "failed"
  );
}

export function cooldownRemainingMs(r: CooldownRequest, nowMs: number): number {
  if (!r.lastNotifiedAt) return 0;
  const remaining = new Date(r.lastNotifiedAt).getTime() + RESEND_COOLDOWN_MS - nowMs;
  return remaining > 0 ? remaining : 0;
}

export function canResend(r: CooldownRequest, nowMs: number): boolean {
  // Mirror the server: bypass the cooldown only when a channel `failed`.
  if (channelNeedsRetry(r)) return true;
  return cooldownRemainingMs(r, nowMs) <= 0;
}

export function formatCooldown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}
