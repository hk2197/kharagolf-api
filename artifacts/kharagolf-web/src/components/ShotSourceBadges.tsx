import { Badge } from '@/components/ui/badge';

// Task #709 / #868 — small inline badge row showing the % of shots from each
// capture source for a round. Colours match the HoleMapPanel legend
// (sky=watch, purple=phone, amber=scorer, grey=manual). Sources with zero
// shots are omitted. Used by the general-play round summary and the
// player's tournament round detail to show how reliable their tracking was.
export type ShotSourceBreakdown = {
  counts: { watch: number; phone: number; scorer: number; manual: number };
  total: number;
};

export function ShotSourceBadges({ breakdown, className }: {
  breakdown: ShotSourceBreakdown | null;
  className?: string;
}) {
  if (!breakdown || breakdown.total === 0) return null;
  const styles: Record<'watch'|'phone'|'scorer'|'manual', { label: string; cls: string }> = {
    watch:  { label: 'Watch',  cls: 'bg-sky-500/20 text-sky-300 border-sky-500/30' },
    phone:  { label: 'Phone',  cls: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
    scorer: { label: 'Scorer', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
    manual: { label: 'Manual', cls: 'bg-gray-500/20 text-gray-300 border-gray-500/30' },
  };
  const order: Array<'watch'|'phone'|'scorer'|'manual'> = ['watch','phone','scorer','manual'];
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? 'mt-2'}`}>
      {order.map(src => {
        const n = breakdown.counts[src];
        if (n === 0) return null;
        const pct = Math.round((n / breakdown.total) * 100);
        return (
          <Badge key={src} variant="outline" className={`text-[10px] px-1.5 py-0 ${styles[src].cls}`}>
            {styles[src].label} {pct}%
          </Badge>
        );
      })}
    </div>
  );
}

export default ShotSourceBadges;
