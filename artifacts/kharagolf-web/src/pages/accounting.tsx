import { useState, useCallback } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LineChart, Line, CartesianGrid, Legend,
} from 'recharts';
import {
  DollarSign, TrendingUp, AlertCircle, RefreshCw, CheckCircle2, XCircle, Clock,
  Link2, Unlink, Settings2, FileText, BarChart3, ArrowRight, Loader2, ChevronDown,
  Download, Plus, Trash2, LayoutDashboard, BookOpen,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const api = (path: string) => `${BASE}/api${path}`;

type Platform = 'xero' | 'quickbooks';

interface AccountingConnection {
  id: number;
  platform: Platform;
  tenantId: string | null;
  tenantName: string | null;
  isActive: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
}

interface CoaMapping {
  id: number;
  eventType: string;
  accountCode: string;
  accountName: string | null;
  taxCode: string | null;
  taxRate: string | null;
  description: string | null;
}

interface LedgerEntry {
  id: number;
  eventType: string;
  sourceModule: string;
  sourceRef: string | null;
  memberName: string | null;
  description: string;
  amount: string;
  currency: string;
  taxAmount: string;
  transactionDate: string;
  syncStatus: 'pending' | 'synced' | 'failed' | 'skipped';
  externalRef: string | null;
  syncError: string | null;
  createdAt: string;
}

interface DashboardData {
  dateFrom: string;
  dateTo: string;
  totals: {
    revenue: string;
    tax: string;
    transactions: number;
    refunds: string;
    pendingSync: number;
  };
  byDepartment: Array<{ eventType: string; totalAmount: string; totalTax: string; txCount: number }>;
  syncStatus: Array<{ syncStatus: string; txCount: number; totalAmount: string }>;
  dailySeries: Array<{ date: string; totalAmount: string; txCount: number }>;
}

interface ReconciliationData {
  summary: {
    totalEntries: number;
    totalAmount: string;
    pendingCount: number;
    pendingAmount: string;
    failedCount: number;
    failedAmount: string;
    skippedCount: number;
  };
  pending: LedgerEntry[];
  failed: LedgerEntry[];
  skipped: LedgerEntry[];
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  pos_sale: 'POS Sales',
  booking_fee: 'Booking Fees',
  membership_due: 'Membership Dues',
  lesson_fee: 'Lesson Fees',
  fb_order: 'F&B Orders',
  event_fee: 'Event Fees',
  rental_fee: 'Rental Fees',
  commission: 'Commissions',
  gift_card_sale: 'Gift Card Sales',
  gift_card_redemption: 'Gift Card Redemptions',
  refund: 'Refunds',
  other: 'Other',
};

const EVENT_TYPES = Object.keys(EVENT_TYPE_LABELS);

const SYNC_STATUS_COLORS: Record<string, string> = {
  pending: '#f59e0b',
  synced: '#10b981',
  failed: '#ef4444',
  skipped: '#6b7280',
};

const DEPT_COLORS = [
  '#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#14b8a6',
];

function fmtAmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function syncBadge(status: string) {
  switch (status) {
    case 'synced': return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Synced</Badge>;
    case 'pending': return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">Pending</Badge>;
    case 'failed': return <Badge className="bg-red-500/20 text-red-400 border-red-500/30">Failed</Badge>;
    case 'skipped': return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30">Skipped</Badge>;
    default: return <Badge>{status}</Badge>;
  }
}

type Tab = 'dashboard' | 'connections' | 'coa-map' | 'ledger' | 'reconciliation';

export default function AccountingPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? (user as any)?.organizationId;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>('dashboard');
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerEventType, setLedgerEventType] = useState('');
  const [ledgerSyncStatus, setLedgerSyncStatus] = useState('');
  const [reconcileTab, setReconcileTab] = useState<'pending' | 'failed' | 'skipped'>('pending');

  // connect modal state
  const [connectPlatform, setConnectPlatform] = useState<Platform | null>(null);
  const [connectForm, setConnectForm] = useState({ tenantName: '', accessToken: '', refreshToken: '' });

  // COA edit state
  const [coaEdits, setCoaEdits] = useState<Record<string, Partial<CoaMapping>>>({});
  const [coaSaving, setCoaSaving] = useState(false);

  // manual ledger entry
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [newEntry, setNewEntry] = useState({
    eventType: 'other', sourceModule: 'manual', description: '',
    amount: '', currency: 'USD', taxAmount: '', transactionDate: new Date().toISOString().slice(0, 10),
  });

  const connectionsQ = useQuery<AccountingConnection[]>({
    queryKey: ['accounting-connections', orgId],
    queryFn: async () => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/connections`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
    enabled: !!orgId,
  });

  const coaQ = useQuery<CoaMapping[]>({
    queryKey: ['accounting-coa', orgId],
    queryFn: async () => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/coa-map`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
    enabled: !!orgId,
  });

  const dashQ = useQuery<DashboardData>({
    queryKey: ['accounting-dashboard', orgId, dateFrom, dateTo],
    queryFn: async () => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/dashboard?dateFrom=${dateFrom}&dateTo=${dateTo}`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
    enabled: !!orgId,
  });

  const ledgerQ = useQuery<{ data: LedgerEntry[]; total: number; page: number; pageSize: number }>({
    queryKey: ['accounting-ledger', orgId, dateFrom, dateTo, ledgerPage, ledgerEventType, ledgerSyncStatus],
    queryFn: async () => {
      const params = new URLSearchParams({
        dateFrom, dateTo,
        page: String(ledgerPage),
        limit: '50',
        ...(ledgerEventType && { eventType: ledgerEventType }),
        ...(ledgerSyncStatus && { syncStatus: ledgerSyncStatus }),
      });
      const r = await fetch(api(`/organizations/${orgId}/accounting/ledger?${params}`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
    enabled: !!orgId,
  });

  const reconcileQ = useQuery<ReconciliationData>({
    queryKey: ['accounting-reconcile', orgId, dateFrom, dateTo],
    queryFn: async () => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/reconciliation?dateFrom=${dateFrom}&dateTo=${dateTo}`));
      if (!r.ok) throw new Error('Failed');
      return r.json();
    },
    enabled: !!orgId,
  });

  const syncMutation = useMutation({
    mutationFn: async (platform: Platform) => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/connections/${platform}/sync`), { method: 'POST' });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Sync failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: 'Sync complete', description: `${data.synced} synced, ${data.skipped} skipped.` });
      qc.invalidateQueries({ queryKey: ['accounting-ledger'] });
      qc.invalidateQueries({ queryKey: ['accounting-reconcile'] });
      qc.invalidateQueries({ queryKey: ['accounting-dashboard'] });
      qc.invalidateQueries({ queryKey: ['accounting-connections'] });
    },
    onError: (e: Error) => toast({ title: 'Sync failed', description: e.message, variant: 'destructive' }),
  });

  const ingestMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/ledger/ingest`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: 'Ingested', description: `${data.ingested} new entries added.` });
      qc.invalidateQueries({ queryKey: ['accounting-ledger'] });
      qc.invalidateQueries({ queryKey: ['accounting-dashboard'] });
      qc.invalidateQueries({ queryKey: ['accounting-reconcile'] });
    },
    onError: (e: Error) => toast({ title: 'Ingest failed', description: e.message, variant: 'destructive' }),
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/connections`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: connectPlatform, ...connectForm }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Connected', description: `${connectPlatform} connected successfully.` });
      setConnectPlatform(null);
      setConnectForm({ tenantName: '', accessToken: '', refreshToken: '' });
      qc.invalidateQueries({ queryKey: ['accounting-connections'] });
    },
    onError: (e: Error) => toast({ title: 'Connect failed', description: e.message, variant: 'destructive' }),
  });

  const disconnectMutation = useMutation({
    mutationFn: async (platform: Platform) => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/connections/${platform}`), { method: 'DELETE' });
      if (!r.ok) throw new Error('Failed');
    },
    onSuccess: () => {
      toast({ title: 'Disconnected' });
      qc.invalidateQueries({ queryKey: ['accounting-connections'] });
    },
  });

  const saveCoaMutation = useMutation({
    mutationFn: async (mappings: Partial<CoaMapping>[]) => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/coa-map`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Saved', description: 'Chart of accounts mappings saved.' });
      setCoaEdits({});
      qc.invalidateQueries({ queryKey: ['accounting-coa'] });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const addEntryMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(api(`/organizations/${orgId}/accounting/ledger`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEntry),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Entry added' });
      setShowAddEntry(false);
      setNewEntry({ eventType: 'other', sourceModule: 'manual', description: '', amount: '', currency: 'USD', taxAmount: '', transactionDate: new Date().toISOString().slice(0, 10) });
      qc.invalidateQueries({ queryKey: ['accounting-ledger'] });
      qc.invalidateQueries({ queryKey: ['accounting-dashboard'] });
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const saveCoaEdits = useCallback(async () => {
    const existing = coaQ.data || [];
    const existingByType = Object.fromEntries(existing.map(m => [m.eventType, m]));
    const toSave = EVENT_TYPES
      .map(et => {
        const edit = coaEdits[et];
        const current = existingByType[et];
        const merged = { ...current, ...edit, eventType: et };
        if (!merged.accountCode) return null;
        return merged;
      })
      .filter(Boolean);
    if (toSave.length === 0) {
      toast({ title: 'Nothing to save', description: 'Add account codes first.' });
      return;
    }
    saveCoaMutation.mutate(toSave as any);
  }, [coaEdits, coaQ.data]);

  const getCoaField = (eventType: string, field: keyof CoaMapping) => {
    const edit = coaEdits[eventType];
    if (edit && field in edit) return (edit as any)[field] ?? '';
    const existing = coaQ.data?.find(m => m.eventType === eventType);
    return (existing as any)?.[field] ?? '';
  };

  const setCoaField = (eventType: string, field: keyof CoaMapping, val: string) => {
    setCoaEdits(prev => ({ ...prev, [eventType]: { ...prev[eventType], [field]: val } }));
  };

  const connections = connectionsQ.data || [];
  const xero = connections.find(c => c.platform === 'xero');
  const qb = connections.find(c => c.platform === 'quickbooks');
  const dash = dashQ.data;

  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType }> = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'connections', label: 'Integrations', icon: Link2 },
    { id: 'coa-map', label: 'Chart of Accounts', icon: BookOpen },
    { id: 'ledger', label: 'Transaction Ledger', icon: FileText },
    { id: 'reconciliation', label: 'Reconciliation', icon: AlertCircle },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Accounting & Finance</h1>
          <p className="text-sm text-muted-foreground mt-1">Connect to Xero or QuickBooks, sync transactions, and view financial reports.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => ingestMutation.mutate()} disabled={ingestMutation.isPending}>
            {ingestMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Ingest Revenue Events
          </Button>
        </div>
      </div>

      {/* Date Range */}
      <div className="flex gap-3 items-center bg-card/50 border border-white/10 rounded-xl p-4">
        <span className="text-sm text-muted-foreground font-medium">Date Range:</span>
        <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-40 bg-background h-8 text-sm" />
        <span className="text-muted-foreground">to</span>
        <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-40 bg-background h-8 text-sm" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-card/50 border border-white/10 rounded-xl p-1 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${tab === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'}`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── DASHBOARD TAB ── */}
      {tab === 'dashboard' && (
        <div className="space-y-6">
          {dashQ.isLoading && <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}
          {dash && (
            <>
              {/* KPI Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-card/50 border border-white/10 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider mb-2">
                    <DollarSign className="w-3.5 h-3.5" /> Total Revenue
                  </div>
                  <p className="text-2xl font-bold text-white">{fmtAmt(dash.totals.revenue)}</p>
                  <p className="text-xs text-muted-foreground mt-1">{dash.totals.transactions} transactions</p>
                </div>
                <div className="bg-card/50 border border-white/10 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider mb-2">
                    <TrendingUp className="w-3.5 h-3.5" /> Tax Collected
                  </div>
                  <p className="text-2xl font-bold text-white">{fmtAmt(dash.totals.tax)}</p>
                </div>
                <div className="bg-card/50 border border-white/10 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wider mb-2">
                    <XCircle className="w-3.5 h-3.5 text-red-400" /> Refunds
                  </div>
                  <p className="text-2xl font-bold text-red-400">{fmtAmt(dash.totals.refunds)}</p>
                </div>
                <div className="bg-card/50 border border-amber-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-amber-400 text-xs uppercase tracking-wider mb-2">
                    <Clock className="w-3.5 h-3.5" /> Pending Sync
                  </div>
                  <p className="text-2xl font-bold text-amber-400">{dash.totals.pendingSync}</p>
                  <p className="text-xs text-muted-foreground mt-1">transactions</p>
                </div>
              </div>

              {/* Charts Row */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Daily Revenue */}
                <div className="bg-card/50 border border-white/10 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-white mb-4">Daily Revenue</h3>
                  {dash.dailySeries.length === 0 ? (
                    <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">No data for this period</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={dash.dailySeries.map(d => ({ ...d, amount: parseFloat(d.totalAmount) }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={v => v.slice(5)} />
                        <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} />
                        <Tooltip formatter={(v: number) => [fmtAmt(v), 'Revenue']} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
                        <Line type="monotone" dataKey="amount" stroke="#10b981" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>

                {/* Revenue by Department */}
                <div className="bg-card/50 border border-white/10 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-white mb-4">Revenue by Department</h3>
                  {dash.byDepartment.length === 0 ? (
                    <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">No data</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={dash.byDepartment.map((d, i) => ({ name: EVENT_TYPE_LABELS[d.eventType] || d.eventType, value: parseFloat(d.totalAmount), color: DEPT_COLORS[i % DEPT_COLORS.length] }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                        <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#9ca3af' }} />
                        <YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} />
                        <Tooltip formatter={(v: number) => [fmtAmt(v), 'Revenue']} contentStyle={{ background: '#1f2937', border: '1px solid #374151', borderRadius: 8 }} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {dash.byDepartment.map((_, i) => <Cell key={i} fill={DEPT_COLORS[i % DEPT_COLORS.length]} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {/* Sync Status */}
              <div className="bg-card/50 border border-white/10 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-white mb-4">Sync Status Overview</h3>
                <div className="flex flex-wrap gap-3">
                  {dash.syncStatus.map(s => (
                    <div key={s.syncStatus} className="flex items-center gap-3 bg-background/50 rounded-lg px-4 py-3 border border-white/5">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SYNC_STATUS_COLORS[s.syncStatus] || '#9ca3af' }} />
                      <div>
                        <p className="text-xs text-muted-foreground capitalize">{s.syncStatus}</p>
                        <p className="text-sm font-semibold text-white">{s.txCount} txns</p>
                        <p className="text-xs text-muted-foreground">{fmtAmt(s.totalAmount)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CONNECTIONS TAB ── */}
      {tab === 'connections' && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Connect your club to Xero or QuickBooks to automatically sync financial transactions.</p>

          {(['xero', 'quickbooks'] as Platform[]).map(platform => {
            const conn = platform === 'xero' ? xero : qb;
            const label = platform === 'xero' ? 'Xero' : 'QuickBooks';
            const logo = platform === 'xero' ? '🔷' : '🟢';
            return (
              <div key={platform} className="bg-card/50 border border-white/10 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-12 h-12 rounded-xl bg-background flex items-center justify-center text-2xl">{logo}</div>
                  <div>
                    <h3 className="font-semibold text-white">{label}</h3>
                    {conn ? (
                      <div className="space-y-0.5 mt-0.5">
                        <p className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Connected {conn.tenantName ? `— ${conn.tenantName}` : ''}</p>
                        {conn.lastSyncAt && <p className="text-xs text-muted-foreground">Last sync: {new Date(conn.lastSyncAt).toLocaleString()} · {conn.lastSyncStatus}</p>}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-0.5">Not connected</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  {conn ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => syncMutation.mutate(platform)} disabled={syncMutation.isPending}>
                        {syncMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                        <span className="ml-1.5">Sync Now</span>
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => disconnectMutation.mutate(platform)} disabled={disconnectMutation.isPending}>
                        <Unlink className="w-3.5 h-3.5 mr-1.5" /> Disconnect
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => setConnectPlatform(platform)}>
                      <Link2 className="w-3.5 h-3.5 mr-1.5" /> Connect {label}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}

          {/* Connect Modal */}
          {connectPlatform && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <div className="bg-card border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-4">
                <h2 className="text-lg font-bold text-white">Connect {connectPlatform === 'xero' ? 'Xero' : 'QuickBooks'}</h2>
                <p className="text-sm text-muted-foreground">Enter your OAuth credentials. In production, this connects via the provider's OAuth flow.</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Tenant / Company Name</label>
                    <Input value={connectForm.tenantName} onChange={e => setConnectForm(p => ({ ...p, tenantName: e.target.value }))} placeholder="My Golf Club Ltd" className="bg-background" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Access Token</label>
                    <Input value={connectForm.accessToken} onChange={e => setConnectForm(p => ({ ...p, accessToken: e.target.value }))} placeholder="OAuth access token" className="bg-background" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Refresh Token</label>
                    <Input value={connectForm.refreshToken} onChange={e => setConnectForm(p => ({ ...p, refreshToken: e.target.value }))} placeholder="OAuth refresh token" className="bg-background" />
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button variant="outline" className="flex-1" onClick={() => setConnectPlatform(null)}>Cancel</Button>
                  <Button className="flex-1" onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending || !connectForm.tenantName}>
                    {connectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}Connect
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── CHART OF ACCOUNTS TAB ── */}
      {tab === 'coa-map' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Map each revenue category to the corresponding account code in your accounting platform. Apply VAT/GST tax codes and rates per transaction type.</p>
            <Button size="sm" onClick={saveCoaEdits} disabled={saveCoaMutation.isPending || Object.keys(coaEdits).length === 0}>
              {saveCoaMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}Save Changes
            </Button>
          </div>
          <div className="bg-card/50 border border-white/10 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs text-muted-foreground uppercase tracking-wider">
                  <th className="text-left px-4 py-3 font-medium">Revenue Category</th>
                  <th className="text-left px-4 py-3 font-medium">Account Code</th>
                  <th className="text-left px-4 py-3 font-medium">Account Name</th>
                  <th className="text-left px-4 py-3 font-medium">Tax Code</th>
                  <th className="text-left px-4 py-3 font-medium">Tax Rate %</th>
                </tr>
              </thead>
              <tbody>
                {EVENT_TYPES.map((et, i) => (
                  <tr key={et} className={`border-b border-white/5 ${i % 2 === 0 ? '' : 'bg-white/[0.02]'} hover:bg-white/5 transition-colors`}>
                    <td className="px-4 py-3 text-white font-medium">{EVENT_TYPE_LABELS[et]}</td>
                    <td className="px-4 py-2">
                      <Input
                        value={getCoaField(et, 'accountCode')}
                        onChange={e => setCoaField(et, 'accountCode', e.target.value)}
                        placeholder="e.g. 4000"
                        className="h-8 bg-background text-sm w-28"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        value={getCoaField(et, 'accountName')}
                        onChange={e => setCoaField(et, 'accountName', e.target.value)}
                        placeholder="Revenue account"
                        className="h-8 bg-background text-sm"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        value={getCoaField(et, 'taxCode')}
                        onChange={e => setCoaField(et, 'taxCode', e.target.value)}
                        placeholder="e.g. OUTPUT"
                        className="h-8 bg-background text-sm w-28"
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Input
                        type="number"
                        min="0" max="100" step="0.01"
                        value={getCoaField(et, 'taxRate')}
                        onChange={e => setCoaField(et, 'taxRate', e.target.value)}
                        placeholder="0"
                        className="h-8 bg-background text-sm w-20"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">Changes are only saved when you click "Save Changes". Tax rates are applied during sync to calculate VAT/GST for each transaction type.</p>
        </div>
      )}

      {/* ── LEDGER TAB ── */}
      {tab === 'ledger' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="flex gap-3 flex-wrap items-center">
            <select
              value={ledgerEventType}
              onChange={e => { setLedgerEventType(e.target.value); setLedgerPage(1); }}
              className="h-9 px-3 rounded-lg border border-white/10 bg-card text-sm text-white"
            >
              <option value="">All Types</option>
              {EVENT_TYPES.map(et => <option key={et} value={et}>{EVENT_TYPE_LABELS[et]}</option>)}
            </select>
            <select
              value={ledgerSyncStatus}
              onChange={e => { setLedgerSyncStatus(e.target.value); setLedgerPage(1); }}
              className="h-9 px-3 rounded-lg border border-white/10 bg-card text-sm text-white"
            >
              <option value="">All Sync Status</option>
              <option value="pending">Pending</option>
              <option value="synced">Synced</option>
              <option value="failed">Failed</option>
              <option value="skipped">Skipped</option>
            </select>
            <Button size="sm" onClick={() => setShowAddEntry(true)}>
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Add Entry
            </Button>
            {ledgerQ.data && (
              <span className="text-xs text-muted-foreground ml-auto">
                {ledgerQ.data.total} entries
              </span>
            )}
          </div>

          {/* Add Entry Modal */}
          {showAddEntry && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
              <div className="bg-card border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl space-y-3">
                <h2 className="text-lg font-bold text-white">Add Manual Ledger Entry</h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="col-span-2">
                    <label className="text-xs text-muted-foreground mb-1 block">Description *</label>
                    <Input value={newEntry.description} onChange={e => setNewEntry(p => ({ ...p, description: e.target.value }))} placeholder="Description" className="bg-background" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Type</label>
                    <select value={newEntry.eventType} onChange={e => setNewEntry(p => ({ ...p, eventType: e.target.value }))} className="w-full h-9 px-3 rounded-lg border border-white/10 bg-background text-sm text-white">
                      {EVENT_TYPES.map(et => <option key={et} value={et}>{EVENT_TYPE_LABELS[et]}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Date *</label>
                    <Input type="date" value={newEntry.transactionDate} onChange={e => setNewEntry(p => ({ ...p, transactionDate: e.target.value }))} className="bg-background" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Amount *</label>
                    <Input type="number" value={newEntry.amount} onChange={e => setNewEntry(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="bg-background" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Currency</label>
                    <Input value={newEntry.currency} onChange={e => setNewEntry(p => ({ ...p, currency: e.target.value }))} placeholder="USD" className="bg-background" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Tax Amount</label>
                    <Input type="number" value={newEntry.taxAmount} onChange={e => setNewEntry(p => ({ ...p, taxAmount: e.target.value }))} placeholder="0.00" className="bg-background" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Source Module</label>
                    <Input value={newEntry.sourceModule} onChange={e => setNewEntry(p => ({ ...p, sourceModule: e.target.value }))} placeholder="manual" className="bg-background" />
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button variant="outline" className="flex-1" onClick={() => setShowAddEntry(false)}>Cancel</Button>
                  <Button className="flex-1" onClick={() => addEntryMutation.mutate()} disabled={addEntryMutation.isPending || !newEntry.description || !newEntry.amount}>
                    {addEntryMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}Add Entry
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="bg-card/50 border border-white/10 rounded-xl overflow-hidden">
            {ledgerQ.isLoading ? (
              <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="text-left px-4 py-3 font-medium">Date</th>
                    <th className="text-left px-4 py-3 font-medium">Description</th>
                    <th className="text-left px-4 py-3 font-medium">Type</th>
                    <th className="text-left px-4 py-3 font-medium">Module</th>
                    <th className="text-right px-4 py-3 font-medium">Amount</th>
                    <th className="text-right px-4 py-3 font-medium">Tax</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Ext. Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledgerQ.data?.data || []).length === 0 ? (
                    <tr><td colSpan={8} className="text-center py-10 text-muted-foreground">No transactions found. Use "Ingest Revenue Events" to pull data.</td></tr>
                  ) : (ledgerQ.data?.data || []).map((row, i) => (
                    <tr key={row.id} className={`border-b border-white/5 ${i % 2 === 0 ? '' : 'bg-white/[0.02]'} hover:bg-white/5 transition-colors`}>
                      <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{row.transactionDate}</td>
                      <td className="px-4 py-2.5 text-white max-w-xs truncate">{row.description}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{EVENT_TYPE_LABELS[row.eventType] || row.eventType}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground capitalize">{row.sourceModule}</td>
                      <td className="px-4 py-2.5 text-right text-white font-mono">{fmtAmt(row.amount)}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground font-mono text-xs">{fmtAmt(row.taxAmount)}</td>
                      <td className="px-4 py-2.5">{syncBadge(row.syncStatus)}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[120px]">{row.externalRef || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {ledgerQ.data && ledgerQ.data.total > ledgerQ.data.pageSize && (
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" disabled={ledgerPage <= 1} onClick={() => setLedgerPage(p => p - 1)}>Previous</Button>
              <span className="text-xs text-muted-foreground">Page {ledgerPage} of {Math.ceil(ledgerQ.data.total / ledgerQ.data.pageSize)}</span>
              <Button variant="outline" size="sm" disabled={ledgerPage >= Math.ceil(ledgerQ.data.total / ledgerQ.data.pageSize)} onClick={() => setLedgerPage(p => p + 1)}>Next</Button>
            </div>
          )}
        </div>
      )}

      {/* ── RECONCILIATION TAB ── */}
      {tab === 'reconciliation' && (
        <div className="space-y-4">
          {reconcileQ.isLoading && <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>}
          {reconcileQ.data && (
            <>
              {/* Summary Cards */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-card/50 border border-white/10 rounded-xl p-4">
                  <p className="text-xs text-muted-foreground mb-1">Total Entries</p>
                  <p className="text-xl font-bold text-white">{reconcileQ.data.summary.totalEntries}</p>
                  <p className="text-xs text-muted-foreground">{fmtAmt(reconcileQ.data.summary.totalAmount)}</p>
                </div>
                <div className="bg-card/50 border border-amber-500/20 rounded-xl p-4">
                  <p className="text-xs text-amber-400 mb-1">Pending Sync</p>
                  <p className="text-xl font-bold text-amber-400">{reconcileQ.data.summary.pendingCount}</p>
                  <p className="text-xs text-muted-foreground">{fmtAmt(reconcileQ.data.summary.pendingAmount)}</p>
                </div>
                <div className="bg-card/50 border border-red-500/20 rounded-xl p-4">
                  <p className="text-xs text-red-400 mb-1">Failed</p>
                  <p className="text-xl font-bold text-red-400">{reconcileQ.data.summary.failedCount}</p>
                  <p className="text-xs text-muted-foreground">{fmtAmt(reconcileQ.data.summary.failedAmount)}</p>
                </div>
                <div className="bg-card/50 border border-gray-500/20 rounded-xl p-4">
                  <p className="text-xs text-muted-foreground mb-1">Skipped (No COA)</p>
                  <p className="text-xl font-bold text-gray-400">{reconcileQ.data.summary.skippedCount}</p>
                </div>
              </div>

              {/* Sub-tabs */}
              <div className="flex gap-1 bg-card/50 border border-white/10 rounded-xl p-1 w-fit">
                {(['pending', 'failed', 'skipped'] as const).map(t => (
                  <button key={t} onClick={() => setReconcileTab(t)} className={`px-4 py-1.5 rounded-lg text-sm font-medium capitalize transition-all ${reconcileTab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-white hover:bg-white/5'}`}>
                    {t} ({t === 'pending' ? reconcileQ.data.summary.pendingCount : t === 'failed' ? reconcileQ.data.summary.failedCount : reconcileQ.data.summary.skippedCount})
                  </button>
                ))}
              </div>

              {/* Table */}
              <div className="bg-card/50 border border-white/10 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-xs text-muted-foreground uppercase tracking-wider">
                      <th className="text-left px-4 py-3 font-medium">Date</th>
                      <th className="text-left px-4 py-3 font-medium">Description</th>
                      <th className="text-left px-4 py-3 font-medium">Type</th>
                      <th className="text-right px-4 py-3 font-medium">Amount</th>
                      <th className="text-left px-4 py-3 font-medium">Status</th>
                      <th className="text-left px-4 py-3 font-medium">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(reconcileQ.data[reconcileTab] || []).length === 0 ? (
                      <tr><td colSpan={6} className="text-center py-8 text-muted-foreground">No {reconcileTab} entries. Great!</td></tr>
                    ) : (reconcileQ.data[reconcileTab] || []).map((row, i) => (
                      <tr key={row.id} className={`border-b border-white/5 ${i % 2 === 0 ? '' : 'bg-white/[0.02]'}`}>
                        <td className="px-4 py-2.5 text-muted-foreground text-xs whitespace-nowrap">{row.transactionDate}</td>
                        <td className="px-4 py-2.5 text-white max-w-xs truncate">{row.description}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{EVENT_TYPE_LABELS[row.eventType] || row.eventType}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtAmt(row.amount)}</td>
                        <td className="px-4 py-2.5">{syncBadge(row.syncStatus)}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{row.syncError || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
