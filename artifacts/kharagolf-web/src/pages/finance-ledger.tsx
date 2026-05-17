import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { Download, ArrowLeft, RefreshCw, ExternalLink, Mail, Eye } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const currencySymbol: Record<string, string> = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SGD: 'S$',
};

interface LevySummary {
  id: number;
  name: string;
  description: string | null;
  amount: string;
  currency: string;
  scope: string | null;
  dueDate: string | null;
  createdAt: string;
  chargesCount: number;
  paidCount: number;
  partialCount: number;
  unpaidCount: number;
  waivedCount: number;
  refundedCount: number;
  collected: string;
  refunded: string;
  outstanding: string;
  waivedAmount: string;
}

interface LeviesSummaryResponse {
  levies: LevySummary[];
  totalsByCurrency: Record<string, {
    collected: number; outstanding: number; refunded: number; waived: number;
    chargesCount: number; leviesCount: number;
  }>;
}

interface RevenueByCurrencyRow {
  currency: string; revenue: string; tax: string; eventCount: number;
}
interface RevenueByCurrencyResponse {
  byCurrency: RevenueByCurrencyRow[];
  byCurrencyAndEventType: Array<RevenueByCurrencyRow & { eventType: string }>;
  range: { from: string | null; to: string | null };
}

async function j<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

