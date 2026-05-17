import { ShieldAlert } from 'lucide-react';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

// Task #709 — flag rounds whose shot data is mostly hand-keyed. Helps the TD
// spot players whose SG / dispersion stats can't be trusted.
export type DataQualityRow = {
  playerId: number;
  playerName: string;
  round: number;
  total: number;
  counts: { watch: number; phone: number; scorer: number; manual: number };
  manualPct: number;
  flagged: boolean;
  // Task #1192 — most recent manual-entry alert processed for this
  // (player, round). null when the notifier never ran on this round at
  // all (e.g. pre-#1658 rounds). Hovering the badge surfaces delivery
  // counts so TDs can see at a glance whether push/email actually
  // landed.
  alertedAt?: string | null;
  alertDelivery?: {
    recipientCount: number;
    pushAttempted: number;
    pushSent: number;
    emailAttempted: number;
    emailSent: number;
  } | null;
  // Task #1658 — outcome of the notifier invocation. 'sent' renders the
  // existing "alerted at HH:MM" badge; 'skipped'/'failed' render a
  // muted-amber badge carrying the canonical reason ("skipped — org
  // muted", "skipped — below threshold", …). null preserves the
  // legacy "no badge" rendering for pre-#1658 rounds.
  alertStatus?: 'sent' | 'skipped' | 'failed' | null;
  alertReason?: string | null;
};

// Map the canonical notifier reason strings (from
// `MANUAL_ENTRY_NOTIFY_REASONS` in the api-server) onto a TD-friendly
// label. Centralised here so the badge tooltip and the on-row label
// stay in sync, and so adding a new reason to the notifier surfaces a
// readable label here without any extra plumbing (unknown reasons fall
// through to a humanised version of the raw string).
function describeSkipReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'below_threshold': return 'below threshold';
    case 'no_shots_captured': return 'no shots captured';
    case 'tournament_not_found': return 'tournament missing';
    case 'tournament_muted': return 'tournament muted';
    case 'org_lookup_failed': return 'org lookup failed';
    case 'org_muted': return 'org muted';
    case 'no_recipients': return 'no recipients';
    case 'all_recipients_opted_out': return 'all recipients opted out';
    default:
      if (!reason) return 'unspecified';
      return reason.replace(/_/g, ' ');
  }
}

export function FlaggedRoundsBanner({ flaggedRounds }: { flaggedRounds: DataQualityRow[] }) {
  if (flaggedRounds.length === 0) return null;
  return (
    <div className="mx-6 mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-amber-400 font-semibold text-sm">
            Data quality: {flaggedRounds.length} round{flaggedRounds.length === 1 ? '' : 's'} mostly hand-entered
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 mb-2">
            More than half the shots were typed in manually rather than tracked by watch, phone, or scorer station — SG and dispersion stats may be unreliable.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {flaggedRounds.slice(0, 12).map(r => (
              <span
                key={`${r.playerId}-${r.round}`}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-300"
              >
                <span>
                  {r.playerName} R{r.round} — {r.manualPct}% manual ({r.counts.manual}/{r.total})
                </span>
                {(() => {
                  // Task #1658 — render one of three badges:
                  //   - status='sent': existing "alerted at HH:MM" badge.
                  //   - status='skipped'/'failed': muted-amber badge with the
                  //     skip reason ("skipped — org muted") so TDs see *why*
                  //     the round was silent rather than guessing.
                  //   - null: pre-#1658 round with no audit row → no badge,
                  //     mirroring the legacy behaviour exactly.
                  if (r.alertStatus === 'skipped' || r.alertStatus === 'failed') {
                    const label = describeSkipReason(r.alertReason);
                    return (
                      <UITooltip>
                        <TooltipTrigger asChild>
                          <span
                            data-testid={`alert-badge-skip-${r.playerId}-${r.round}`}
                            className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded border border-amber-300/40 bg-amber-300/10 text-amber-200/80 cursor-help"
                          >
                            {r.alertStatus} — {label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          <div className="font-semibold mb-1">Manual-entry alert {r.alertStatus}</div>
                          <div>Reason: {label}</div>
                          {r.alertedAt && !isNaN(new Date(r.alertedAt).getTime()) && (
                            <div>Recorded {new Date(r.alertedAt).toLocaleString()}</div>
                          )}
                        </TooltipContent>
                      </UITooltip>
                    );
                  }
                  if (!r.alertedAt) return null;
                  const sent = new Date(r.alertedAt);
                  if (isNaN(sent.getTime())) return null;
                  return (
                    <UITooltip>
                      <TooltipTrigger asChild>
                        <span
                          data-testid={`alert-badge-${r.playerId}-${r.round}`}
                          className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0 rounded border border-amber-400/50 bg-amber-400/20 text-amber-200 cursor-help"
                        >
                          alerted at {sent.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <div className="font-semibold mb-1">Manual-entry alert delivery</div>
                        <div>Recipients: {r.alertDelivery?.recipientCount ?? 0}</div>
                        <div>Push: {r.alertDelivery?.pushSent ?? 0}/{r.alertDelivery?.pushAttempted ?? 0} sent</div>
                        <div>Email: {r.alertDelivery?.emailSent ?? 0}/{r.alertDelivery?.emailAttempted ?? 0} sent</div>
                      </TooltipContent>
                    </UITooltip>
                  );
                })()}
              </span>
            ))}
            {flaggedRounds.length > 12 && (
              <span className="text-[11px] px-2 py-0.5 text-amber-300/70">+{flaggedRounds.length - 12} more</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
