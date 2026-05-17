import { useState, useEffect, useCallback } from 'react';
import { useGetMe, type AuthUser } from '@workspace/api-client-react';
import { motion } from 'framer-motion';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { DollarSign, TrendingUp, AlertCircle, RefreshCw, Download, Trophy, BarChart3, Link2, Copy, CheckCircle2, XCircle, Clock, Bell, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', GBP: '£', AED: 'د.إ', EUR: '€', SGD: 'S$', AUD: 'A$',
};

function fmtAmount(amount: number | null, currency: string) {
  if (amount == null) return '—';
  const sym = CURRENCY_SYMBOLS[currency] ?? currency;
  return `${sym}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Transaction {
  id: string;
  kind: 'tournament' | 'league';
  name: string;
  eventId: number;
  eventName: string;
  paymentStatus: string;
  amount: number | null;
  currency: string;
  paymentId: string | null;
  paymentLinkUrl: string | null;
  date: string;
}

interface RevenueByCurrency {
  collected: number;
  outstanding: number;
  refunded: number;
}

interface MonthlyRevenuePoint {
  month: string;
  collected: number;
  currency: string;
}

interface EventSummary {
  eventId: number;
  eventName: string;
  kind: 'tournament' | 'league';
  currency: string;
  totalPlayers: number;
  paid: number;
  unpaid: number;
  refunded: number;
  collected: number;
  outstanding: number;
}

interface DashboardData {
  transactions: Transaction[];
  revenueByCurrency: Record<string, RevenueByCurrency>;
  totalPaid: number;
  totalUnpaid: number;
  totalRefunded: number;
  monthlyRevenue: MonthlyRevenuePoint[];
  eventSummaries: EventSummary[];
}

const STATUS_CONFIG: Record<string, { label: string; className: string; icon: React.FC<{ className?: string }> }> = {
  paid: { label: 'Paid', className: 'bg-green-500/20 text-green-400 border-green-500/30', icon: CheckCircle2 },
  unpaid: { label: 'Unpaid', className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30', icon: Clock },
  pending: { label: 'Pending', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30', icon: Clock },
  refunded: { label: 'Refunded', className: 'bg-purple-500/20 text-purple-400 border-purple-500/30', icon: XCircle },
};

type SortField = 'date' | 'name' | 'eventName' | 'amount' | 'paymentStatus';
type SortDir = 'asc' | 'desc';

function SortIcon({ field, sortField, sortDir }: { field: SortField; sortField: SortField; sortDir: SortDir }) {
  if (field !== sortField) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-30" />;
  return sortDir === 'asc'
    ? <ArrowUp className="w-3 h-3 ml-1 text-primary" />
    : <ArrowDown className="w-3 h-3 ml-1 text-primary" />;
}

export default function PaymentsDashboard() {
  const { data: user } = useGetMe();
  const typedUser = user as AuthUser | undefined;
  const orgId = typedUser?.organizationId ?? undefined;
  const { toast } = useToast();

  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterKind, setFilterKind] = useState<string>('all');
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const load = useCallback(async () => {
    if (!orgId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/payments/dashboard?orgId=${orgId}`, { credentials: 'include' });
      if (res.ok) setData(await res.json() as DashboardData);
    } finally {
      setIsLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const filtered = (data?.transactions ?? [])
    .filter(tx => {
      if (filterStatus !== 'all' && tx.paymentStatus !== filterStatus) return false;
      if (filterKind !== 'all' && tx.kind !== filterKind) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!tx.name.toLowerCase().includes(q) && !tx.eventName.toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'date': cmp = new Date(a.date).getTime() - new Date(b.date).getTime(); break;
        case 'name': cmp = a.name.localeCompare(b.name); break;
        case 'eventName': cmp = a.eventName.localeCompare(b.eventName); break;
        case 'amount': cmp = (a.amount ?? 0) - (b.amount ?? 0); break;
        case 'paymentStatus': cmp = a.paymentStatus.localeCompare(b.paymentStatus); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

  const exportCSV = () => {
    const headers = ['Date', 'Player/Member', 'Event Type', 'Event Name', 'Amount', 'Currency', 'Status', 'Payment ID'];
    const rows = filtered.map(tx => [
      new Date(tx.date).toLocaleDateString(),
      tx.name, tx.kind, tx.eventName,
      tx.amount ?? '', tx.currency, tx.paymentStatus, tx.paymentId ?? '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyLink = (url: string) => {
    navigator.clipboard.writeText(url);
    toast({ title: 'Payment link copied to clipboard' });
  };

  const handleRemindUnpaid = async () => {
    if (!orgId) return;
    if (!confirm(`Send email reminders to all ${data?.totalUnpaid ?? 0} unpaid players/members?`)) return;
    setReminding(true);
    try {
      const res = await fetch('/api/payments/remind-unpaid', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }),
      });
      const result = await res.json() as { sent: number; total: number; errors?: string[] };
      if (res.ok) {
        toast({ title: `Reminders sent to ${result.sent} of ${result.total} unpaid players` });
      } else {
        toast({ title: 'Failed to send reminders', variant: 'destructive' });
      }
    } finally {
      setReminding(false);
    }
  };

  const chartData = (data?.monthlyRevenue ?? []).map(m => ({
    month: m.month.slice(0, 7),
    collected: m.collected,
    currency: m.currency,
    label: new Date(m.month + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
  }));

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">Payments</h1>
          <p className="text-muted-foreground mt-1">Revenue dashboard — tournament &amp; league entry fees, refunds, and payment links.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(data?.totalUnpaid ?? 0) > 0 && (
            <Button
              variant="outline"
              onClick={handleRemindUnpaid}
              disabled={reminding}
              className="border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
            >
              <Bell className="w-4 h-4 mr-2" />
              {reminding ? 'Sending…' : `Remind Unpaid (${data?.totalUnpaid ?? 0})`}
            </Button>
          )}
          <Button variant="outline" onClick={load} className="border-white/10 text-muted-foreground hover:text-white">
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button variant="outline" onClick={exportCSV} className="border-white/10 text-muted-foreground hover:text-white">
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="glass-panel p-6 rounded-2xl">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl bg-green-500/15 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
            </div>
            <span className="text-sm font-semibold text-muted-foreground">Paid</span>
          </div>
          <p className="text-3xl font-bold text-white">{data?.totalPaid ?? 0}</p>
          {data && Object.entries(data.revenueByCurrency).length > 0 && (
            <div className="mt-2 space-y-0.5">
              {Object.entries(data.revenueByCurrency).map(([cur, rev]) => rev.collected > 0 && (
                <p key={cur} className="text-sm text-green-400">{fmtAmount(rev.collected, cur)} collected</p>
              ))}
            </div>
          )}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="glass-panel p-6 rounded-2xl">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl bg-yellow-500/15 flex items-center justify-center">
              <Clock className="w-5 h-5 text-yellow-400" />
            </div>
            <span className="text-sm font-semibold text-muted-foreground">Outstanding</span>
          </div>
          <p className="text-3xl font-bold text-white">{data?.totalUnpaid ?? 0}</p>
          {data && Object.entries(data.revenueByCurrency).length > 0 && (
            <div className="mt-2 space-y-0.5">
              {Object.entries(data.revenueByCurrency).map(([cur, rev]) => rev.outstanding > 0 && (
                <p key={cur} className="text-sm text-yellow-400">{fmtAmount(rev.outstanding, cur)} outstanding</p>
              ))}
            </div>
          )}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="glass-panel p-6 rounded-2xl">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl bg-purple-500/15 flex items-center justify-center">
              <XCircle className="w-5 h-5 text-purple-400" />
            </div>
            <span className="text-sm font-semibold text-muted-foreground">Refunded</span>
          </div>
          <p className="text-3xl font-bold text-white">{data?.totalRefunded ?? 0}</p>
          {data && Object.entries(data.revenueByCurrency).length > 0 && (
            <div className="mt-2 space-y-0.5">
              {Object.entries(data.revenueByCurrency).map(([cur, rev]) => rev.refunded > 0 && (
                <p key={cur} className="text-sm text-purple-400">{fmtAmount(rev.refunded, cur)} refunded</p>
              ))}
            </div>
          )}
        </motion.div>
      </div>

      {/* Per-Event Breakdown Cards */}
      {(data?.eventSummaries ?? []).length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-5">
            <BarChart3 className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-white">Per-Event Breakdown</h3>
            <span className="text-xs text-muted-foreground ml-auto">{data!.eventSummaries.length} events</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {data!.eventSummaries.map(ev => (
              <div key={`${ev.kind}-${ev.eventId}`} className="p-4 rounded-xl bg-white/3 border border-white/5">
                <div className="flex items-center gap-2 mb-3">
                  {ev.kind === 'tournament'
                    ? <Trophy className="w-4 h-4 text-primary shrink-0" />
                    : <BarChart3 className="w-4 h-4 text-blue-400 shrink-0" />}
                  <p className="text-sm font-semibold text-white truncate">{ev.eventName}</p>
                </div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Collected</span>
                    <span className="text-green-400 font-medium">{fmtAmount(ev.collected, ev.currency)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Outstanding</span>
                    <span className="text-yellow-400 font-medium">{fmtAmount(ev.outstanding, ev.currency)}</span>
                  </div>
                  <div className="w-full bg-white/5 rounded-full h-1.5 mt-2">
                    <div
                      className="bg-green-500 h-1.5 rounded-full transition-all"
                      style={{ width: ev.totalPlayers > 0 ? `${Math.round((ev.paid / ev.totalPlayers) * 100)}%` : '0%' }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{ev.paid}/{ev.totalPlayers} paid</span>
                    {ev.unpaid > 0 && <span className="text-yellow-500">{ev.unpaid} unpaid</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly Revenue Chart */}
      {chartData.length > 0 && (
        <div className="glass-panel rounded-2xl p-6">
          <div className="flex items-center gap-2 mb-6">
            <TrendingUp className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-white">Monthly Revenue</h3>
            <span className="text-xs text-muted-foreground ml-auto">Last {chartData.length} months</span>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
              <XAxis
                dataKey="label"
                tick={{ fill: '#94b4a4', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#94b4a4', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
              />
              <Tooltip
                contentStyle={{ background: '#142019', border: '1px solid #243b2e', borderRadius: '8px', color: '#fff' }}
                formatter={(value: number, _name: string, entry: { payload?: { currency?: string } }) => [
                  fmtAmount(value, entry.payload?.currency ?? 'INR'),
                  'Collected',
                ]}
                labelStyle={{ color: '#94b4a4', fontSize: 12 }}
              />
              <Bar dataKey="collected" radius={[4, 4, 0, 0]} maxBarSize={40}>
                {chartData.map((_entry, index) => (
                  <Cell key={index} fill={index === chartData.length - 1 ? '#22c55e' : '#1e4d2b'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Revenue by Currency */}
      {data && Object.keys(data.revenueByCurrency).length > 1 && (
        <div className="glass-panel rounded-2xl p-6">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-4">Revenue by Currency</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.entries(data.revenueByCurrency).map(([cur, rev]) => (
              <div key={cur} className="p-4 rounded-xl bg-white/3 border border-white/5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base font-bold text-primary">{CURRENCY_SYMBOLS[cur] ?? cur}</span>
                  <span className="text-xs text-muted-foreground">{cur}</span>
                </div>
                <p className="text-lg font-bold text-white">{fmtAmount(rev.collected, cur)}</p>
                <p className="text-xs text-muted-foreground">Collected</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center glass-panel p-2 rounded-2xl">
        <div className="flex gap-1 p-1 bg-black/40 rounded-xl overflow-x-auto">
          {['all', 'paid', 'unpaid', 'refunded'].map(s => (
            <button key={s} onClick={() => setFilterStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${filterStatus === s ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-1 p-1 bg-black/40 rounded-xl">
          {['all', 'tournament', 'league'].map(k => (
            <button key={k} onClick={() => setFilterKind(k)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-all ${filterKind === k ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}>
              {k.charAt(0).toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <Input
            placeholder="Search player or event..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-black/40 border-white/5 text-white rounded-xl h-9"
          />
        </div>
      </div>

      {/* Transactions Table */}
      <div className="glass-panel rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-white/5">
          <h3 className="text-sm font-semibold text-white">
            Transaction Log <span className="text-muted-foreground font-normal">({filtered.length})</span>
          </h3>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">Loading transactions…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <DollarSign className="w-12 h-12 text-muted-foreground opacity-30 mx-auto mb-3" />
            <p className="text-muted-foreground">No transactions match the current filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  {([
                    { field: 'date', label: 'Date' },
                    { field: 'name', label: 'Player / Member' },
                    { field: 'eventName', label: 'Event' },
                    { field: 'amount', label: 'Amount' },
                    { field: 'paymentStatus', label: 'Status' },
                  ] as { field: SortField; label: string }[]).map(col => (
                    <th key={col.field}
                      className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-white transition-colors"
                      onClick={() => handleSort(col.field)}
                    >
                      <span className="flex items-center">
                        {col.label}
                        <SortIcon field={col.field} sortField={sortField} sortDir={sortDir} />
                      </span>
                    </th>
                  ))}
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Payment ID</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Link</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((tx, i) => {
                  const st = STATUS_CONFIG[tx.paymentStatus] ?? STATUS_CONFIG['unpaid'];
                  const Icon = st.icon;
                  return (
                    <tr key={tx.id} className={`border-b border-white/3 hover:bg-white/3 transition-colors ${i % 2 === 0 ? '' : 'bg-white/1'}`}>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {new Date(tx.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-white">{tx.name}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {tx.kind === 'tournament'
                            ? <Trophy className="w-3.5 h-3.5 text-primary opacity-70" />
                            : <BarChart3 className="w-3.5 h-3.5 text-blue-400 opacity-70" />}
                          <span className="text-white truncate max-w-[180px]">{tx.eventName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono">
                        {tx.amount != null
                          ? <span className={tx.paymentStatus === 'paid' ? 'text-green-400' : 'text-white'}>{fmtAmount(tx.amount, tx.currency)}</span>
                          : <span className="text-muted-foreground text-xs">No fee</span>}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={`${st.className} flex items-center gap-1 w-fit`}>
                          <Icon className="w-3 h-3" />
                          {st.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {tx.paymentId
                          ? <span className="text-xs text-muted-foreground font-mono">{tx.paymentId.slice(0, 16)}…</span>
                          : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {tx.paymentLinkUrl ? (
                          <button onClick={() => copyLink(tx.paymentLinkUrl!)} className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors">
                            <Copy className="w-3 h-3" /> Copy
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
