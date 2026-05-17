import { useEffect, useMemo, useState } from 'react';
import { Loader2, Calendar, GraduationCap, Target, UtensilsCrossed, Briefcase, Wallet, type LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useHighlightFromQuery, useHighlightTarget } from '@/hooks/use-highlight-row';

type UpcomingKind = 'tee' | 'lesson' | 'range' | 'fb' | 'rental' | 'wallet_topup';

interface UpcomingItem {
  kind: UpcomingKind | string;
  id: number;
  organizationId: number | null;
  startsAt: string;
}

const CATEGORY: Record<UpcomingKind, { label: string; plural: string; icon: LucideIcon }> = {
  tee: { label: 'Tee booking', plural: 'Tee times', icon: Calendar },
  lesson: { label: 'Coaching lesson', plural: 'Lessons', icon: GraduationCap },
  range: { label: 'Range bay', plural: 'Range', icon: Target },
  fb: { label: 'F&B order', plural: 'F&B', icon: UtensilsCrossed },
  rental: { label: 'Equipment rental', plural: 'Rentals', icon: Briefcase },
  // Wallet top-up requests (Task #1423) — pending verification, awaiting
  // refund, or recently refunded. Mirrors the MyUpcomingWidget entry so the
  // unified list renders them with a Wallet icon and a human label instead of
  // the literal "wallet_topup booking" fallback.
  wallet_topup: { label: 'Wallet top-up refund', plural: 'Wallet', icon: Wallet },
};

function describe(item: UpcomingItem): { label: string; Icon: LucideIcon } {
  const meta = CATEGORY[item.kind as UpcomingKind];
  if (meta) return { label: meta.label, Icon: meta.icon };
  return { label: `${item.kind} booking`, Icon: Calendar };
}

const FILTERS: Array<{ value: 'all' | UpcomingKind; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'tee', label: CATEGORY.tee.plural },
  { value: 'lesson', label: CATEGORY.lesson.plural },
  { value: 'range', label: CATEGORY.range.plural },
  { value: 'fb', label: CATEGORY.fb.plural },
  { value: 'rental', label: CATEGORY.rental.plural },
  { value: 'wallet_topup', label: CATEGORY.wallet_topup.plural },
];

export function UpcomingFullList({ initialKind }: { initialKind?: UpcomingKind }) {
  const [items, setItems] = useState<UpcomingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | UpcomingKind>(initialKind ?? 'all');
  // Deep-link target id from /portal?tab=upcoming&id=N — used by F&B and
  // rentals which don't have a dedicated detail page on web yet, so we land
  // members here and visually flash the matching row.
  const { highlightId, consume: consumeHighlight } = useHighlightFromQuery('id');

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

  const filtered = useMemo(() => {
    if (!items) return null;
    if (filter === 'all') return items;
    return items.filter(i => i.kind === filter);
  }, [items, filter]);

  if (error) {
    return (
      <Card className="glass-panel border-white/10 p-6 text-sm text-muted-foreground">
        Couldn't load your upcoming items. Please refresh.
      </Card>
    );
  }

  return (
    <div className="space-y-3" data-testid="upcoming-full-list">
      <div className="flex flex-wrap gap-2">
        {FILTERS.map(f => (
          <Button
            key={f.value}
            type="button"
            variant={filter === f.value ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f.value)}
            data-testid={`upcoming-filter-${f.value}`}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {filtered === null ? (
        <Card className="glass-panel border-white/10 p-6 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="glass-panel border-white/10 p-12 text-center">
          <Calendar className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
          <p className="text-muted-foreground">Nothing scheduled in this category.</p>
        </Card>
      ) : (
        <ul className="space-y-2">
          {filtered.map(item => (
            <UpcomingRow
              key={`${item.kind}-${item.id}`}
              item={item}
              isHighlight={highlightId === item.id}
              onConsumeHighlight={consumeHighlight}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function UpcomingRow({
  item,
  isHighlight,
  onConsumeHighlight,
}: {
  item: UpcomingItem;
  isHighlight: boolean;
  onConsumeHighlight: () => void;
}) {
  const { label, Icon } = describe(item);
  const setHighlightRef = useHighlightTarget<HTMLLIElement>(isHighlight, onConsumeHighlight);
  return (
    <li
      ref={setHighlightRef}
      className="flex items-center gap-3 text-sm bg-white/[0.03] rounded-lg px-3 py-3"
      data-testid={`upcoming-row-${item.kind}-${item.id}`}
    >
      <Icon className="w-4 h-4 text-primary shrink-0" />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-white">{label}</span>
        <span className="text-xs text-muted-foreground">
          {new Date(item.startsAt).toLocaleString()}
        </span>
      </div>
    </li>
  );
}