function fmtMoney(value: number | string, currency: string): string {
  const sym = currencySymbol[currency] ?? '';
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return `${sym}${(isFinite(n) ? n : 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

export default function FinanceLedgerPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId;
  const { toast } = useToast();

  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [type, setType] = useState<'all' | 'payment' | 'refund' | 'waive'>('all');

  // Per-levy table filters (client-side) — persisted via URL query params so a
  // filtered view survives refresh and can be shared between staff members.
  const initialFilters = useMemo(() => {
    if (typeof window === 'undefined') {
      return { name: '', from: '', to: '', currency: 'all', outstanding: false };
    }
    const sp = new URLSearchParams(window.location.search);
    return {
      name: sp.get('name') ?? '',
      from: sp.get('from') ?? '',
      to: sp.get('to') ?? '',
      currency: sp.get('currency') ?? 'all',
      outstanding: sp.get('outstanding') === '1',
    };
  }, []);
  const [outstandingOnly, setOutstandingOnly] = useState(initialFilters.outstanding);
  const [filterFrom, setFilterFrom] = useState<string>(initialFilters.from);
  const [filterTo, setFilterTo] = useState<string>(initialFilters.to);
  const [filterCurrency, setFilterCurrency] = useState<string>(initialFilters.currency);
  const [filterName, setFilterName] = useState<string>(initialFilters.name);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (filterName.trim()) sp.set('name', filterName); else sp.delete('name');
    if (filterFrom) sp.set('from', filterFrom); else sp.delete('from');
    if (filterTo) sp.set('to', filterTo); else sp.delete('to');
    if (filterCurrency && filterCurrency !== 'all') sp.set('currency', filterCurrency); else sp.delete('currency');
    if (outstandingOnly) sp.set('outstanding', '1'); else sp.delete('outstanding');
    const qs = sp.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    if (newUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, [filterName, filterFrom, filterTo, filterCurrency, outstandingOnly]);

  const summaryQuery = useQuery<LeviesSummaryResponse>({
    queryKey: ['levies-summary', orgId],
    enabled: !!orgId,
    queryFn: () => j<LeviesSummaryResponse>(`/api/organizations/${orgId}/members-360/levies-summary`),
  });

  // Per-currency revenue + tax pivot, sourced from the unified financial ledger.
  // Falls back gracefully when no financial-ledger rows exist yet.
  const [pivotCurrency, setPivotCurrency] = useState<string>('all');
  const revByCurrencyQuery = useQuery<RevenueByCurrencyResponse>({
    queryKey: ['revenue-by-currency', orgId, from, to],
    enabled: !!orgId,
    queryFn: () => {
      const sp = new URLSearchParams();
      if (from) sp.set('from', from);
      if (to) sp.set('to', to);
      const qs = sp.toString();
      return j<RevenueByCurrencyResponse>(
        `/api/organizations/${orgId}/members-360/revenue-by-currency${qs ? `?${qs}` : ''}`,
      );
    },
  });
  const revPivotCurrencies = useMemo(() => {
    const s = new Set<string>();
    for (const r of revByCurrencyQuery.data?.byCurrency ?? []) s.add(r.currency);
    return Array.from(s).sort();
  }, [revByCurrencyQuery.data]);
  const revPivotRows = useMemo(() => {
    const rows = revByCurrencyQuery.data?.byCurrencyAndEventType ?? [];
    if (pivotCurrency === 'all') return rows;
    return rows.filter(r => r.currency === pivotCurrency);
  }, [revByCurrencyQuery.data, pivotCurrency]);
  const revTotals = useMemo(() => {
    return (revByCurrencyQuery.data?.byCurrency ?? []).filter(r =>
      pivotCurrency === 'all' ? true : r.currency === pivotCurrency,
    );
  }, [revByCurrencyQuery.data, pivotCurrency]);

  const totalsRows = useMemo(() => {
    const t = summaryQuery.data?.totalsByCurrency ?? {};
    return Object.entries(t).map(([cur, v]) => ({ currency: cur, ...v }));
  }, [summaryQuery.data]);

  const availableCurrencies = useMemo(() => {
    const set = new Set<string>();
    for (const l of summaryQuery.data?.levies ?? []) set.add(l.currency);
    return Array.from(set).sort();
  }, [summaryQuery.data]);

  const filteredLevies = useMemo(() => {
    const all = summaryQuery.data?.levies ?? [];
    const fromTs = filterFrom ? new Date(filterFrom).getTime() : null;
    const toTs = filterTo ? (() => { const d = new Date(filterTo); d.setHours(23, 59, 59, 999); return d.getTime(); })() : null;
    const q = filterName.trim().toLowerCase();
    return all.filter(l => {
      if (outstandingOnly && parseFloat(l.outstanding) <= 0) return false;
      if (filterCurrency !== 'all' && l.currency !== filterCurrency) return false;
      if (q && !l.name.toLowerCase().includes(q)) return false;
      if (fromTs !== null || toTs !== null) {
        const ts = new Date(l.createdAt).getTime();
        if (fromTs !== null && ts < fromTs) return false;
        if (toTs !== null && ts > toTs) return false;
      }
      return true;
    });
  }, [summaryQuery.data, outstandingOnly, filterFrom, filterTo, filterCurrency, filterName]);

  const totalLeviesCount = summaryQuery.data?.levies.length ?? 0;
  const filtersActive = outstandingOnly || !!filterFrom || !!filterTo || filterCurrency !== 'all' || !!filterName.trim();
  const clearFilters = () => {
    setOutstandingOnly(false);
    setFilterFrom('');
    setFilterTo('');
    setFilterCurrency('all');
    setFilterName('');
  };

  const downloadRevenuePivot = () => {
    if (!orgId) return;
    if (from && to && from > to) {
      toast({ title: 'Invalid date range', description: 'The "from" date must be on or before the "to" date.', variant: 'destructive' });
      return;
    }
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    const url = `${BASE}/api/organizations/${orgId}/members-360/revenue-by-currency.csv${qs ? `?${qs}` : ''}`;
    window.location.href = url;
  };

  const downloadAll = () => {
    if (!orgId) return;
    if (from && to && from > to) {
      toast({ title: 'Invalid date range', description: 'The "from" date must be on or before the "to" date.', variant: 'destructive' });
      return;
    }
    const params = new URLSearchParams();
    if (from) params.set('from', new Date(from).toISOString());
    if (to) {
      const d = new Date(to);
      d.setHours(23, 59, 59, 999);
      params.set('to', d.toISOString());
    }
    if (type !== 'all') params.set('type', type);
    const qs = params.toString();
    const url = `${BASE}/api/organizations/${orgId}/members-360/levy-ledger.csv${qs ? `?${qs}` : ''}`;
    window.location.href = url;
  };

  return (
    <div className="min-h-screen bg-[#0a1628] text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <Link href={`${BASE}/club-members`}>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-white hover:bg-white/5 gap-1.5 mb-2" data-testid="link-back-to-members">
                <ArrowLeft className="w-3.5 h-3.5" /> Back to Club Members
              </Button>
            </Link>
            <h1 className="text-2xl font-bold">Finance — Levy Ledger</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Reconcile every levy in one place. Export the entire ledger across all levies for a chosen date range and event type.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`${BASE}/wallet-topup-refunds`}>
              <Button
                variant="outline"
                size="sm"
                className="border-white/10 text-white hover:bg-white/5 gap-1.5"
                data-testid="link-wallet-topup-refunds"
              >
                Auto-refunded top-ups
              </Button>
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => summaryQuery.refetch()}
              disabled={summaryQuery.isFetching}
              className="border-white/10 text-white hover:bg-white/5 gap-1.5"
              data-testid="button-refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${summaryQuery.isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Export form */}
        <Card className="bg-black/30 border-white/10">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Download className="w-4 h-4 text-amber-400" /> Export full ledger (CSV)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">
              Downloads a single CSV with every payment, refund and waive event across all levies in this club. Leave the filters empty to export everything.
            </p>
            <div className="grid md:grid-cols-4 gap-3 items-end">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">From</label>
                <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 bg-black/40 border-white/10 text-white" data-testid="input-finance-from" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">To</label>
                <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 bg-black/40 border-white/10 text-white" data-testid="input-finance-to" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Event type</label>
                <Select value={type} onValueChange={v => setType(v as typeof type)}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white" data-testid="select-finance-type"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    <SelectItem value="all" className="text-white hover:bg-white/5">All events</SelectItem>
                    <SelectItem value="payment" className="text-white hover:bg-white/5">Payments</SelectItem>
                    <SelectItem value="refund" className="text-white hover:bg-white/5">Refunds</SelectItem>
                    <SelectItem value="waive" className="text-white hover:bg-white/5">Waives</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={downloadAll}
                className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
                data-testid="button-export-all-ledger"
              >
                <Download className="w-4 h-4" /> Export ledger
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Club-wide totals by currency */}
        {totalsRows.length > 0 && (
          <Card className="bg-black/30 border-white/10">
            <CardHeader>
              <CardTitle className="text-base">Club totals</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {totalsRows.map(t => (
                  <div key={t.currency} className="border border-white/10 rounded-lg p-4 bg-black/20" data-testid={`totals-${t.currency}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground uppercase tracking-wider">{t.currency}</span>
                      <span className="text-xs text-muted-foreground">{t.leviesCount} levy{t.leviesCount === 1 ? '' : 's'} · {t.chargesCount} charge{t.chargesCount === 1 ? '' : 's'}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-[11px] text-muted-foreground uppercase">Collected</div>
                        <div className="text-green-400 font-semibold">{fmtMoney(t.collected, t.currency)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted-foreground uppercase">Outstanding</div>
                        <div className="text-amber-400 font-semibold">{fmtMoney(t.outstanding, t.currency)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted-foreground uppercase">Refunded</div>
                        <div className="text-rose-300">{fmtMoney(t.refunded, t.currency)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-muted-foreground uppercase">Waived</div>
                        <div className="text-purple-300">{fmtMoney(t.waived, t.currency)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Revenue & tax — per-currency pivot from the unified financial ledger */}
        <Card className="bg-black/30 border-white/10">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
              <span>Revenue &amp; tax by currency</span>
              <div className="flex items-center gap-2">
                <Label htmlFor="pivot-currency" className="text-xs text-muted-foreground">Pivot</Label>
                <Select value={pivotCurrency} onValueChange={setPivotCurrency}>
                  <SelectTrigger id="pivot-currency" className="w-32 bg-black/40 border-white/10 text-white" data-testid="select-pivot-currency"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    <SelectItem value="all" className="text-white hover:bg-white/5">All currencies</SelectItem>
                    {revPivotCurrencies.map(c => (
                      <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={downloadRevenuePivot}
                  disabled={!orgId}
                  className="border-white/10 text-white hover:bg-white/5 gap-1.5"
                  data-testid="button-export-revenue-pivot"
                >
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {revByCurrencyQuery.isLoading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : revByCurrencyQuery.isError ? (
              <div className="py-8 text-center text-rose-300 text-sm">
                {(revByCurrencyQuery.error as Error)?.message ?? 'Failed to load revenue pivot.'}
              </div>
            ) : revTotals.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm" data-testid="text-no-revenue">
                No revenue events recorded in the financial ledger yet.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {revTotals.map(t => (
                    <div key={t.currency} className="border border-white/10 rounded-lg p-4 bg-black/20" data-testid={`revenue-totals-${t.currency}`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground uppercase tracking-wider">{t.currency}</span>
                        <span className="text-xs text-muted-foreground">{t.eventCount} event{t.eventCount === 1 ? '' : 's'}</span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <div className="text-[11px] text-muted-foreground uppercase">Revenue</div>
                          <div className="text-emerald-400 font-semibold">{fmtMoney(t.revenue, t.currency)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] text-muted-foreground uppercase">Tax</div>
                          <div className="text-sky-300 font-semibold">{fmtMoney(t.tax, t.currency)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                {revPivotRows.length > 0 && (
                  <div className="border border-white/10 rounded-lg overflow-x-auto">
                    <table className="w-full text-sm" data-testid="table-revenue-pivot">
                      <thead className="bg-black/40 text-xs text-muted-foreground uppercase tracking-wider">
                        <tr>
                          <th className="text-left px-3 py-2">Currency</th>
                          <th className="text-left px-3 py-2">Event type</th>
                          <th className="text-right px-3 py-2">Revenue</th>
                          <th className="text-right px-3 py-2">Tax</th>
                          <th className="text-right px-3 py-2">Events</th>
                        </tr>
                      </thead>
                      <tbody>
                        {revPivotRows.map(r => (
                          <tr key={`${r.currency}-${r.eventType}`} className="border-t border-white/5" data-testid={`row-rev-${r.currency}-${r.eventType}`}>
                            <td className="px-3 py-2 text-white">{r.currency}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{r.eventType}</td>
                            <td className="px-3 py-2 text-right text-emerald-400">{fmtMoney(r.revenue, r.currency)}</td>
                            <td className="px-3 py-2 text-right text-sky-300">{fmtMoney(r.tax, r.currency)}</td>
                            <td className="px-3 py-2 text-right text-xs text-muted-foreground">{r.eventCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <RevenueByCurrencyEmailSchedulePanel orgId={orgId ?? 0} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Per-levy table */}
        <Card className="bg-black/30 border-white/10">
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
              <span>All levies</span>
              {summaryQuery.data && (
                <span className="text-xs font-normal text-muted-foreground" data-testid="text-filter-count">
                  Showing {filteredLevies.length} of {totalLeviesCount}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summaryQuery.data && totalLeviesCount > 0 && (
              <div className="mb-4 grid gap-3 md:grid-cols-2 lg:grid-cols-5 items-end" data-testid="ledger-filters">
                <div className="lg:col-span-2">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Search name</label>
                  <Input
                    type="text"
                    value={filterName}
                    onChange={e => setFilterName(e.target.value)}
                    placeholder="e.g. Annual subscription"
                    className="mt-1 bg-black/40 border-white/10 text-white"
                    data-testid="input-filter-name"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Created from</label>
                  <Input
                    type="date"
                    value={filterFrom}
                    onChange={e => setFilterFrom(e.target.value)}
                    className="mt-1 bg-black/40 border-white/10 text-white"
                    data-testid="input-filter-from"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Created to</label>
                  <Input
                    type="date"
                    value={filterTo}
                    onChange={e => setFilterTo(e.target.value)}
                    className="mt-1 bg-black/40 border-white/10 text-white"
                    data-testid="input-filter-to"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</label>
                  <Select value={filterCurrency} onValueChange={setFilterCurrency}>
                    <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white" data-testid="select-filter-currency"><SelectValue /></SelectTrigger>
                    <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                      <SelectItem value="all" className="text-white hover:bg-white/5">All currencies</SelectItem>
                      {availableCurrencies.map(c => (
                        <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="md:col-span-2 lg:col-span-5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="outstanding-only"
                      checked={outstandingOnly}
                      onCheckedChange={setOutstandingOnly}
                      data-testid="switch-outstanding-only"
                    />
                    <Label htmlFor="outstanding-only" className="text-sm text-white cursor-pointer">
                      Outstanding only
                    </Label>
                  </div>
                  {filtersActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={clearFilters}
                      className="text-muted-foreground hover:text-white hover:bg-white/5 h-8 text-xs"
                      data-testid="button-clear-filters"
                    >
                      Clear filters
                    </Button>
                  )}
                </div>
              </div>
            )}
            {summaryQuery.isLoading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">Loading…</div>
            ) : summaryQuery.isError ? (
              <div className="py-8 text-center text-rose-300 text-sm">
                {(summaryQuery.error as Error)?.message ?? 'Failed to load levies.'}
              </div>
            ) : summaryQuery.data && filteredLevies.length > 0 ? (
              <div className="border border-white/10 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-black/40 text-xs text-muted-foreground uppercase tracking-wider">
                    <tr>
                      <th className="text-left px-3 py-2">Levy</th>
                      <th className="text-left px-3 py-2">Charges</th>
                      <th className="text-right px-3 py-2">Collected</th>
                      <th className="text-right px-3 py-2">Outstanding</th>
                      <th className="text-right px-3 py-2">Refunded</th>
                      <th className="text-right px-3 py-2">Waived</th>
                      <th className="text-left px-3 py-2">Due</th>
                      <th className="text-right px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLevies.map(l => {
                      const sym = currencySymbol[l.currency] ?? '';
                      return (
                        <tr key={l.id} className="border-t border-white/5" data-testid={`row-levy-${l.id}`}>
                          <td className="px-3 py-2 text-white">
                            <div className="font-medium">{l.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {sym}{parseFloat(l.amount).toLocaleString()} · {l.scope ?? 'all'}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            <div className="flex flex-wrap gap-1">
                              <Badge className="bg-white/5 border border-white/10 text-white text-[10px]">{l.chargesCount} total</Badge>
                              {l.paidCount > 0 && <Badge className="bg-green-500/20 text-green-400 border-green-500/30 border text-[10px]">{l.paidCount} paid</Badge>}
                              {l.partialCount > 0 && <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30 border text-[10px]">{l.partialCount} partial</Badge>}
                              {l.unpaidCount > 0 && <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 border text-[10px]">{l.unpaidCount} unpaid</Badge>}
                              {l.waivedCount > 0 && <Badge className="bg-purple-500/20 text-purple-300 border-purple-500/30 border text-[10px]">{l.waivedCount} waived</Badge>}
                              {l.refundedCount > 0 && <Badge className="bg-rose-500/20 text-rose-300 border-rose-500/30 border text-[10px]">{l.refundedCount} refunded</Badge>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right text-green-400">{fmtMoney(l.collected, l.currency)}</td>
                          <td className="px-3 py-2 text-right text-amber-400">{fmtMoney(l.outstanding, l.currency)}</td>
                          <td className="px-3 py-2 text-right text-rose-300">{fmtMoney(l.refunded, l.currency)}</td>
                          <td className="px-3 py-2 text-right text-purple-300">{fmtMoney(l.waivedAmount, l.currency)}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(l.dueDate)}</td>
                          <td className="px-3 py-2 text-right">
                            <Link href={`${BASE}/club-members?openLevy=${l.id}`}>
                              <Button size="sm" variant="ghost" className="text-amber-300 hover:bg-white/5 h-7 text-xs gap-1" data-testid={`link-open-levy-${l.id}`}>
                                Open <ExternalLink className="w-3 h-3" />
                              </Button>
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : summaryQuery.data && totalLeviesCount > 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm" data-testid="text-no-matches">
                No levies match the current filters.{filtersActive && (
                  <> <button onClick={clearFilters} className="text-amber-300 underline hover:text-amber-200" data-testid="button-clear-filters-empty">Clear filters</button></>
                )}
              </div>
            ) : (
              <div className="py-8 text-center text-muted-foreground text-sm">No levies have been created yet.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface RevenueByCurrencyScheduleRow {
  id: number;
  organizationId: number;
  frequency: 'weekly' | 'monthly';
  recipients: string[];
  enabled: boolean;
  lastSentAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}
interface RevenueByCurrencyRunRow {
  id: number;
  scheduleId: number;
  sentAt: string;
  periodStart: string | null;
  periodEnd: string;
  recipients: string[];
  rowCount: number;
  currencyCount: number;
  status: 'sent' | 'failed' | 'skipped';
  errorMessage: string | null;
}
interface RevenueByCurrencyScheduleResponse {
  schedule: RevenueByCurrencyScheduleRow | null;
  history: RevenueByCurrencyRunRow[];
}

function RevenueByCurrencyEmailSchedulePanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const q = useQuery<RevenueByCurrencyScheduleResponse>({
    queryKey: ['revenue-by-currency-email-schedule', orgId],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/revenue-by-currency/email-schedule`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!orgId,
  });

  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('weekly');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [hydratedFor, setHydratedFor] = useState<number | null>(null);

  const sched = q.data?.schedule ?? null;
  const hydrationKey = sched ? sched.id : -1;
  if (hydratedFor !== hydrationKey && q.isSuccess) {
    if (sched) {
      setFrequency(sched.frequency);
      setRecipients(sched.recipients.join(', '));
      setEnabled(sched.enabled);
    } else {
      setFrequency('weekly');
      setRecipients('');
      setEnabled(true);
    }
    setHydratedFor(hydrationKey);
  }

  const parsedRecipients = recipients
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const invalid = parsedRecipients.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));

  const saveMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/revenue-by-currency/email-schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ frequency, recipients: parsedRecipients, enabled }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Revenue pivot schedule saved', description: enabled ? 'Treasurers will receive the next pivot CSV automatically.' : 'Schedule paused; no emails will be sent.' });
      queryClient.invalidateQueries({ queryKey: ['revenue-by-currency-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const deleteMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/revenue-by-currency/email-schedule`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    },
    onSuccess: () => {
      toast({ title: 'Schedule removed' });
      queryClient.invalidateQueries({ queryKey: ['revenue-by-currency-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Remove failed', description: e.message, variant: 'destructive' }),
  });

  const [previewOpen, setPreviewOpen] = useState(false);
  const previewMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/revenue-by-currency/email-schedule/preview`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{
        subject: string; html: string; filename: string;
        rowCount: number; currencyCount: number;
        recipients: string[]; frequency: 'weekly' | 'monthly';
        periodStart: string; periodEnd: string;
        csvSample: { header: string; rows: string[]; totalRows: number; sampleSize: number } | null;
      }>;
    },
    onSuccess: () => setPreviewOpen(true),
    onError: (e: Error) => toast({ title: 'Preview failed', description: e.message, variant: 'destructive' }),
  });

  const sendNowMut = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/members-360/revenue-by-currency/email-schedule/send-now`, { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{ status: string; rowCount: number; currencyCount: number; recipients: string[]; errorMessage?: string }>;
    },
    onSuccess: (res) => {
      if (res.status === 'sent') {
        toast({ title: 'Pivot sent', description: `Delivered ${res.rowCount} pivot row${res.rowCount === 1 ? '' : 's'} across ${res.currencyCount} currenc${res.currencyCount === 1 ? 'y' : 'ies'} to ${res.recipients.length} recipient${res.recipients.length === 1 ? '' : 's'}.` });
      } else {
        toast({ title: 'Send failed', description: res.errorMessage ?? res.status, variant: 'destructive' });
      }
      queryClient.invalidateQueries({ queryKey: ['revenue-by-currency-email-schedule', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Send failed', description: e.message, variant: 'destructive' }),
  });

  const history = q.data?.history ?? [];
  const fmtPeriod = (start: string | null, end: string) => {
    const s = start ? new Date(start).toLocaleDateString() : '—';
    const e = new Date(end).toLocaleDateString();
    return `${s} → ${e}`;
  };
  const canSave = parsedRecipients.length > 0 && parsedRecipients.length <= 20 && invalid.length === 0;

  if (!orgId) return null;

  return (
    <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3" data-testid="revenue-by-currency-email-schedule">
      <div className="flex items-start gap-2">
        <Mail className="w-4 h-4 text-emerald-300 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-white">Email this pivot to treasurers on a schedule</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Send the per-currency revenue &amp; tax CSV automatically each week or month so reconciliation can happen entirely from the inbox.
          </p>
        </div>
      </div>
      {q.isLoading ? (
        <div className="py-3 text-center text-xs text-muted-foreground">Loading schedule…</div>
      ) : q.isError ? (
        <div className="py-3 text-center text-xs text-rose-300">Failed to load schedule.</div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-muted-foreground">Frequency</Label>
              <Select value={frequency} onValueChange={v => setFrequency(v as 'weekly' | 'monthly')}>
                <SelectTrigger className="mt-1 h-8 text-xs bg-black/40 border-white/10 text-white" data-testid="select-revenue-pivot-frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-xs text-white cursor-pointer h-8">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => setEnabled(e.target.checked)}
                  data-testid="toggle-revenue-pivot-enabled"
                  className="accent-emerald-500"
                />
                {enabled ? 'Enabled' : 'Paused'}
              </label>
            </div>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Recipients (comma- or whitespace-separated)</Label>
            <Textarea
              value={recipients}
              onChange={e => setRecipients(e.target.value)}
              placeholder="treasurer@club.com, secretary@club.com"
              className="mt-1 bg-black/40 border-white/10 text-white text-xs min-h-[60px]"
              data-testid="input-revenue-pivot-recipients"
            />
            <div className="text-[10px] mt-1">
              {invalid.length > 0 ? (
                <span className="text-rose-300">Invalid: {invalid.join(', ')}</span>
              ) : parsedRecipients.length > 0 ? (
                <span className="text-muted-foreground">{parsedRecipients.length} recipient{parsedRecipients.length === 1 ? '' : 's'}</span>
              ) : (
                <span className="text-muted-foreground">Enter at least one email address.</span>
              )}
            </div>
          </div>
          {sched && (
            <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              <span>Last sent: {sched.lastSentAt ? new Date(sched.lastSentAt).toLocaleString() : 'never'}</span>
              <span>Next run: {sched.nextRunAt ? new Date(sched.nextRunAt).toLocaleString() : '—'}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => saveMut.mutate()}
              disabled={!canSave || saveMut.isPending}
              data-testid="button-save-revenue-pivot-schedule"
              className="bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              {saveMut.isPending ? 'Saving…' : sched ? 'Update schedule' : 'Create schedule'}
            </Button>
            {sched && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => previewMut.mutate()}
                  disabled={previewMut.isPending}
                  data-testid="button-preview-revenue-pivot"
                  className="border-white/10 text-white gap-1.5"
                >
                  <Eye className="w-3.5 h-3.5" />
                  {previewMut.isPending ? 'Loading…' : 'Preview'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendNowMut.mutate()}
                  disabled={sendNowMut.isPending || !sched.enabled || sched.recipients.length === 0}
                  data-testid="button-send-revenue-pivot-now"
                  className="border-white/10 text-white"
                >
                  {sendNowMut.isPending ? 'Sending…' : 'Send now'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { if (confirm('Remove the per-currency revenue pivot email schedule?')) deleteMut.mutate(); }}
                  disabled={deleteMut.isPending}
                  data-testid="button-delete-revenue-pivot-schedule"
                  className="text-rose-300 hover:text-rose-200"
                >
                  Remove
                </Button>
              </>
            )}
          </div>
          {sched && (
            <div className="border border-white/10 rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-black/40 text-[10px] text-muted-foreground uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-2 py-1.5">Sent</th>
                    <th className="text-left px-2 py-1.5">Period</th>
                    <th className="text-left px-2 py-1.5">Currencies</th>
                    <th className="text-left px-2 py-1.5">Rows</th>
                    <th className="text-left px-2 py-1.5">Recipients</th>
                    <th className="text-left px-2 py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr><td colSpan={6} className="px-2 py-3 text-center text-muted-foreground" data-testid="revenue-pivot-history-empty">No pivot emails sent yet.</td></tr>
                  ) : history.map(h => {
                    const tone = h.status === 'sent' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                      : h.status === 'failed' ? 'bg-red-500/20 text-red-300 border-red-500/30'
                      : 'bg-amber-500/20 text-amber-300 border-amber-500/30';
                    return (
                      <tr key={h.id} className="border-t border-white/5" data-testid={`revenue-pivot-history-row-${h.id}`}>
                        <td className="px-2 py-1.5 text-white whitespace-nowrap">{new Date(h.sentAt).toLocaleString()}</td>
                        <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{fmtPeriod(h.periodStart, h.periodEnd)}</td>
                        <td className="px-2 py-1.5 text-white">{h.currencyCount}</td>
                        <td className="px-2 py-1.5 text-white">{h.rowCount}</td>
                        <td className="px-2 py-1.5 text-muted-foreground max-w-[14rem] truncate" title={h.recipients.join(', ')}>
                          {h.recipients.length} ({h.recipients.join(', ')})
                        </td>
                        <td className="px-2 py-1.5">
                          <Badge className={`${tone} border text-[10px]`}>{h.status}</Badge>
                          {h.errorMessage && <div className="text-[10px] text-rose-300 mt-1 truncate max-w-[14rem]" title={h.errorMessage}>{h.errorMessage}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-3xl bg-[#0a1628] border-white/10 text-white" data-testid="dialog-revenue-pivot-preview">
          <DialogHeader>
            <DialogTitle className="text-white">Preview — next pivot email</DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">
              This is what the next scheduled email would look like if it were sent right now. Nothing has been sent and no run was recorded.
            </DialogDescription>
          </DialogHeader>
          {previewMut.data && (
            <div className="space-y-3 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Subject</div>
                  <div className="text-white" data-testid="text-preview-subject">{previewMut.data.subject}</div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Recipients</div>
                  <div className="text-white" data-testid="text-preview-recipients">
                    {previewMut.data.recipients.length === 0 ? '—' : previewMut.data.recipients.join(', ')}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Period</div>
                  <div className="text-white">
                    {new Date(previewMut.data.periodStart).toLocaleString()} → {new Date(previewMut.data.periodEnd).toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">CSV contents</div>
                  <div className="text-white" data-testid="text-preview-counts">
                    <span className="text-emerald-400 font-semibold">{previewMut.data.rowCount}</span> row{previewMut.data.rowCount === 1 ? '' : 's'}
                    {' · '}
                    <span className="text-emerald-400 font-semibold">{previewMut.data.currencyCount}</span> currenc{previewMut.data.currencyCount === 1 ? 'y' : 'ies'}
                  </div>
                </div>
              </div>
              {previewMut.data.csvSample && (
                <div data-testid="revenue-pivot-preview-csv-sample">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                    CSV sample ({previewMut.data.filename})
                  </div>
                  <pre className="border border-white/10 rounded-md bg-black/60 text-white text-[11px] leading-snug font-mono p-2 overflow-x-auto whitespace-pre">
{[previewMut.data.csvSample.header, ...previewMut.data.csvSample.rows].join('\n') || '(empty)'}
                  </pre>
                  <div className="text-[10px] text-muted-foreground mt-1" data-testid="revenue-pivot-preview-csv-footer">
                    Showing {previewMut.data.csvSample.sampleSize} of {previewMut.data.csvSample.totalRows} row{previewMut.data.csvSample.totalRows === 1 ? '' : 's'}
                    {previewMut.data.csvSample.totalRows > previewMut.data.csvSample.sampleSize ? ' (sample truncated)' : ''}.
                  </div>
                </div>
              )}
              <div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Rendered body</div>
                <div className="border border-white/10 rounded-md bg-white overflow-hidden">
                  <iframe
                    title="Email body preview"
                    srcDoc={previewMut.data.html}
                    sandbox=""
                    className="w-full h-[420px] bg-white"
                    data-testid="iframe-preview-body"
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPreviewOpen(false)}
              className="border-white/10 text-white"
              data-testid="button-close-preview"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
