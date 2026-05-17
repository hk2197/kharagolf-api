import { useState, useCallback } from 'react';
import {
  DollarSign, Plus, Pencil, Trash2, Users, BarChart2,
  CheckCircle2, Clock, XCircle, Download, RefreshCw,
  TrendingUp, ChevronDown, ChevronUp, AlertCircle, Filter,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function apiUrl(path: string) {
  return `${BASE}/api${path}`;
}

type CommissionType = 'percentage' | 'flat_per_sale';
type CommissionSource = 'pos' | 'lesson';
type PayoutStatus = 'pending' | 'approved' | 'paid' | 'cancelled';

interface StaffMember {
  id: number;
  displayName: string;
  email: string;
  role: string;
}

interface CommissionRule {
  id: number;
  staffUserId: number;
  staffName: string;
  staffEmail: string;
  category: string | null;
  commissionType: CommissionType;
  rate: string;
  source: CommissionSource;
  tierThresholdAmount: string | null;
  isActive: boolean;
  createdAt: string;
}

interface CommissionPayout {
  id: number;
  staffUserId: number;
  staffName: string;
  staffEmail: string;
  periodStart: string;
  periodEnd: string;
  totalSales: string;
  totalCommission: string;
  totalAdjustments: string;
  netPayout: string;
  currency: string;
  status: PayoutStatus;
  notes: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

interface Attribution {
  id: number;
  staffUserId: number;
  staffName: string;
  source: CommissionSource;
  saleAmount: string;
  commissionAmount: string;
  category: string | null;
  attributedAt: string;
  payoutId: number | null;
}

interface MySummary {
  staffUserId: number;
  period: { from: string; to: string };
  totalSales: number;
  totalCommission: number;
  totalAdjustments: number;
  netEarnings: number;
  saleCount: number;
  recentAttributions: Attribution[];
  payouts: CommissionPayout[];
}

const PRODUCT_CATEGORIES = [
  'equipment', 'apparel', 'accessories', 'food_beverage', 'lessons', 'greens_fee', 'membership', 'other',
];

const statusColors: Record<PayoutStatus, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  approved: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  paid: 'bg-green-500/20 text-green-400 border-green-500/30',
  cancelled: 'bg-red-500/20 text-red-400 border-red-500/30',
};

function fmt(amount: string | number, currency = 'INR') {
  const n = parseFloat(String(amount));
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function CommissionsPage() {
  const { data: user } = useGetMe();
  const { toast } = useToast();
  const qc = useQueryClient();
  const orgId = user?.organizationId;
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin' || user?.role === 'tournament_director';

  const [tab, setTab] = useState<string>(isAdmin ? 'rules' : 'my-summary');
  const [showRuleDialog, setShowRuleDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<CommissionRule | null>(null);
  const [showPayoutDialog, setShowPayoutDialog] = useState(false);
  const [showAdjDialog, setShowAdjDialog] = useState(false);
  const [filterStaff, setFilterStaff] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [summaryStaffId, setSummaryStaffId] = useState<string>('');

  const [periodStart, setPeriodStart] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));

  // Queries
  const { data: staff = [] } = useQuery<StaffMember[]>({
    queryKey: [`/api/organizations/${orgId}/commissions/staff`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/commissions/staff`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && isAdmin,
  });

  const { data: rules = [], isLoading: rulesLoading } = useQuery<CommissionRule[]>({
    queryKey: [`/api/organizations/${orgId}/commissions/rules`, filterStaff],
    queryFn: () => {
      const url = new URL(apiUrl(`/organizations/${orgId}/commissions/rules`), window.location.origin);
      if (filterStaff) url.searchParams.set('staffUserId', filterStaff);
      return fetch(url.toString(), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId && isAdmin && tab === 'rules',
  });

  const { data: payouts = [], isLoading: payoutsLoading } = useQuery<CommissionPayout[]>({
    queryKey: [`/api/organizations/${orgId}/commissions/payouts`, filterStaff, filterStatus],
    queryFn: () => {
      const url = new URL(apiUrl(`/organizations/${orgId}/commissions/payouts`), window.location.origin);
      if (filterStaff) url.searchParams.set('staffUserId', filterStaff);
      if (filterStatus) url.searchParams.set('status', filterStatus);
      return fetch(url.toString(), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId && isAdmin && tab === 'payouts',
  });

  const { data: attributions = [], isLoading: attrLoading } = useQuery<Attribution[]>({
    queryKey: [`/api/organizations/${orgId}/commissions/attributions`, filterStaff],
    queryFn: () => {
      const url = new URL(apiUrl(`/organizations/${orgId}/commissions/attributions`), window.location.origin);
      if (filterStaff) url.searchParams.set('staffUserId', filterStaff);
      return fetch(url.toString(), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId && isAdmin && tab === 'attributions',
  });

  const summaryTarget = summaryStaffId || String(user?.id ?? '');
  const { data: mySummary, isLoading: summaryLoading } = useQuery<MySummary>({
    queryKey: [`/api/organizations/${orgId}/commissions/my-summary`, summaryTarget, periodStart, periodEnd],
    queryFn: () => {
      const url = new URL(apiUrl(`/organizations/${orgId}/commissions/my-summary`), window.location.origin);
      url.searchParams.set('from', periodStart);
      url.searchParams.set('to', periodEnd);
      if (summaryStaffId) url.searchParams.set('staffUserId', summaryStaffId);
      return fetch(url.toString(), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId && !!user && tab === 'my-summary',
  });

  // Rule mutations
  const deleteRuleMut = useMutation({
    mutationFn: async (ruleId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/commissions/rules/${ruleId}`), {
        method: 'DELETE', credentials: 'include',
      });
      if (!r.ok) throw new Error((await r.json()).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/commissions/rules`] });
      toast({ title: 'Rule deactivated' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const approveMut = useMutation({
    mutationFn: async (payoutId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/commissions/payouts/${payoutId}/approve`), {
        method: 'PATCH', credentials: 'include',
      });
      if (!r.ok) throw new Error((await r.json()).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/commissions/payouts`] });
      toast({ title: 'Payout approved' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const markPaidMut = useMutation({
    mutationFn: async (payoutId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/commissions/payouts/${payoutId}/mark-paid`), {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error((await r.json()).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/commissions/payouts`] });
      toast({ title: 'Payout marked as paid' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const cancelMut = useMutation({
    mutationFn: async (payoutId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/commissions/payouts/${payoutId}/cancel`), {
        method: 'PATCH', credentials: 'include',
      });
      if (!r.ok) throw new Error((await r.json()).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/commissions/payouts`] });
      toast({ title: 'Payout cancelled' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  function handleDownloadCsv(payoutId: number) {
    window.open(apiUrl(`/organizations/${orgId}/commissions/payouts/${payoutId}/report?format=csv`), '_blank');
  }

  if (!orgId) return <div className="p-8 text-muted-foreground">Loading...</div>;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <DollarSign className="w-6 h-6 text-primary" />
            Commission Tracking
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage staff commission rules, view earnings, and generate payout reports.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-card/50 border border-white/10">
          <TabsTrigger value="my-summary">
            {isAdmin ? 'Staff Summary' : 'My Summary'}
          </TabsTrigger>
          {isAdmin && (
            <>
              <TabsTrigger value="rules">Commission Rules</TabsTrigger>
              <TabsTrigger value="attributions">Sales Log</TabsTrigger>
              <TabsTrigger value="payouts">Payouts</TabsTrigger>
            </>
          )}
        </TabsList>

        {/* ─── MY SUMMARY TAB ─────────────────────────────────────── */}
        <TabsContent value="my-summary" className="space-y-4 mt-4">
          <div className="flex flex-wrap gap-3 items-end">
            {isAdmin && (
              <div>
                <Label className="text-xs text-muted-foreground">View Staff Member</Label>
                <Select value={summaryStaffId || "_empty"} onValueChange={v => setSummaryStaffId(v === "_empty" ? "" : v)}>
                  <SelectTrigger className="w-48 bg-card/50 border-white/10 text-white">
                    <SelectValue placeholder="My own summary" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_empty">My own summary</SelectItem>
                    {staff.map(s => (
                      <SelectItem key={s.id} value={String(s.id)}>{s.displayName}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
                className="bg-card/50 border-white/10 text-white w-36" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
                className="bg-card/50 border-white/10 text-white w-36" />
            </div>
          </div>

          {summaryLoading ? (
            <div className="flex items-center justify-center h-32">
              <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : mySummary ? (
            <>
              {/* KPI cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[
                  { label: 'Total Sales', value: fmt(mySummary.totalSales), icon: TrendingUp, color: 'text-blue-400' },
                  { label: 'Commission Earned', value: fmt(mySummary.totalCommission), icon: DollarSign, color: 'text-green-400' },
                  { label: 'Adjustments', value: fmt(mySummary.totalAdjustments), icon: BarChart2, color: 'text-yellow-400' },
                  { label: 'Net Earnings', value: fmt(mySummary.netEarnings), icon: CheckCircle2, color: 'text-primary' },
                ].map(({ label, value, icon: Icon, color }) => (
                  <Card key={label} className="bg-card/50 border-white/10 p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className={`w-4 h-4 ${color}`} />
                      <span className="text-xs text-muted-foreground">{label}</span>
                    </div>
                    <div className="text-xl font-bold text-white">{value}</div>
                  </Card>
                ))}
              </div>

              {/* Recent attributions */}
              <Card className="bg-card/50 border-white/10">
                <div className="p-4 border-b border-white/5 flex items-center gap-2">
                  <BarChart2 className="w-4 h-4 text-muted-foreground" />
                  <span className="font-semibold text-white">Recent Sales ({mySummary.saleCount} total)</span>
                </div>
                <div className="divide-y divide-white/5 max-h-72 overflow-y-auto">
                  {mySummary.recentAttributions.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground text-sm">No sales recorded in this period.</div>
                  ) : mySummary.recentAttributions.map(a => (
                    <div key={a.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/5">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className={`text-[10px] ${a.source === 'pos' ? 'text-blue-400 border-blue-500/30' : 'text-purple-400 border-purple-500/30'}`}>
                          {a.source === 'pos' ? 'POS' : 'Lesson'}
                        </Badge>
                        <span className="text-sm text-white">{a.category ?? 'General'}</span>
                        <span className="text-xs text-muted-foreground">{fmtDate(a.attributedAt)}</span>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-white">{fmt(a.saleAmount)}</div>
                        <div className="text-xs text-green-400">+{fmt(a.commissionAmount)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              {/* Payout history */}
              {mySummary.payouts.length > 0 && (
                <Card className="bg-card/50 border-white/10">
                  <div className="p-4 border-b border-white/5">
                    <span className="font-semibold text-white">Payout History</span>
                  </div>
                  <div className="divide-y divide-white/5">
                    {mySummary.payouts.map(p => (
                      <div key={p.id} className="flex items-center justify-between px-4 py-3 hover:bg-white/5">
                        <div>
                          <div className="text-sm text-white">
                            {fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}
                          </div>
                          {p.paidAt && <div className="text-xs text-muted-foreground">Paid {fmtDate(p.paidAt)}</div>}
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge className={`text-[10px] border ${statusColors[p.status]}`}>{p.status}</Badge>
                          <span className="text-white font-semibold">{fmt(p.netPayout, p.currency)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </>
          ) : (
            <div className="text-muted-foreground text-sm">No data available.</div>
          )}
        </TabsContent>

        {/* ─── RULES TAB ──────────────────────────────────────────── */}
        {isAdmin && (
          <TabsContent value="rules" className="space-y-4 mt-4">
            <div className="flex flex-wrap gap-3 items-end justify-between">
              <div className="flex gap-3 items-end">
                <div>
                  <Label className="text-xs text-muted-foreground">Filter by staff</Label>
                  <Select value={filterStaff || "_empty"} onValueChange={v => setFilterStaff(v === "_empty" ? "" : v)}>
                    <SelectTrigger className="w-44 bg-card/50 border-white/10 text-white">
                      <SelectValue placeholder="All staff" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_empty">All staff</SelectItem>
                      {staff.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.displayName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button onClick={() => { setEditingRule(null); setShowRuleDialog(true); }}
                className="bg-primary hover:bg-primary/90 text-white">
                <Plus className="w-4 h-4 mr-1" /> Add Rule
              </Button>
            </div>

            <Card className="bg-card/50 border-white/10">
              {rulesLoading ? (
                <div className="flex items-center justify-center h-32">
                  <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : rules.length === 0 ? (
                <div className="p-10 text-center text-muted-foreground">
                  <DollarSign className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p>No commission rules configured yet.</p>
                  <p className="text-xs mt-1">Add rules to start tracking staff commissions.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {rules.map(rule => (
                    <div key={rule.id} className="flex items-center justify-between px-4 py-3 hover:bg-white/5">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white">{rule.staffName ?? rule.staffEmail}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className={`text-[10px] ${rule.source === 'pos' ? 'text-blue-400 border-blue-500/30' : 'text-purple-400 border-purple-500/30'}`}>
                              {rule.source}
                            </Badge>
                            {rule.category && <span>{rule.category}</span>}
                            {rule.tierThresholdAmount && <span className="text-yellow-400">Tier &gt; {fmt(rule.tierThresholdAmount)}</span>}
                            {!rule.isActive && <Badge variant="outline" className="text-[10px] text-red-400 border-red-500/30">Inactive</Badge>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 ml-4">
                        <div className="text-right">
                          <div className="text-sm font-bold text-white">
                            {rule.commissionType === 'percentage'
                              ? `${parseFloat(rule.rate)}%`
                              : fmt(rule.rate)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">{rule.commissionType === 'percentage' ? 'of sale' : 'per sale'}</div>
                        </div>
                        <Button size="icon" variant="ghost" className="w-7 h-7 hover:bg-white/10"
                          onClick={() => { setEditingRule(rule); setShowRuleDialog(true); }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="w-7 h-7 hover:bg-red-500/20 text-red-400"
                          onClick={() => deleteRuleMut.mutate(rule.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        )}

        {/* ─── ATTRIBUTIONS TAB ───────────────────────────────────── */}
        {isAdmin && (
          <TabsContent value="attributions" className="space-y-4 mt-4">
            <div className="flex gap-3 items-end">
              <div>
                <Label className="text-xs text-muted-foreground">Filter by staff</Label>
                <Select value={filterStaff || "_empty"} onValueChange={v => setFilterStaff(v === "_empty" ? "" : v)}>
                  <SelectTrigger className="w-44 bg-card/50 border-white/10 text-white">
                    <SelectValue placeholder="All staff" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_empty">All staff</SelectItem>
                    {staff.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.displayName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Card className="bg-card/50 border-white/10">
              {attrLoading ? (
                <div className="flex items-center justify-center h-32">
                  <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : attributions.length === 0 ? (
                <div className="p-10 text-center text-muted-foreground">
                  <BarChart2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p>No sales attributions yet.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5 max-h-[60vh] overflow-y-auto">
                  {attributions.map(a => (
                    <div key={a.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/5">
                      <div className="flex items-center gap-3">
                        <Badge variant="outline" className={`text-[10px] ${a.source === 'pos' ? 'text-blue-400 border-blue-500/30' : 'text-purple-400 border-purple-500/30'}`}>
                          {a.source === 'pos' ? 'POS' : 'Lesson'}
                        </Badge>
                        <div>
                          <div className="text-sm text-white">{a.staffName}</div>
                          <div className="text-xs text-muted-foreground">{a.category ?? 'General'} · {fmtDate(a.attributedAt)}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-white">{fmt(a.saleAmount)}</div>
                        <div className="text-xs text-green-400">+{fmt(a.commissionAmount)}</div>
                        {a.payoutId && <div className="text-[10px] text-muted-foreground">Payout #{a.payoutId}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        )}

        {/* ─── PAYOUTS TAB ────────────────────────────────────────── */}
        {isAdmin && (
          <TabsContent value="payouts" className="space-y-4 mt-4">
            <div className="flex flex-wrap gap-3 items-end justify-between">
              <div className="flex gap-3 items-end flex-wrap">
                <div>
                  <Label className="text-xs text-muted-foreground">Filter by staff</Label>
                  <Select value={filterStaff || "_empty"} onValueChange={v => setFilterStaff(v === "_empty" ? "" : v)}>
                    <SelectTrigger className="w-44 bg-card/50 border-white/10 text-white">
                      <SelectValue placeholder="All staff" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_empty">All staff</SelectItem>
                      {staff.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.displayName}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={filterStatus || "_empty"} onValueChange={v => setFilterStatus(v === "_empty" ? "" : v)}>
                    <SelectTrigger className="w-36 bg-card/50 border-white/10 text-white">
                      <SelectValue placeholder="All" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_empty">All</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="approved">Approved</SelectItem>
                      <SelectItem value="paid">Paid</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="outline" className="border-white/10 text-muted-foreground hover:text-white"
                  onClick={() => setShowAdjDialog(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add Adjustment
                </Button>
              </div>
              <Button onClick={() => setShowPayoutDialog(true)}
                className="bg-primary hover:bg-primary/90 text-white">
                <Download className="w-4 h-4 mr-1" /> Generate Payouts
              </Button>
            </div>

            <Card className="bg-card/50 border-white/10">
              {payoutsLoading ? (
                <div className="flex items-center justify-center h-32">
                  <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : payouts.length === 0 ? (
                <div className="p-10 text-center text-muted-foreground">
                  <DollarSign className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p>No payouts generated yet.</p>
                  <p className="text-xs mt-1">Generate payouts for a pay period to get started.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/5">
                  {payouts.map(p => (
                    <div key={p.id} className="px-4 py-3 hover:bg-white/5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Badge className={`text-[10px] border ${statusColors[p.status]}`}>{p.status}</Badge>
                          <div>
                            <div className="text-sm font-medium text-white">{p.staffName}</div>
                            <div className="text-xs text-muted-foreground">
                              {fmtDate(p.periodStart)} – {fmtDate(p.periodEnd)}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-right mr-2">
                            <div className="text-sm font-bold text-white">{fmt(p.netPayout, p.currency)}</div>
                            <div className="text-xs text-muted-foreground">
                              Commission: {fmt(p.totalCommission)} · Adj: {fmt(p.totalAdjustments)}
                            </div>
                          </div>
                          {p.status === 'pending' && (
                            <Button size="sm" variant="outline" className="border-blue-500/30 text-blue-400 hover:bg-blue-500/20 h-7 text-xs"
                              onClick={() => approveMut.mutate(p.id)}>
                              Approve
                            </Button>
                          )}
                          {(p.status === 'pending' || p.status === 'approved') && (
                            <Button size="sm" variant="outline" className="border-green-500/30 text-green-400 hover:bg-green-500/20 h-7 text-xs"
                              onClick={() => markPaidMut.mutate(p.id)}>
                              Mark Paid
                            </Button>
                          )}
                          {p.status !== 'paid' && p.status !== 'cancelled' && (
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-red-400 hover:bg-red-500/20"
                              onClick={() => cancelMut.mutate(p.id)}>
                              Cancel
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" className="w-7 h-7 hover:bg-white/10"
                            onClick={() => handleDownloadCsv(p.id)} title="Download CSV">
                            <Download className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {/* ─── RULE DIALOG ──────────────────────────────────────────── */}
      <RuleDialog
        open={showRuleDialog}
        onClose={() => setShowRuleDialog(false)}
        rule={editingRule}
        staff={staff}
        orgId={orgId!}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/commissions/rules`] });
          setShowRuleDialog(false);
          toast({ title: editingRule ? 'Rule updated' : 'Rule created' });
        }}
      />

      {/* ─── GENERATE PAYOUT DIALOG ───────────────────────────────── */}
      <GeneratePayoutDialog
        open={showPayoutDialog}
        onClose={() => setShowPayoutDialog(false)}
        orgId={orgId!}
        staff={staff}
        onGenerated={() => {
          qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/commissions/payouts`] });
          setShowPayoutDialog(false);
          setTab('payouts');
        }}
      />

      {/* ─── ADJUSTMENT DIALOG ────────────────────────────────────── */}
      <AdjustmentDialog
        open={showAdjDialog}
        onClose={() => setShowAdjDialog(false)}
        orgId={orgId!}
        staff={staff}
        onSaved={() => {
          setShowAdjDialog(false);
          toast({ title: 'Adjustment recorded' });
        }}
      />
    </div>
  );
}

// ─── Rule Dialog ──────────────────────────────────────────────────────────────

function RuleDialog({
  open, onClose, rule, staff, orgId, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  rule: CommissionRule | null;
  staff: StaffMember[];
  orgId: number;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [staffUserId, setStaffUserId] = useState(rule ? String(rule.staffUserId) : '');
  const [source, setSource] = useState<CommissionSource>(rule?.source ?? 'pos');
  const [commissionType, setCommissionType] = useState<CommissionType>(rule?.commissionType ?? 'percentage');
  const [rate, setRate] = useState(rule ? String(parseFloat(rule.rate)) : '');
  const [category, setCategory] = useState(rule?.category ?? '');
  const [tierThreshold, setTierThreshold] = useState(rule?.tierThresholdAmount ? String(parseFloat(rule.tierThresholdAmount)) : '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!staffUserId || !rate) { toast({ title: 'Please fill in all required fields.', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const url = rule
        ? apiUrl(`/organizations/${orgId}/commissions/rules/${rule.id}`)
        : apiUrl(`/organizations/${orgId}/commissions/rules`);
      const method = rule ? 'PATCH' : 'POST';
      const body: Record<string, unknown> = {
        staffUserId: parseInt(staffUserId), source, commissionType,
        rate: parseFloat(rate),
        category: category || null,
        tierThresholdAmount: tierThreshold ? parseFloat(tierThreshold) : null,
      };
      const r = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      onSaved();
    } catch (e: unknown) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit' : 'Add'} Commission Rule</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Staff Member *</Label>
            <Select value={staffUserId} onValueChange={setStaffUserId}>
              <SelectTrigger className="bg-background border-white/10 text-white">
                <SelectValue placeholder="Select staff member" />
              </SelectTrigger>
              <SelectContent>
                {staff.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.displayName} ({s.email})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Source *</Label>
              <Select value={source} onValueChange={v => setSource(v as CommissionSource)}>
                <SelectTrigger className="bg-background border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pos">POS Sales</SelectItem>
                  <SelectItem value="lesson">Lessons</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Commission Type *</Label>
              <Select value={commissionType} onValueChange={v => setCommissionType(v as CommissionType)}>
                <SelectTrigger className="bg-background border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage (%)</SelectItem>
                  <SelectItem value="flat_per_sale">Flat per sale</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Rate * {commissionType === 'percentage' ? '(% of sale amount)' : '(fixed amount per sale)'}
            </Label>
            <Input type="number" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)}
              placeholder={commissionType === 'percentage' ? 'e.g. 5' : 'e.g. 100'}
              className="bg-background border-white/10 text-white" />
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Product Category (leave blank for all)</Label>
            <Select value={category || "_empty"} onValueChange={v => setCategory(v === "_empty" ? "" : v)}>
              <SelectTrigger className="bg-background border-white/10 text-white">
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="_empty">All categories</SelectItem>
                {PRODUCT_CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Tier Threshold (monthly sales to activate, optional)</Label>
            <Input type="number" min="0" step="1" value={tierThreshold} onChange={e => setTierThreshold(e.target.value)}
              placeholder="e.g. 50000 (rule activates above this)"
              className="bg-background border-white/10 text-white" />
            <p className="text-[10px] text-muted-foreground">Leave blank for a flat rate with no threshold.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-primary hover:bg-primary/90 text-white">
            {saving ? 'Saving...' : rule ? 'Update Rule' : 'Create Rule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Generate Payout Dialog ───────────────────────────────────────────────────

function GeneratePayoutDialog({
  open, onClose, orgId, staff, onGenerated,
}: {
  open: boolean; onClose: () => void; orgId: number;
  staff: StaffMember[]; onGenerated: () => void;
}) {
  const { toast } = useToast();
  const [periodStart, setPeriodStart] = useState(() => {
    const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10);
  });
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [selectedStaff, setSelectedStaff] = useState<number[]>([]);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<{ payouts: CommissionPayout[]; message?: string } | null>(null);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const r = await fetch(apiUrl(`/organizations/${orgId}/commissions/payouts/generate`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          periodStart, periodEnd,
          staffUserIds: selectedStaff.length > 0 ? selectedStaff : undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? 'Failed to generate payouts');
      setResult(data);
    } catch (e: unknown) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setSelectedStaff([]);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && handleClose()}>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle>Generate Commission Payouts</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="space-y-3 py-2">
            {result.payouts.length === 0 ? (
              <div className="flex items-center gap-2 text-yellow-400">
                <AlertCircle className="w-5 h-5" />
                <span>{result.message ?? 'No payouts generated.'}</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-green-400">
                  <CheckCircle2 className="w-5 h-5" />
                  <span>{result.payouts.length} payout(s) generated successfully.</span>
                </div>
                <div className="divide-y divide-white/5 border border-white/10 rounded-lg overflow-hidden">
                  {result.payouts.map(p => (
                    <div key={p.id} className="flex items-center justify-between px-3 py-2">
                      <span className="text-sm text-white">Staff #{p.staffUserId}</span>
                      <span className="text-sm font-semibold text-white">{fmt(p.netPayout, p.currency)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <DialogFooter>
              <Button onClick={() => { handleClose(); onGenerated(); }} className="bg-primary hover:bg-primary/90 text-white w-full">
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Period Start *</Label>
                  <Input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)}
                    className="bg-background border-white/10 text-white" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Period End *</Label>
                  <Input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)}
                    className="bg-background border-white/10 text-white" />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Staff (leave blank for all with sales)</Label>
                <div className="border border-white/10 rounded-lg max-h-40 overflow-y-auto divide-y divide-white/5">
                  {staff.map(s => (
                    <label key={s.id} className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 cursor-pointer">
                      <input type="checkbox" checked={selectedStaff.includes(s.id)}
                        onChange={e => setSelectedStaff(prev => e.target.checked ? [...prev, s.id] : prev.filter(x => x !== s.id))}
                        className="accent-primary" />
                      <span className="text-sm text-white">{s.displayName}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button onClick={handleGenerate} disabled={generating} className="bg-primary hover:bg-primary/90 text-white">
                {generating ? 'Generating...' : 'Generate Payouts'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Adjustment Dialog ────────────────────────────────────────────────────────

function AdjustmentDialog({
  open, onClose, orgId, staff, onSaved,
}: {
  open: boolean; onClose: () => void; orgId: number;
  staff: StaffMember[]; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [staffUserId, setStaffUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!staffUserId || !amount || !reason) {
      toast({ title: 'Please fill in all fields.', variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      const r = await fetch(apiUrl(`/organizations/${orgId}/commissions/adjustments`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staffUserId: parseInt(staffUserId), amount: parseFloat(amount), reason }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      setStaffUserId(''); setAmount(''); setReason('');
      onSaved();
    } catch (e: unknown) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="bg-card border-white/10 text-white max-w-sm">
        <DialogHeader>
          <DialogTitle>Manual Adjustment</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Staff Member *</Label>
            <Select value={staffUserId} onValueChange={setStaffUserId}>
              <SelectTrigger className="bg-background border-white/10 text-white">
                <SelectValue placeholder="Select staff" />
              </SelectTrigger>
              <SelectContent>
                {staff.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.displayName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Amount * (use negative for deductions)</Label>
            <Input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="e.g. 500 or -200"
              className="bg-background border-white/10 text-white" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reason *</Label>
            <Input value={reason} onChange={e => setReason(e.target.value)}
              placeholder="e.g. Performance bonus"
              className="bg-background border-white/10 text-white" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className="bg-primary hover:bg-primary/90 text-white">
            {saving ? 'Saving...' : 'Save Adjustment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
