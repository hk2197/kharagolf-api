import { useEffect, useState } from 'react';
import { Loader2, Calendar, ChevronRight, GraduationCap, Target, UtensilsCrossed, Briefcase, Wallet, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';

type UpcomingKind = 'tee' | 'lesson' | 'range' | 'fb' | 'rental' | 'wallet_topup';

interface UpcomingItem {
  kind: UpcomingKind | string;
  id: number;
  organizationId: number | null;
  startsAt: string;
}

const CATEGORY: Record<UpcomingKind, { label: string; icon: LucideIcon }> = {
  tee: { label: 'Tee booking', icon: Calendar },
  lesson: { label: 'Coaching lesson', icon: GraduationCap },
  range: { label: 'Range bay', icon: Target },
  fb: { label: 'F&B order', icon: UtensilsCrossed },
  rental: { label: 'Equipment rental', icon: Briefcase },
  // Wallet top-up requests (Task #1423) — pending verification, awaiting
  // refund, or recently refunded. The /wallet-topup-refunds page lists
  // the member's recent top-up activity.
  wallet_topup: { label: 'Wallet top-up refund', icon: Wallet },
};

function describe(item: UpcomingItem): { label: string; Icon: LucideIcon } {
  const meta = CATEGORY[item.kind as UpcomingKind];
  if (meta) return { label: meta.label, Icon: meta.icon };
  return { label: `${item.kind} booking`, Icon: Calendar };
}

// Each row deep-links straight to the matching record so members land on the
// specific booking they tapped instead of a re-find-it list. Categories with a
// dedicated detail surface (lessons, range, tee) route there with a
// ?bookingId= query the page reads to switch to its "my bookings" view and
// highlight the matching row. F&B orders and rental bookings have dedicated
// member-facing detail pages on web (Task #1728): /fb-orders/:orderId and
// /rentals/bookings/:bookingId. Wallet top-ups go straight to the standalone
// /wallet-topup-refunds page (no per-row id — the page lists the member's
// recent top-up activity).
function hrefFor(kind: UpcomingKind | string, id: number): string | null {
  switch (kind) {
    case 'tee':
      return `/portal?tab=tee-bookings&id=${id}`;
    case 'lesson':
      return `/lessons?bookingId=${id}`;
    case 'range':
      return `/range-bookings?bookingId=${id}`;
    case 'fb':
      return `/fb-orders/${id}`;
    case 'rental':
      return `/rentals/bookings/${id}`;
    case 'wallet_topup':
      return `/wallet-topup-refunds`;
    default:
      return null;
  }
}


export function MyUpcomingWidget() {
  const [items, setItems] = useState<UpcomingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/portal/my-upcoming', { credentials: 'include' })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ items: UpcomingItem[] }>;
      })
      .then(d => { if (!cancelled) setItems(d.items ?? []); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); });
    return () => { cancelled = true; };
  }, []);

  if (error) return null;

  return (
    <Card className="glass-panel border-white/10 p-5" data-testid="widget-my-upcoming">
      <div className="flex items-center gap-2 mb-3">
        <Calendar className="w-4 h-4 text-primary" />
        <h3 className="font-semibold text-white">Upcoming</h3>
      </div>
      {items === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No upcoming bookings.</p>
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 5).map(item => {
            const { label, Icon } = describe(item);
            const href = hrefFor(item.kind, item.id);
            const inner = (
              <>
                <Icon className="w-4 h-4 text-primary shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-white truncate">{label}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(item.startsAt).toLocaleString()}
                  </span>
                </div>
                {href ? <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" /> : null}
              </>
            );
            return (
              <li key={`${item.kind}-${item.id}`}>
                {href ? (
                  <a
                    href={href}
                    className="w-full flex items-center gap-3 text-sm bg-white/[0.03] hover:bg-white/[0.06] rounded-lg px-3 py-2 no-underline"
                    data-testid={`upcoming-${item.kind}-${item.id}`}
                  >
                    {inner}
                  </a>
                ) : (
                  <div
                    className="w-full flex items-center gap-3 text-sm bg-white/[0.03] rounded-lg px-3 py-2"
                    data-testid={`upcoming-${item.kind}-${item.id}`}
                  >
                    {inner}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
