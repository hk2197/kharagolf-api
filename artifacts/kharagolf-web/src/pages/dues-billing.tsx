import { useState } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  DollarSign, Plus, Search, Download, RefreshCw, CheckCircle2, XCircle, Clock,
  AlertCircle, Send, MoreHorizontal, Trash2, Eye, FileText, Users, TrendingUp,
  Calendar, Ban, ChevronDown, Filter,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', GBP: '£', AED: 'د.إ', EUR: '€', SGD: 'S$', AUD: 'A$',
};

function fmtCurrency(amount: number | string | null, currency: string) {
  if (amount == null) return '—';
  const sym = CURRENCY_SYMBOLS[currency] ?? currency;
  return `${sym}${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const STATUS_CONFIG: Record<string, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  draft: { label: 'Draft', className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', icon: FileText },
  sent: { label: 'Sent', className: 'bg-blue-500/20 text-blue-400 border-blue-500/30', icon: Send },
  paid: { label: 'Paid', className: 'bg-green-500/20 text-green-400 border-green-500/30', icon: CheckCircle2 },
  overdue: { label: 'Overdue', className: 'bg-red-500/20 text-red-400 border-red-500/30', icon: AlertCircle },
  cancelled: { label: 'Cancelled', className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', icon: XCircle },
  void: { label: 'Void', className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30', icon: Ban },
};

interface BillingSchedule {
  id: number;
  name: string;
  billingCycle: string;
  amount: string;
  currency: string;
  gracePeriodDays: number;
  suspendAfterDays: number;
  reminderDaysBefore: number[];
  autoGenerate: boolean;
  nextRunDate: string | null;
  isActive: boolean;
  tierId: number | null;
  tierName: string | null;
}

interface Invoice {
  id: number;
  invoiceNumber: string;
  status: string;
  totalAmount: string;
  paidAmount: string;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  razorpayPaymentLinkUrl: string | null;
  sentAt: string | null;
  notes: string | null;
  createdAt: string;
  clubMemberId: number;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberEmail: string | null;
  memberNumber: string | null;
  scheduleId: number | null;
  scheduleName: string | null;
}

interface DashboardData {
  totalBilled: number;
  totalCollected: number;
  totalOutstanding: number;
  countPaid: number;
  countOverdue: number;
  countSent: number;
  countDraft: number;
  suspendedMembersCount: number;
  overdueMembers: Array<{
    memberId: number;
    memberFirstName: string | null;
    memberLastName: string | null;
    memberEmail: string | null;
    memberNumber: string | null;
    invoiceCount: number;
    totalOutstanding: string;
    oldestDueDate: string | null;
  }>;
}

interface MembershipTier {
  id: number;
  name: string;
  annualFee: string;
  currency: string;
}

interface ClubMember {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  memberNumber: string | null;
}

export default function DuesBillingPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState('dashboard');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [showInvoiceDialog, setShowInvoiceDialog] = useState(false);
  const [showMarkPaidDialog, setShowMarkPaidDialog] = useState<Invoice | null>(null);
  const [showGenerateDialog, setShowGenerateDialog] = useState<BillingSchedule | null>(null);
  const [showDetailDialog, setShowDetailDialog] = useState<Invoice | null>(null);
  const [editSchedule, setEditSchedule] = useState<BillingSchedule | null>(null);

  // Schedule form
  const [scheduleForm, setScheduleForm] = useState({
    name: '', billingCycle: 'annual', amount: '', currency: 'INR',
    gracePeriodDays: 14, suspendAfterDays: 30, reminderDaysBefore: '7,1',
    autoGenerate: true, nextRunDate: '', tierId: '',
  });

  // Invoice form
  const [invoiceForm, setInvoiceForm] = useState({
    clubMemberId: '', dueDate: '', notes: '',
    lineItems: [{ description: '', quantity: '1', unitAmount: '', lineType: 'dues' }],
  });

  // Mark paid form
  const [markPaidForm, setMarkPaidForm] = useState({ amount: '', method: 'cash', reference: '', paidAt: '', notes: '' });

  // Generate form
  const [generateForm, setGenerateForm] = useState({ dueDate: '' });

  // ─── Queries ───────────────────────────────────────────────────────────────
  const { data: dashboard, isLoading: dashLoading } = useQuery<DashboardData>({
    queryKey: [`/api/organizations/${orgId}/dues-billing/dashboard`],
    queryFn: () => fetch(`${BASE}/api/organizations/${orgId}/dues-billing/dashboard`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
    refetchInterval: 60000,
  });

  const { data: schedules = [] } = useQuery<BillingSchedule[]>({
    queryKey: [`/api/organizations/${orgId}/dues-billing/schedules`],
    queryFn: () => fetch(`${BASE}/api/organizations/${orgId}/dues-billing/schedules`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: invoices = [], isLoading: invLoading } = useQuery<Invoice[]>({
    queryKey: [`/api/organizations/${orgId}/dues-billing/invoices`, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '200' });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      return fetch(`${BASE}/api/organizations/${orgId}/dues-billing/invoices?${params}`, { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId,
  });

  const { data: tiers = [] } = useQuery<MembershipTier[]>({
    queryKey: [`/api/organizations/${orgId}/membership-tiers`],
    queryFn: () => fetch(`${BASE}/api/organizations/${orgId}/membership-tiers`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && (showScheduleDialog || !!editSchedule || showInvoiceDialog),
  });

  const { data: members = [] } = useQuery<ClubMember[]>({
    queryKey: [`/api/organizations/${orgId}/club-members/simple`],
    queryFn: () => fetch(`${BASE}/api/organizations/${orgId}/club-members`, { credentials: 'include' })
      .then(r => r.json())
      .then((d: any) => Array.isArray(d) ? d : (d.members ?? [])),
    enabled: !!orgId && showInvoiceDialog,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/dues-billing/dashboard`] });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/dues-billing/invoices`] });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/dues-billing/schedules`] });
  };

  // ─── Mutations ─────────────────────────────────────────────────────────────
  const saveSchedule = useMutation({
    mutationFn: async (data: any) => {
      const url = editSchedule
        ? `${BASE}/api/organizations/${orgId}/dues-billing/schedules/${editSchedule.id}`
        : `${BASE}/api/organizations/${orgId}/dues-billing/schedules`;
      const r = await fetch(url, {
        method: editSchedule ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Schedule saved' }); setShowScheduleDialog(false); setEditSchedule(null); invalidate(); },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteSchedule = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${BASE}/api/organizations/${orgId}/dues-billing/schedules/${id}`, { method: 'DELETE', credentials: 'include' });
    },
    onSuccess: () => { toast({ title: 'Schedule deleted' }); invalidate(); },
  });

  const createInvoice = useMutation({
    mutationFn: async (data: any) => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/dues-billing/invoices`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Invoice created' }); setShowInvoiceDialog(false); invalidate(); },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const sendInvoice = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/dues-billing/invoices/${id}/send`, { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Invoice sent' }); invalidate(); },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const voidInvoice = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/dues-billing/invoices/${id}/void`, { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Invoice voided' }); invalidate(); },
  });

  const markPaid = useMutation({
    mutationFn: async ({ invoiceId, data }: { invoiceId: number; data: any }) => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/dues-billing/invoices/${invoiceId}/mark-paid`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Payment recorded' }); setShowMarkPaidDialog(null); invalidate(); },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const generateInvoices = useMutation({
    mutationFn: async ({ scheduleId, dueDate }: { scheduleId: number; dueDate: string }) => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/dues-billing/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ scheduleId, dueDate: dueDate || undefined }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (d) => { toast({ title: `Generated ${d.created} invoice(s)` }); setShowGenerateDialog(null); invalidate(); },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const processOverdue = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/dues-billing/process-overdue`, { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (d) => { toast({ title: `Processed: ${d.markedOverdue} overdue, ${d.suspended} suspended` }); invalidate(); },
  });

  // ─── Filtered invoices ──────────────────────────────────────────────────────
  const filteredInvoices = invoices.filter(inv => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      inv.invoiceNumber.toLowerCase().includes(q) ||
      `${inv.memberFirstName} ${inv.memberLastName}`.toLowerCase().includes(q) ||
      (inv.memberEmail ?? '').toLowerCase().includes(q) ||
      (inv.memberNumber ?? '').toLowerCase().includes(q)
    );
  });

  // ─── Schedule form submit ───────────────────────────────────────────────────
  const handleSaveSchedule = () => {
    const reminderArr = scheduleForm.reminderDaysBefore.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    saveSchedule.mutate({
      name: scheduleForm.name,
      billingCycle: scheduleForm.billingCycle,
      amount: scheduleForm.amount,
      currency: scheduleForm.currency,
      gracePeriodDays: Number(scheduleForm.gracePeriodDays),
      suspendAfterDays: Number(scheduleForm.suspendAfterDays),
      reminderDaysBefore: reminderArr,
      autoGenerate: scheduleForm.autoGenerate,
      nextRunDate: scheduleForm.nextRunDate || null,
      tierId: scheduleForm.tierId || null,
    });
  };

  const openEditSchedule = (s: BillingSchedule) => {
    setEditSchedule(s);
    setScheduleForm({
      name: s.name,
      billingCycle: s.billingCycle,
      amount: s.amount,
      currency: s.currency,
      gracePeriodDays: s.gracePeriodDays,
      suspendAfterDays: s.suspendAfterDays,
      reminderDaysBefore: (s.reminderDaysBefore ?? []).join(','),
      autoGenerate: s.autoGenerate,
      nextRunDate: s.nextRunDate ? new Date(s.nextRunDate).toISOString().split('T')[0] : '',
      tierId: s.tierId ? String(s.tierId) : '',
    });
    setShowScheduleDialog(true);
  };

  // ─── Invoice line items ─────────────────────────────────────────────────────
  const addLineItem = () => setInvoiceForm(f => ({ ...f, lineItems: [...f.lineItems, { description: '', quantity: '1', unitAmount: '', lineType: 'dues' }] }));
  const removeLineItem = (i: number) => setInvoiceForm(f => ({ ...f, lineItems: f.lineItems.filter((_, idx) => idx !== i) }));
  const updateLineItem = (i: number, key: string, value: string) => setInvoiceForm(f => {
    const li = [...f.lineItems];
    li[i] = { ...li[i], [key]: value };
    return { ...f, lineItems: li };
  });
  const invoiceTotal = invoiceForm.lineItems.reduce((s, li) => s + (parseFloat(li.unitAmount || '0') * parseFloat(li.quantity || '1')), 0);

  const handleCreateInvoice = () => {
    createInvoice.mutate({
      clubMemberId: invoiceForm.clubMemberId,
      dueDate: invoiceForm.dueDate || null,
      notes: invoiceForm.notes || null,
      lineItems: invoiceForm.lineItems.map(li => ({ ...li, quantity: parseFloat(li.quantity), unitAmount: parseFloat(li.unitAmount) })),
    });
  };

  const exportCsv = () => {
    window.open(`${BASE}/api/organizations/${orgId}/dues-billing/export`, '_blank');
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Annual Dues & Billing</h1>
          <p className="text-sm text-muted-foreground mt-1">Automate membership dues, invoicing, and collections</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => processOverdue.mutate()} disabled={processOverdue.isPending}>
            <RefreshCw className={`w-4 h-4 mr-2 ${processOverdue.isPending ? 'animate-spin' : ''}`} />
            Process Overdue
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
          <Button size="sm" onClick={() => { setShowInvoiceDialog(true); setInvoiceForm({ clubMemberId: '', dueDate: '', notes: '', lineItems: [{ description: '', quantity: '1', unitAmount: '', lineType: 'dues' }] }); }}>
            <Plus className="w-4 h-4 mr-2" />
            New Invoice
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-card/50 border border-white/10">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="schedules">Billing Schedules</TabsTrigger>
        </TabsList>

        {/* ── Dashboard Tab ── */}
        <TabsContent value="dashboard" className="space-y-6 mt-6">
          {/* Stats cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Total Billed', value: fmtCurrency(dashboard?.totalBilled ?? 0, 'INR'), icon: DollarSign, color: 'text-blue-400' },
              { label: 'Collected', value: fmtCurrency(dashboard?.totalCollected ?? 0, 'INR'), icon: CheckCircle2, color: 'text-green-400' },
              { label: 'Outstanding', value: fmtCurrency(dashboard?.totalOutstanding ?? 0, 'INR'), icon: TrendingUp, color: 'text-amber-400' },
              { label: 'Overdue Invoices', value: String(dashboard?.countOverdue ?? 0), icon: AlertCircle, color: 'text-red-400' },
            ].map(({ label, value, icon: Icon, color }) => (
              <Card key={label} className="bg-card/50 border-white/10">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
                    <Icon className={`w-4 h-4 ${color}`} />
                  </div>
                  <p className="text-xl font-bold text-white">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Status breakdown */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Draft', count: dashboard?.countDraft ?? 0, status: 'draft' },
              { label: 'Sent', count: dashboard?.countSent ?? 0, status: 'sent' },
              { label: 'Paid', count: dashboard?.countPaid ?? 0, status: 'paid' },
              { label: 'Suspended Members', count: dashboard?.suspendedMembersCount ?? 0, status: null },
            ].map(({ label, count, status }) => (
              <button
                key={label}
                className="bg-card/30 border border-white/10 rounded-xl p-4 text-left hover:bg-card/50 transition-colors"
                onClick={() => { if (status) { setStatusFilter(status); setActiveTab('invoices'); } }}
              >
                <p className="text-2xl font-bold text-white">{count}</p>
                <p className="text-sm text-muted-foreground mt-1">{label}</p>
              </button>
            ))}
          </div>

          {/* Overdue members list */}
          {(dashboard?.overdueMembers?.length ?? 0) > 0 && (
            <Card className="bg-card/50 border-white/10">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400" />
                  Overdue Members ({dashboard!.overdueMembers.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {dashboard!.overdueMembers.map(m => (
                    <div key={m.memberId} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                      <div>
                        <p className="text-sm font-medium text-white">{m.memberFirstName} {m.memberLastName}</p>
                        <p className="text-xs text-muted-foreground">{m.memberEmail} · {m.invoiceCount} invoice(s) · oldest due {fmtDate(m.oldestDueDate)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-red-400">{fmtCurrency(m.totalOutstanding, 'INR')}</p>
                        <button
                          className="text-xs text-primary hover:underline"
                          onClick={() => { setStatusFilter('overdue'); setSearch(`${m.memberFirstName ?? ''} ${m.memberLastName ?? ''}`); setActiveTab('invoices'); }}
                        >
                          View invoices
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Invoices Tab ── */}
        <TabsContent value="invoices" className="mt-6 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-9 bg-card/50 border-white/10"
                placeholder="Search by name, email, invoice no..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40 bg-card/50 border-white/10">
                <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
                <SelectItem value="void">Void</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {invLoading ? (
            <div className="text-center py-12 text-muted-foreground">Loading invoices...</div>
          ) : filteredInvoices.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No invoices found</div>
          ) : (
            <div className="bg-card/30 border border-white/10 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead className="border-b border-white/10">
                  <tr>
                    {['Invoice', 'Member', 'Amount', 'Status', 'Due Date', 'Actions'].map(h => (
                      <th key={h} className="px-4 py-3 text-left text-xs uppercase tracking-wider text-muted-foreground font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredInvoices.map(inv => {
                    const sc = STATUS_CONFIG[inv.status] ?? STATUS_CONFIG.draft;
                    const Icon = sc.icon;
                    const outstanding = parseFloat(inv.totalAmount) - parseFloat(inv.paidAmount);
                    return (
                      <tr key={inv.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-mono text-xs text-white">{inv.invoiceNumber}</p>
                          <p className="text-[11px] text-muted-foreground">{inv.scheduleName ?? 'Manual'}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-white">{inv.memberFirstName} {inv.memberLastName}</p>
                          <p className="text-xs text-muted-foreground">{inv.memberEmail}</p>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-white font-medium">{fmtCurrency(inv.totalAmount, inv.currency)}</p>
                          {parseFloat(inv.paidAmount) > 0 && parseFloat(inv.paidAmount) < parseFloat(inv.totalAmount) && (
                            <p className="text-[11px] text-amber-400">{fmtCurrency(outstanding, inv.currency)} outstanding</p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={`text-[11px] ${sc.className} flex items-center gap-1 w-fit`}>
                            <Icon className="w-3 h-3" />
                            {sc.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">{fmtDate(inv.dueDate)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            {inv.status === 'draft' && (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-blue-400 hover:text-blue-300" onClick={() => sendInvoice.mutate(inv.id)}>
                                <Send className="w-3 h-3 mr-1" /> Send
                              </Button>
                            )}
                            {(inv.status === 'sent' || inv.status === 'overdue') && (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-green-400 hover:text-green-300" onClick={() => { setShowMarkPaidDialog(inv); setMarkPaidForm({ amount: inv.totalAmount, method: 'cash', reference: '', paidAt: '', notes: '' }); }}>
                                <CheckCircle2 className="w-3 h-3 mr-1" /> Mark Paid
                              </Button>
                            )}
                            {inv.razorpayPaymentLinkUrl && (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
                                <a href={inv.razorpayPaymentLinkUrl} target="_blank" rel="noreferrer">Pay Link</a>
                              </Button>
                            )}
                            {inv.status !== 'void' && inv.status !== 'paid' && (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-300" onClick={() => voidInvoice.mutate(inv.id)}>
                                <Ban className="w-3 h-3" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        {/* ── Schedules Tab ── */}
        <TabsContent value="schedules" className="mt-6 space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => {
              setEditSchedule(null);
              setScheduleForm({ name: '', billingCycle: 'annual', amount: '', currency: 'INR', gracePeriodDays: 14, suspendAfterDays: 30, reminderDaysBefore: '7,1', autoGenerate: true, nextRunDate: '', tierId: '' });
              setShowScheduleDialog(true);
            }}>
              <Plus className="w-4 h-4 mr-2" />
              New Schedule
            </Button>
          </div>

          {schedules.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>No billing schedules yet. Create one to start automating dues.</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {schedules.map(s => (
                <Card key={s.id} className="bg-card/50 border-white/10">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="text-sm font-semibold text-white">{s.name}</h3>
                          <Badge className={s.isActive ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'}>
                            {s.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                          {s.tierName && <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30">{s.tierName}</Badge>}
                        </div>
                        <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                          <span>{CURRENCY_SYMBOLS[s.currency] ?? s.currency}{s.amount} / {s.billingCycle.replace('_', '-')}</span>
                          <span>Grace: {s.gracePeriodDays}d</span>
                          <span>Suspend after: {s.suspendAfterDays}d overdue</span>
                          <span>Reminders: {(s.reminderDaysBefore ?? []).join(', ')}d before</span>
                          {s.nextRunDate && <span>Next run: {fmtDate(s.nextRunDate)}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                        <Button size="sm" variant="outline" className="h-7 px-3 text-xs border-white/10" onClick={() => { setShowGenerateDialog(s); setGenerateForm({ dueDate: '' }); }}>
                          Generate Invoices
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => openEditSchedule(s)}>Edit</Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-400 hover:text-red-300" onClick={() => deleteSchedule.mutate(s.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ── Schedule Dialog ── */}
      <Dialog open={showScheduleDialog} onOpenChange={v => { setShowScheduleDialog(v); if (!v) setEditSchedule(null); }}>
        <DialogContent className="max-w-lg bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>{editSchedule ? 'Edit Billing Schedule' : 'New Billing Schedule'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Schedule Name *</label>
              <Input className="bg-background border-white/10" value={scheduleForm.name} onChange={e => setScheduleForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Annual Full Membership" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Billing Cycle *</label>
                <Select value={scheduleForm.billingCycle} onValueChange={v => setScheduleForm(f => ({ ...f, billingCycle: v }))}>
                  <SelectTrigger className="bg-background border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="annual">Annual</SelectItem>
                    <SelectItem value="semi_annual">Semi-Annual</SelectItem>
                    <SelectItem value="quarterly">Quarterly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Membership Tier</label>
                <Select value={scheduleForm.tierId || "_empty"} onValueChange={v => setScheduleForm(f => ({ ...f, tierId: v === "_empty" ? "" : v }))}>
                  <SelectTrigger className="bg-background border-white/10"><SelectValue placeholder="All tiers" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_empty">All tiers</SelectItem>
                    {tiers.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Amount *</label>
                <Input className="bg-background border-white/10" type="number" min="0" value={scheduleForm.amount} onChange={e => setScheduleForm(f => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Currency</label>
                <Select value={scheduleForm.currency} onValueChange={v => setScheduleForm(f => ({ ...f, currency: v }))}>
                  <SelectTrigger className="bg-background border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.keys(CURRENCY_SYMBOLS).map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Grace Period (days)</label>
                <Input className="bg-background border-white/10" type="number" min="0" value={scheduleForm.gracePeriodDays} onChange={e => setScheduleForm(f => ({ ...f, gracePeriodDays: parseInt(e.target.value) || 0 }))} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Suspend After (days overdue)</label>
                <Input className="bg-background border-white/10" type="number" min="0" value={scheduleForm.suspendAfterDays} onChange={e => setScheduleForm(f => ({ ...f, suspendAfterDays: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Reminders (days before due, comma-separated)</label>
              <Input className="bg-background border-white/10" value={scheduleForm.reminderDaysBefore} onChange={e => setScheduleForm(f => ({ ...f, reminderDaysBefore: e.target.value }))} placeholder="e.g. 7,1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Next Run Date</label>
              <Input className="bg-background border-white/10" type="date" value={scheduleForm.nextRunDate} onChange={e => setScheduleForm(f => ({ ...f, nextRunDate: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowScheduleDialog(false); setEditSchedule(null); }}>Cancel</Button>
            <Button onClick={handleSaveSchedule} disabled={saveSchedule.isPending}>
              {saveSchedule.isPending ? 'Saving...' : 'Save Schedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Create Invoice Dialog ── */}
      <Dialog open={showInvoiceDialog} onOpenChange={setShowInvoiceDialog}>
        <DialogContent className="max-w-lg bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Create Invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Club Member *</label>
              <Select value={invoiceForm.clubMemberId} onValueChange={v => setInvoiceForm(f => ({ ...f, clubMemberId: v }))}>
                <SelectTrigger className="bg-background border-white/10"><SelectValue placeholder="Select member..." /></SelectTrigger>
                <SelectContent>
                  {members.map((m: any) => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.firstName} {m.lastName} {m.memberNumber ? `(${m.memberNumber})` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Due Date</label>
              <Input className="bg-background border-white/10" type="date" value={invoiceForm.dueDate} onChange={e => setInvoiceForm(f => ({ ...f, dueDate: e.target.value }))} />
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-muted-foreground">Line Items *</label>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={addLineItem}><Plus className="w-3 h-3 mr-1" /> Add</Button>
              </div>
              <div className="space-y-2">
                {invoiceForm.lineItems.map((li, i) => (
                  <div key={i} className="grid grid-cols-[1fr_80px_80px_auto] gap-2 items-center">
                    <Input className="bg-background border-white/10 text-xs" placeholder="Description" value={li.description} onChange={e => updateLineItem(i, 'description', e.target.value)} />
                    <Input className="bg-background border-white/10 text-xs" placeholder="Qty" type="number" min="1" value={li.quantity} onChange={e => updateLineItem(i, 'quantity', e.target.value)} />
                    <Input className="bg-background border-white/10 text-xs" placeholder="Amount" type="number" min="0" value={li.unitAmount} onChange={e => updateLineItem(i, 'unitAmount', e.target.value)} />
                    <Button size="sm" variant="ghost" className="h-7 px-1 text-zinc-500 hover:text-red-400" onClick={() => removeLineItem(i)} disabled={invoiceForm.lineItems.length === 1}><XCircle className="w-3.5 h-3.5" /></Button>
                  </div>
                ))}
              </div>
              {invoiceTotal > 0 && (
                <p className="text-sm text-white font-medium mt-2 text-right">Total: {fmtCurrency(invoiceTotal, 'INR')}</p>
              )}
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
              <Input className="bg-background border-white/10" placeholder="Optional notes..." value={invoiceForm.notes} onChange={e => setInvoiceForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInvoiceDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateInvoice} disabled={createInvoice.isPending || !invoiceForm.clubMemberId || invoiceForm.lineItems.every(li => !li.unitAmount)}>
              {createInvoice.isPending ? 'Creating...' : 'Create Invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Mark Paid Dialog ── */}
      <Dialog open={!!showMarkPaidDialog} onOpenChange={v => { if (!v) setShowMarkPaidDialog(null); }}>
        <DialogContent className="max-w-sm bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
          </DialogHeader>
          {showMarkPaidDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">Invoice: <span className="text-white font-mono">{showMarkPaidDialog.invoiceNumber}</span></p>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Amount</label>
                <Input className="bg-background border-white/10" type="number" min="0" value={markPaidForm.amount} onChange={e => setMarkPaidForm(f => ({ ...f, amount: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Payment Method</label>
                <Select value={markPaidForm.method} onValueChange={v => setMarkPaidForm(f => ({ ...f, method: v }))}>
                  <SelectTrigger className="bg-background border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="cheque">Cheque</SelectItem>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    <SelectItem value="account_credit">Account Credit</SelectItem>
                    <SelectItem value="online">Online</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Reference</label>
                <Input className="bg-background border-white/10" placeholder="Cheque no., transfer ref..." value={markPaidForm.reference} onChange={e => setMarkPaidForm(f => ({ ...f, reference: e.target.value }))} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Date Paid</label>
                <Input className="bg-background border-white/10" type="date" value={markPaidForm.paidAt} onChange={e => setMarkPaidForm(f => ({ ...f, paidAt: e.target.value }))} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMarkPaidDialog(null)}>Cancel</Button>
            <Button onClick={() => markPaid.mutate({ invoiceId: showMarkPaidDialog!.id, data: { amount: parseFloat(markPaidForm.amount), method: markPaidForm.method, reference: markPaidForm.reference || null, paidAt: markPaidForm.paidAt || null, notes: markPaidForm.notes || null } })} disabled={markPaid.isPending}>
              {markPaid.isPending ? 'Recording...' : 'Record Payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Generate Invoices Dialog ── */}
      <Dialog open={!!showGenerateDialog} onOpenChange={v => { if (!v) setShowGenerateDialog(null); }}>
        <DialogContent className="max-w-sm bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Generate Invoices</DialogTitle>
          </DialogHeader>
          {showGenerateDialog && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">Schedule: <span className="text-white">{showGenerateDialog.name}</span></p>
              <p className="text-xs text-muted-foreground">This will create draft invoices for all active members in this schedule's tier. You can review and send them afterwards.</p>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Due Date (optional — defaults to next cycle)</label>
                <Input className="bg-background border-white/10" type="date" value={generateForm.dueDate} onChange={e => setGenerateForm(f => ({ ...f, dueDate: e.target.value }))} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(null)}>Cancel</Button>
            <Button onClick={() => generateInvoices.mutate({ scheduleId: showGenerateDialog!.id, dueDate: generateForm.dueDate })} disabled={generateInvoices.isPending}>
              {generateInvoices.isPending ? 'Generating...' : 'Generate Invoices'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
