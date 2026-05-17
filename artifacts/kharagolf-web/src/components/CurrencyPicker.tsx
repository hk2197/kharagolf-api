import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';

const SUPPORTED_CURRENCIES = ['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD', 'AUD', 'CAD', 'JPY'];

interface Props {
  className?: string;
  label?: string;
}

/**
 * Player preferred-display-currency picker — backed by
 * GET/PUT /api/currency-tax/me/preferred-currency (task #448).
 */
export function CurrencyPicker({ className = '', label = 'Preferred display currency' }: Props) {
  const { toast } = useToast();
  const [value, setValue] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/currency-tax/me/preferred-currency', { credentials: 'include' })
      .then(r => r.ok ? r.json() as Promise<{ preferredCurrency: string | null }> : null)
      .then(d => { if (!cancelled) { setValue(d?.preferredCurrency ?? ''); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const CLUB_DEFAULT = '__default__';

  const save = async (next: string) => {
    const previous = value;
    const nextValue = next === CLUB_DEFAULT ? '' : next;
    setSaving(true);
    try {
      const res = await fetch('/api/currency-tax/me/preferred-currency', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredCurrency: nextValue || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: 'Could not update currency', description: err.error ?? 'Please try again', variant: 'destructive' });
        setValue(previous);
        return;
      }
      setValue(nextValue);
      toast({ title: nextValue ? `Display currency set to ${nextValue}` : 'Using club default currency' });
    } catch {
      toast({ title: 'Could not update currency', description: 'Please try again', variant: 'destructive' });
      setValue(previous);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={className}>
      <label className="text-xs text-muted-foreground mb-1 block">{label}</label>
      <Select value={value || CLUB_DEFAULT} onValueChange={save} disabled={loading || saving}>
        <SelectTrigger className="bg-black/40 border-white/10 text-white" data-testid="select-preferred-currency">
          <SelectValue placeholder={loading ? 'Loading…' : 'Use club default'} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CLUB_DEFAULT}>Use club default</SelectItem>
          {SUPPORTED_CURRENCIES.map(c => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground mt-1">
        Prices will appear in the booked currency with an approximate conversion to your preferred currency. Charges are still settled in the club's currency.
      </p>
    </div>
  );
}

export default CurrencyPicker;
