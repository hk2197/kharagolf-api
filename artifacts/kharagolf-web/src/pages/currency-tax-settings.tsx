import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import { Globe, Plus, Trash2, RefreshCw, TrendingUp, TrendingDown, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const API = (p: string) => `${BASE_URL}/api${p}`;

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

const COMMON_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CHF', 'NZD', 'ZAR'];

interface CurrencyProfile {
  organizationId: number;
  baseCurrency: string;
  displayCurrencies: string[];
  allowPlayerPreferredCurrency: boolean;
  defaultTaxProfileId: number | null;
  fxMarkupPct: string;
}

interface TaxRate {
  id: number; taxProfileId: number;
  componentName: string; ratePct: string;
  productClass: string | null; customerClass: string | null;
  sortOrder: number;
}

interface TaxProfile {
  id: number; organizationId: number; name: string;
  jurisdictionKind: 'gst' | 'vat' | 'sales_tax' | 'none';
  country: string; region: string | null; invoiceLabel: string | null;
  isDefault: boolean; isActive: boolean;
  exemptionRules: Record<string, unknown>;
  rates: TaxRate[];
}

interface FxRate {
  id: number; baseCurrency: string; quoteCurrency: string;
  rate: string; source: string; fetchedAt: string;
}

interface ProcessorConfig {
  id: number; organizationId: number; currency: string;
  processor: 'razorpay' | 'stripe' | 'manual';
  isActive: boolean; accountRef: string | null;
}

interface FxGainLossRow {
  bookedCurrency: string; settledCurrency: string;
  totalBooked: string; totalSettled: string;
  totalGainLoss: string; txCount: number;
}

interface FxUnrealisedRow {
  exposureCurrency: string;
  baseCurrency: string;
  outstandingAmount: number;
  bookedRate: number;
  currentRate: number;
  currentRateSource: string;
  baseValueNow: number;
  baseValueBooked: number;
  unrealisedGainLoss: number;
  chargeCount: number;
}

export default function CurrencyTaxSettingsPage() {
  const orgId = useActiveOrgId();
  if (!orgId) return <div className="p-6">Select an organization first.</div>;
  return <Inner orgId={orgId} />;
}

function Inner({ orgId }: { orgId: number }) {
  return (
    <div className="container max-w-6xl py-8 space-y-6">
      <div className="flex items-center gap-3">
        <Globe className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Currency &amp; Tax Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure base &amp; display currencies, tax profiles, FX rates, and per-currency payment processors.
          </p>
        </div>
      </div>

      <Tabs defaultValue="currency">
        <TabsList>
          <TabsTrigger value="currency">Currency</TabsTrigger>
          <TabsTrigger value="tax">Tax profiles</TabsTrigger>
          <TabsTrigger value="fx">FX rates</TabsTrigger>
          <TabsTrigger value="processors">Processors</TabsTrigger>
          <TabsTrigger value="report">FX P&amp;L</TabsTrigger>
        </TabsList>

        <TabsContent value="currency"><CurrencyTab orgId={orgId} /></TabsContent>
        <TabsContent value="tax"><TaxTab orgId={orgId} /></TabsContent>
        <TabsContent value="fx"><FxTab orgId={orgId} /></TabsContent>
        <TabsContent value="processors"><ProcessorsTab orgId={orgId} /></TabsContent>
        <TabsContent value="report"><ReportTab orgId={orgId} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Currency tab ───────────────────────────────────────────────────────────

function CurrencyTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['currency-profile', orgId],
    queryFn: () => api<CurrencyProfile>(API(`/organizations/${orgId}/currency-tax/profile`)),
  });
  const [form, setForm] = useState<CurrencyProfile | null>(null);
  const profile = form ?? data ?? null;
  const save = useMutation({
    mutationFn: (body: Partial<CurrencyProfile>) =>
      api<CurrencyProfile>(API(`/organizations/${orgId}/currency-tax/profile`), {
        method: 'PUT', body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['currency-profile', orgId] });
      toast({ title: 'Saved' });
      setForm(null);
    },
    onError: (e) => toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' }),
  });

  if (isLoading || !profile) return <Loader2 className="h-6 w-6 animate-spin" />;

  const toggleDisplay = (cur: string) => {
    const list = profile.displayCurrencies.includes(cur)
      ? profile.displayCurrencies.filter((c) => c !== cur)
      : [...profile.displayCurrencies, cur];
    setForm({ ...profile, displayCurrencies: list });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Club currency profile</CardTitle>
        <CardDescription>Base currency is what the club books revenue in. Display currencies are what players can see.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Base currency</Label>
            <Select
              value={profile.baseCurrency}
              onValueChange={(v) => setForm({ ...profile, baseCurrency: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {COMMON_CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>FX markup % (added on player display)</Label>
            <Input
              type="number" step="0.001"
              value={profile.fxMarkupPct}
              onChange={(e) => setForm({ ...profile, fxMarkupPct: e.target.value })}
            />
          </div>
        </div>

        <div>
          <Label>Display currencies</Label>
          <div className="flex flex-wrap gap-2 mt-2">
            {COMMON_CURRENCIES.map((c) => (
              <button key={c} type="button" onClick={() => toggleDisplay(c)}>
                <Badge variant={profile.displayCurrencies.includes(c) ? 'default' : 'outline'}>
                  {c}
                </Badge>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            checked={profile.allowPlayerPreferredCurrency}
            onCheckedChange={(v) => setForm({ ...profile, allowPlayerPreferredCurrency: v })}
          />
          <Label>Let players pick a preferred display currency (FX disclosure shown on receipts)</Label>
        </div>

        <Button onClick={() => save.mutate(profile)} disabled={save.isPending}>
          {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Tax profiles tab ───────────────────────────────────────────────────────

function TaxTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: profiles } = useQuery({
    queryKey: ['tax-profiles', orgId],
    queryFn: () => api<TaxProfile[]>(API(`/organizations/${orgId}/currency-tax/tax-profiles`)),
  });
  const [newName, setNewName] = useState('');
  const create = useMutation({
    mutationFn: (name: string) => api(API(`/organizations/${orgId}/currency-tax/tax-profiles`), {
      method: 'POST', body: JSON.stringify({ name, jurisdictionKind: 'vat', country: 'IN' }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tax-profiles', orgId] }); setNewName(''); },
  });
  const del = useMutation({
    mutationFn: (id: number) => api(API(`/organizations/${orgId}/currency-tax/tax-profiles/${id}`), { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tax-profiles', orgId] }); toast({ title: 'Deleted' }); },
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<TaxProfile> }) =>
      api(API(`/organizations/${orgId}/currency-tax/tax-profiles/${id}`), { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tax-profiles', orgId] }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>New tax profile</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Input placeholder="e.g. UK VAT 20%" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button onClick={() => newName && create.mutate(newName)} disabled={create.isPending || !newName}>
            <Plus className="mr-2 h-4 w-4" /> Create
          </Button>
        </CardContent>
      </Card>

      {(profiles ?? []).map((p) => (
        <Card key={p.id}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                {p.name}
                {p.isDefault && <Badge>default</Badge>}
                <Badge variant="outline">{p.jurisdictionKind}</Badge>
                <Badge variant="outline">{p.country}{p.region ? ` / ${p.region}` : ''}</Badge>
              </CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline"
                  onClick={() => patch.mutate({ id: p.id, body: { isDefault: !p.isDefault } })}>
                  {p.isDefault ? 'Unset default' : 'Make default'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(p.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <RatesEditor orgId={orgId} profile={p} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RatesEditor({ orgId, profile }: { orgId: number; profile: TaxProfile }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const add = useMutation({
    mutationFn: () => api(API(`/organizations/${orgId}/currency-tax/tax-profiles/${profile.id}/rates`), {
      method: 'POST', body: JSON.stringify({ componentName: name, ratePct: Number(rate) }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tax-profiles', orgId] }); setName(''); setRate(''); },
  });
  const del = useMutation({
    mutationFn: (rateId: number) =>
      api(API(`/organizations/${orgId}/currency-tax/tax-profiles/${profile.id}/rates/${rateId}`), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tax-profiles', orgId] }),
  });
  return (
    <div className="space-y-2">
      {profile.rates.map((r) => (
        <div key={r.id} className="flex items-center justify-between border rounded px-3 py-2">
          <div className="flex gap-3 items-center">
            <span className="font-medium">{r.componentName}</span>
            <Badge variant="secondary">{r.ratePct}%</Badge>
            {r.productClass && <Badge variant="outline">product: {r.productClass}</Badge>}
            {r.customerClass && <Badge variant="outline">customer: {r.customerClass}</Badge>}
          </div>
          <Button size="sm" variant="ghost" onClick={() => del.mutate(r.id)}><Trash2 className="h-4 w-4" /></Button>
        </div>
      ))}
      <div className="flex gap-2 pt-2">
        <Input placeholder="Component (e.g. CGST)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="%" type="number" step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} />
        <Button onClick={() => name && rate && add.mutate()} disabled={add.isPending}>Add</Button>
      </div>
    </div>
  );
}

// ── FX tab ─────────────────────────────────────────────────────────────────

const STALE_FX_MS = 24 * 60 * 60 * 1000;

function formatRelativeTime(from: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - from.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  let label: string;
  if (sec < 60) label = `${sec}s`;
  else if (min < 60) label = `${min}m`;
  else if (hr < 48) label = `${hr}h`;
  else label = `${day}d`;
  return future ? `in ${label}` : `${label} ago`;
}

function RecentSnapshots({ rates }: { rates: FxRate[] }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const latestPerPair = new Map<string, string>();
  for (const r of rates) {
    const key = `${r.baseCurrency}->${r.quoteCurrency}`;
    const prev = latestPerPair.get(key);
    if (!prev || new Date(r.fetchedAt).getTime() > new Date(prev).getTime()) {
      latestPerPair.set(key, r.fetchedAt);
    }
  }
  const stalePairs = Array.from(latestPerPair.entries())
    .filter(([, t]) => now.getTime() - new Date(t).getTime() > STALE_FX_MS)
    .map(([k]) => k);

  if (rates.length === 0) {
    return <div className="text-sm text-muted-foreground">No snapshots yet — fallback rates will be used.</div>;
  }

  return (
    <div className="space-y-2 text-sm">
      {stalePairs.length > 0 && (
        <div
          className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          data-testid="fx-stale-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-medium">
              {stalePairs.length} FX {stalePairs.length === 1 ? 'pair is' : 'pairs are'} older than 24 hours
            </div>
            <div className="text-xs opacity-80">
              {stalePairs.map((p) => p.replace('->', ' → ')).join(', ')}. Click &ldquo;Refresh now&rdquo; above to update.
            </div>
          </div>
        </div>
      )}
      <div className="space-y-1">
        {rates.slice(0, 50).map((r) => {
          const fetched = new Date(r.fetchedAt);
          const ageMs = now.getTime() - fetched.getTime();
          const pairKey = `${r.baseCurrency}->${r.quoteCurrency}`;
          const isLatestForPair = latestPerPair.get(pairKey) === r.fetchedAt;
          const isStale = isLatestForPair && ageMs > STALE_FX_MS;
          return (
            <div
              key={r.id}
              className={`grid grid-cols-5 gap-2 border-b py-1 ${isStale ? 'bg-amber-50 dark:bg-amber-950/40' : ''}`}
              data-testid={`fx-row-${r.id}`}
            >
              <div className="flex items-center gap-1">
                {r.baseCurrency} → {r.quoteCurrency}
                {isStale && (
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
                    aria-label="Rate older than 24 hours"
                  />
                )}
              </div>
              <div className="font-mono">{r.rate}</div>
              <div className="text-muted-foreground">{r.source}</div>
              <div
                className={`col-span-2 ${isStale ? 'text-amber-700 dark:text-amber-300 font-medium' : 'text-muted-foreground'}`}
                title={fetched.toLocaleString()}
                data-testid={`fx-row-${r.id}-age`}
              >
                {formatRelativeTime(fetched, now)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FxTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({
    queryKey: ['fx-rates', orgId],
    queryFn: () => api<FxRate[]>(API(`/organizations/${orgId}/currency-tax/fx-rates`)),
  });
  const [base, setBase] = useState('USD');
  const [quote, setQuote] = useState('INR');
  const [rate, setRate] = useState('');
  const add = useMutation({
    mutationFn: () => api(API(`/organizations/${orgId}/currency-tax/fx-rates`), {
      method: 'POST', body: JSON.stringify({ baseCurrency: base, quoteCurrency: quote, rate: Number(rate), source: 'manual' }),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fx-rates', orgId] }); setRate(''); },
  });
  const refresh = useMutation({
    mutationFn: () => api<{ ok: boolean; pairs: number; rates: Record<string, number>; baseCurrency: string }>(
      API(`/organizations/${orgId}/currency-tax/fx-rates/refresh`),
      { method: 'POST' },
    ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['fx-rates', orgId] });
      qc.invalidateQueries({ queryKey: ['fx-gain-loss', orgId] });
      toast({ title: 'FX rates refreshed', description: `${r.pairs} pair${r.pairs === 1 ? '' : 's'} updated from open.er-api.com.` });
    },
    onError: (e) => toast({ title: 'Refresh failed', description: (e as Error).message, variant: 'destructive' }),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle>Auto-refresh</CardTitle>
              <CardDescription>
                Mid-market rates are refreshed daily from open.er-api.com (no API key required)
                for the org&apos;s base currency paired against each display currency. Run it now if needed.
              </CardDescription>
            </div>
            <Button onClick={() => refresh.mutate()} disabled={refresh.isPending} data-testid="button-refresh-fx-rates">
              {refresh.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh now
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader><CardTitle>Record FX snapshot</CardTitle></CardHeader>
        <CardContent className="flex gap-2 items-end">
          <div><Label>Base</Label>
            <Select value={base} onValueChange={setBase}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{COMMON_CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>Quote</Label>
            <Select value={quote} onValueChange={setQuote}><SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{COMMON_CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="flex-1"><Label>1 {base} = ? {quote}</Label>
            <Input type="number" step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} />
          </div>
          <Button onClick={() => add.mutate()} disabled={!rate || add.isPending}>
            <RefreshCw className="mr-2 h-4 w-4" /> Save snapshot
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent snapshots</CardTitle></CardHeader>
        <CardContent>
          <RecentSnapshots rates={data ?? []} />
        </CardContent>
      </Card>
    </div>
  );
}

// ── Processors tab ─────────────────────────────────────────────────────────

function ProcessorsTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['processor-configs', orgId],
    queryFn: () => api<{ configs: ProcessorConfig[]; razorpaySupportedCurrencies: string[] }>(
      API(`/organizations/${orgId}/currency-tax/processor-configs`),
    ),
  });
  const [currency, setCurrency] = useState('USD');
  const [processor, setProcessor] = useState<'razorpay' | 'stripe' | 'manual'>('stripe');
  const upsert = useMutation({
    mutationFn: () => api(API(`/organizations/${orgId}/currency-tax/processor-configs`), {
      method: 'PUT', body: JSON.stringify({ currency, processor, isActive: true }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['processor-configs', orgId] }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(API(`/organizations/${orgId}/currency-tax/processor-configs/${id}`), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['processor-configs', orgId] }),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Processor routing</CardTitle>
          <CardDescription>
            Default: Razorpay handles {data?.razorpaySupportedCurrencies.join(', ')}; Stripe handles all other currencies.
            Override here per-currency.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2 items-end">
            <div><Label>Currency</Label>
              <Select value={currency} onValueChange={setCurrency}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>{COMMON_CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Processor</Label>
              <Select value={processor} onValueChange={(v) => setProcessor(v as 'razorpay' | 'stripe' | 'manual')}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="razorpay">Razorpay</SelectItem>
                  <SelectItem value="stripe">Stripe</SelectItem>
                  <SelectItem value="manual">Manual</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => upsert.mutate()}>Save override</Button>
          </div>

          <div className="space-y-1">
            {(data?.configs ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between border rounded px-3 py-2">
                <div className="flex gap-2 items-center">
                  <Badge>{c.currency}</Badge>
                  <span className="font-medium capitalize">{c.processor}</span>
                  {!c.isActive && <Badge variant="outline">inactive</Badge>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => del.mutate(c.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            {!data?.configs.length && <div className="text-sm text-muted-foreground">No overrides — defaults apply.</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Report tab ─────────────────────────────────────────────────────────────

export function ReportTab({ orgId }: { orgId: number }) {
  const { data } = useQuery({
    queryKey: ['fx-gain-loss', orgId],
    queryFn: () => api<{
      summary: FxGainLossRow[];
      realised: FxGainLossRow[];
      unrealised: FxUnrealisedRow[];
      recent: Array<{ id: number; bookedCurrency: string; settledCurrency: string; bookedAmount: string; settledAmount: string; gainLoss: string; sourceType: string; createdAt: string }>;
    }>(
      API(`/organizations/${orgId}/currency-tax/fx-gain-loss`),
    ),
  });
  const realised = data?.realised ?? data?.summary ?? [];
  const unrealised = data?.unrealised ?? [];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Realised FX gain / loss</CardTitle>
          <CardDescription>
            Locked-in difference between booked (org-base) and settled (processor) amounts on transactions
            that have already cleared.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!realised.length && (
            <div className="text-sm text-muted-foreground" data-testid="text-no-realised">
              No FX-crossing settlements have been recorded yet.
            </div>
          )}
          <div className="space-y-2">
            {realised.map((r) => {
              const gl = parseFloat(r.totalGainLoss);
              const Icon = gl >= 0 ? TrendingUp : TrendingDown;
              return (
                <div key={`${r.bookedCurrency}-${r.settledCurrency}`}
                     className="flex items-center justify-between border rounded px-3 py-2"
                     data-testid={`realised-${r.bookedCurrency}-${r.settledCurrency}`}>
                  <div className="flex gap-2 items-center">
                    <Badge>{r.bookedCurrency}</Badge>
                    <span>→</span>
                    <Badge>{r.settledCurrency}</Badge>
                    <span className="text-sm text-muted-foreground">{r.txCount} tx</span>
                  </div>
                  <div className={`flex items-center gap-2 font-mono ${gl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    <Icon className="h-4 w-4" /> {gl.toFixed(2)} {r.bookedCurrency}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Unrealised FX gain / loss</CardTitle>
          <CardDescription>
            Mark-to-market estimate for open levy charges in foreign currencies, valued at the latest spot
            rate vs the rate at the time of booking. Becomes realised when the charge settles.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!unrealised.length && (
            <div className="text-sm text-muted-foreground" data-testid="text-no-unrealised">
              No open foreign-currency exposure.
            </div>
          )}
          <div className="space-y-2">
            {unrealised.map((u) => {
              const Icon = u.unrealisedGainLoss >= 0 ? TrendingUp : TrendingDown;
              return (
                <div key={`${u.exposureCurrency}-${u.baseCurrency}`}
                     className="flex items-center justify-between border rounded px-3 py-2"
                     data-testid={`unrealised-${u.exposureCurrency}-${u.baseCurrency}`}>
                  <div className="flex gap-2 items-center flex-wrap">
                    <Badge>{u.exposureCurrency}</Badge>
                    <span>→</span>
                    <Badge>{u.baseCurrency}</Badge>
                    <span className="text-sm text-muted-foreground">
                      {u.chargeCount} open · {u.outstandingAmount.toFixed(2)} {u.exposureCurrency}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      booked @ {u.bookedRate} · spot @ {u.currentRate} ({u.currentRateSource})
                    </span>
                  </div>
                  <div className={`flex items-center gap-2 font-mono ${u.unrealisedGainLoss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    <Icon className="h-4 w-4" /> {u.unrealisedGainLoss.toFixed(2)} {u.baseCurrency}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
