import React from 'react';

/**
 * Task #1862 — wallet refund "delivery status" row, web.
 *
 * Mirrors the mobile `RefundDeliveryStatusRow` (in the
 * `kharagolf-mobile` artifact) so the same five per-channel statuses
 * render consistently across both surfaces. Used by:
 *   - the wallet panel inside `SideGamesAdmin.tsx` (the org admin's
 *     own wallet view, which still goes through `/api/wallet`), and
 *   - the auto-refunded wallet top-ups dashboard at
 *     `pages/wallet-topup-refunds.tsx`, which passes
 *     `showLastError` so admins can see the most recent provider
 *     error string for failed/exhausted rows.
 *
 * The legacy `NotifyChannelBadgesRow` only renders the email + push
 * retry pills (Task #1841) and intentionally hides skipped channels.
 * Refund alerts also fan out to SMS / WhatsApp, and the "skipped"
 * state is itself the answer to "did the SMS ever go out?", so this
 * row exists to surface all four channels with all five states.
 */
export type RefundDeliveryStatus = 'sent' | 'failed' | 'retrying' | 'exhausted' | 'skipped';

export interface RefundDeliveryChannel {
  status: RefundDeliveryStatus | null;
  attempts: number;
  lastAt: string | null;
  nextRetryAt: string | null;
  exhaustedAt: string | null;
  /** Only present in admin responses. */
  lastError?: string | null;
}

export interface RefundDeliveryInfo {
  email: RefundDeliveryChannel;
  push: RefundDeliveryChannel;
  sms: RefundDeliveryChannel;
  whatsapp: RefundDeliveryChannel;
}

const CHANNEL_LABELS: Record<keyof RefundDeliveryInfo, string> = {
  email: 'Email',
  push: 'Push',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

const CHANNEL_KEYS: Array<keyof RefundDeliveryInfo> = ['email', 'push', 'sms', 'whatsapp'];

export function refundDeliveryStatusLabel(status: RefundDeliveryStatus | null): string {
  switch (status) {
    case 'sent': return 'Sent';
    case 'retrying': return 'Retrying';
    case 'failed': return 'Failed';
    case 'exhausted': return 'Gave up';
    case 'skipped': return 'Skipped';
    case null:
    default: return '—';
  }
}

function classFor(status: RefundDeliveryStatus | null): string {
  switch (status) {
    case 'sent': return 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200';
    case 'retrying':
    case 'failed': return 'border-amber-400/40 bg-amber-500/15 text-amber-200';
    case 'exhausted': return 'border-rose-400/50 bg-rose-500/15 text-rose-200';
    case 'skipped': return 'border-white/10 bg-white/5 text-muted-foreground';
    case null:
    default: return 'border-white/10 bg-white/5 text-muted-foreground';
  }
}

export function RefundDeliveryStatusRow({
  delivery,
  rowTestId,
  channelTestIdPrefix,
  showLastError = false,
}: {
  delivery: RefundDeliveryInfo;
  rowTestId: string;
  channelTestIdPrefix: string;
  /**
   * Member-facing surfaces leave this `false` and the API also omits
   * `lastError` for them (defence in depth). Admin surface
   * (wallet-topup-refunds) sets `true` and the API populates the
   * field; the row only renders the error string for rows whose
   * status is `failed` / `exhausted` (per task: "the most recent
   * provider error string is visible to admins" for those rows).
   */
  showLastError?: boolean;
}) {
  return (
    <div
      data-testid={rowTestId}
      className="mt-1 flex flex-wrap gap-1"
    >
      {CHANNEL_KEYS.map(channel => {
        const ch = delivery[channel];
        const status = ch.status;
        const showError = showLastError && (status === 'failed' || status === 'exhausted') && Boolean(ch.lastError);
        return (
          <span
            key={channel}
            data-testid={`${channelTestIdPrefix}-${channel}`}
            data-status={status ?? 'none'}
            className={`inline-flex flex-col px-1.5 py-0.5 rounded border text-[10px] ${classFor(status)}`}
            title={status === 'failed' || status === 'exhausted'
              ? `${CHANNEL_LABELS[channel]}: ${refundDeliveryStatusLabel(status)} (${ch.attempts} attempt${ch.attempts === 1 ? '' : 's'})${ch.lastError ? ` — ${ch.lastError}` : ''}`
              : `${CHANNEL_LABELS[channel]}: ${refundDeliveryStatusLabel(status)}`}
          >
            <span>{CHANNEL_LABELS[channel]}: {refundDeliveryStatusLabel(status)}</span>
            {showError && ch.lastError ? (
              <span
                data-testid={`${channelTestIdPrefix}-${channel}-error`}
                className="opacity-80"
              >
                {ch.lastError}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export default RefundDeliveryStatusRow;
