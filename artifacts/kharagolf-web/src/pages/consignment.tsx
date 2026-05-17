import { useState } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Edit2, Trash2, Package, DollarSign, CheckCircle2, XCircle,
  Clock, RotateCcw, Eye, Search, Tag, User, Phone, Mail,
  AlertCircle, TrendingUp, ShoppingBag,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';

const GOLD = '#C9A84C';

const STATUS_COLORS: Record<string, string> = {
  unsold: 'bg-white/10 text-white/60',
  sold: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  payout_pending: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  paid: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  returned: 'bg-red-500/20 text-red-300 border-red-500/30',
};

const STATUS_LABELS: Record<string, string> = {
  unsold: 'Unsold',
  sold: 'Sold',
  payout_pending: 'Payout Pending',
  paid: 'Paid',
  returned: 'Returned',
};

const CONDITION_LABELS: Record<string, string> = {
  new: 'New',
  like_new: 'Like New',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

const PAYOUT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank Transfer',
  cheque: 'Cheque',
  account_credit: 'Account Credit',
  other: 'Other',
};

interface ConsignmentItem {
  id: number;
  organizationId: number;
  consignorUserId: number | null;
  consignorName: string;
  consignorEmail: string | null;
  consignorPhone: string | null;
  title: string;
  description: string | null;
  category: string;
  brand: string | null;
  condition: string;
  askingPrice: string;
  currency: string;
  commissionRate: string;
  imageUrls: string[];
  status: string;
  salePrice: string | null;
  soldAt: string | null;
  commissionAmount: string | null;
  payoutAmount: string | null;
  payoutMethod: string | null;
  payoutReference: string | null;
  paidAt: string | null;
  returnedAt: string | null;
  notes: string | null;
  lookupToken: string;
  listedInShop: boolean;
  createdAt: string;
  updatedAt: string;
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge className={`text-xs border ${STATUS_COLORS[status] ?? 'bg-white/10 text-white/60'}`}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

function SummaryCard({ label, value, icon: Icon, color }: { label: string; value: number | string; icon: React.ElementType; color: string }) {
  return (
    <Card className="bg-card/50 border-white/10">
      <CardContent className="p-4 flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-2xl font-bold text-white">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ConsignmentPage() {
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const orgId = useActiveOrgId();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<ConsignmentItem | null>(null);
  const [detailItem, setDetailItem] = useState<ConsignmentItem | null>(null);
  const [showSellDialog, setShowSellDialog] = useState(false);
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [showLookupDialog, setShowLookupDialog] = useState(false);
  const [lookupToken, setLookupToken] = useState('');
  const [lookupResult, setLookupResult] = useState<ConsignmentItem | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [targetItem, setTargetItem] = useState<ConsignmentItem | null>(null);

  const [form, setForm] = useState({
    consignorName: '', consignorEmail: '', consignorPhone: '',
    title: '', description: '', category: 'equipment', brand: '', condition: 'good',
    askingPrice: '', commissionRate: '20', notes: '', listedInShop: false,
  });

  const [sellForm, setSellForm] = useState({ salePrice: '' });
  const [payForm, setPayForm] = useState({ payoutMethod: 'cash', payoutReference: '' });

  const { data, isLoading } = useQuery<{ items: ConsignmentItem[] }>({
    queryKey: [`/api/organizations/${orgId}/consignment`, activeTab],
    queryFn: () => fetch(`/api/organizations/${orgId}/consignment?status=${activeTab}`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const items = (data?.items ?? []).filter(i =>
    !search || i.title.toLowerCase().includes(search.toLowerCase()) ||
    i.consignorName.toLowerCase().includes(search.toLowerCase()) ||
    (i.brand ?? '').toLowerCase().includes(search.toLowerCase())
  );

  const allItems = data?.items ?? [];
  const unsoldCount = allItems.filter(i => i.status === 'unsold').length;
  const pendingCount = allItems.filter(i => i.status === 'payout_pending').length;
  const paidCount = allItems.filter(i => i.status === 'paid').length;
  const totalSales = allItems
    .filter(i => i.salePrice)
    .reduce((s, i) => s + parseFloat(i.salePrice!), 0);

  const invalidate = () => qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/consignment`] });

  function openCreate() {
    setEditItem(null);
    setForm({ consignorName: '', consignorEmail: '', consignorPhone: '', title: '', description: '', category: 'equipment', brand: '', condition: 'good', askingPrice: '', commissionRate: '20', notes: '', listedInShop: false });
    setShowForm(true);
  }

  function openEdit(item: ConsignmentItem) {
    setEditItem(item);
    setForm({
      consignorName: item.consignorName, consignorEmail: item.consignorEmail ?? '', consignorPhone: item.consignorPhone ?? '',
      title: item.title, description: item.description ?? '', category: item.category, brand: item.brand ?? '',
      condition: item.condition, askingPrice: item.askingPrice, commissionRate: item.commissionRate,
      notes: item.notes ?? '', listedInShop: item.listedInShop,
    });
    setShowForm(true);
  }

  async function handleSubmit() {
    if (!form.consignorName.trim() || !form.title.trim() || !form.askingPrice) {
      toast({ title: 'Missing fields', description: 'Consignor name, title, and asking price are required.', variant: 'destructive' }); return;
    }
    try {
      const url = editItem
        ? `/api/organizations/${orgId}/consignment/${editItem.id}`
        : `/api/organizations/${orgId}/consignment`;
      const method = editItem ? 'PUT' : 'POST';
      const res = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Failed'); }
      toast({ title: editItem ? 'Item updated' : 'Item created', description: editItem ? 'Consignment item has been updated.' : 'New consignment item has been added.' });
      setShowForm(false);
      invalidate();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'An error occurred', variant: 'destructive' });
    }
  }

  async function handleSell() {
    if (!targetItem || !sellForm.salePrice) return;
    try {
      const res = await fetch(`/api/organizations/${orgId}/consignment/${targetItem.id}/sell`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sellForm),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Failed'); }
      toast({ title: 'Sale recorded', description: 'Item marked as sold. Payout pending.' });
      setShowSellDialog(false); setSellForm({ salePrice: '' });
      invalidate();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'An error occurred', variant: 'destructive' });
    }
  }

  async function handlePay() {
    if (!targetItem || !payForm.payoutMethod) return;
    try {
      const res = await fetch(`/api/organizations/${orgId}/consignment/${targetItem.id}/pay`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payForm),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Failed'); }
      toast({ title: 'Payout recorded', description: 'Consignor payout has been marked as completed.' });
      setShowPayDialog(false); setPayForm({ payoutMethod: 'cash', payoutReference: '' });
      invalidate();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'An error occurred', variant: 'destructive' });
    }
  }

  async function handleReturn(item: ConsignmentItem) {
    if (!confirm(`Mark "${item.title}" as returned to consignor?`)) return;
    try {
      const res = await fetch(`/api/organizations/${orgId}/consignment/${item.id}/return`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Failed'); }
      toast({ title: 'Returned', description: 'Item marked for return and removed from inventory.' });
      invalidate();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'An error occurred', variant: 'destructive' });
    }
  }

  async function handleDelete(item: ConsignmentItem) {
    if (!confirm(`Delete "${item.title}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/organizations/${orgId}/consignment/${item.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Failed'); }
      toast({ title: 'Deleted', description: 'Consignment item removed.' });
      invalidate();
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'An error occurred', variant: 'destructive' });
    }
  }

  async function handleLookup() {
    if (!lookupToken.trim()) return;
    setLookupLoading(true); setLookupResult(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/consignment/lookup/${lookupToken.trim()}`, { credentials: 'include' });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error ?? 'Not found'); }
      const d = await res.json();
      setLookupResult(d.item);
    } catch (e: unknown) {
      toast({ title: 'Not found', description: e instanceof Error ? e.message : 'Item not found', variant: 'destructive' });
    } finally { setLookupLoading(false); }
  }

  const fmt = (v: string | null | undefined) => v ? parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';

  return (
    <div className="flex-1 overflow-auto bg-background p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Package className="w-6 h-6" style={{ color: GOLD }} />
            Consignment Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Track secondhand equipment left by members and third parties for sale</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="border-white/10 text-white hover:bg-white/5"
            onClick={() => { setShowLookupDialog(true); setLookupToken(''); setLookupResult(null); }}>
            <Search className="w-4 h-4 mr-2" />Consignor Lookup
          </Button>
          <Button size="sm" style={{ backgroundColor: GOLD, color: '#000' }} onClick={openCreate}>
            <Plus className="w-4 h-4 mr-2" />New Item
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="Unsold Items" value={unsoldCount} icon={Package} color="bg-white/10 text-white/60" />
        <SummaryCard label="Payout Pending" value={pendingCount} icon={Clock} color="bg-amber-500/20 text-amber-300" />
        <SummaryCard label="Paid Out" value={paidCount} icon={CheckCircle2} color="bg-emerald-500/20 text-emerald-300" />
        <SummaryCard label="Total Sales" value={`₹${totalSales.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`} icon={TrendingUp} color="bg-blue-500/20 text-blue-300" />
      </div>

      {/* Tabs + Search */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center gap-4 flex-wrap">
          <TabsList className="bg-card/50 border border-white/10">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="unsold">Unsold</TabsTrigger>
            <TabsTrigger value="payout_pending">Payout Pending</TabsTrigger>
            <TabsTrigger value="paid">Paid</TabsTrigger>
            <TabsTrigger value="returned">Returned</TabsTrigger>
          </TabsList>
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search items or consignors…"
              className="pl-9 bg-card/50 border-white/10 text-white placeholder:text-muted-foreground" />
          </div>
        </div>

        <TabsContent value={activeTab} className="mt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">Loading…</div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <Package className="w-12 h-12 opacity-30" />
              <p>No consignment items found</p>
              <Button size="sm" style={{ backgroundColor: GOLD, color: '#000' }} onClick={openCreate}>Add First Item</Button>
            </div>
          ) : (
            <div className="grid gap-3">
              {items.map(item => (
                <Card key={item.id} className="bg-card/50 border-white/10 hover:border-white/20 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      {/* Image placeholder */}
                      <div className="w-14 h-14 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {item.imageUrls?.[0] ? (
                          <img src={item.imageUrls[0]} alt={item.title} className="w-full h-full object-cover rounded-lg" />
                        ) : (
                          <ShoppingBag className="w-6 h-6 text-white/20" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-semibold text-white">{item.title}</h3>
                              {item.brand && <span className="text-xs text-muted-foreground">· {item.brand}</span>}
                              <StatusBadge status={item.status} />
                              {item.listedInShop && <Badge className="text-xs bg-blue-500/20 text-blue-300 border-blue-500/30">Listed Online</Badge>}
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground flex-wrap">
                              <span className="flex items-center gap-1"><User className="w-3.5 h-3.5" />{item.consignorName}</span>
                              {item.consignorPhone && <span className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" />{item.consignorPhone}</span>}
                              <span className="text-xs font-mono text-white/30">#{item.lookupToken}</span>
                            </div>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-white font-semibold">₹{fmt(item.salePrice ?? item.askingPrice)}</p>
                            {item.salePrice && item.salePrice !== item.askingPrice && (
                              <p className="text-xs text-muted-foreground line-through">₹{fmt(item.askingPrice)}</p>
                            )}
                            <p className="text-xs text-muted-foreground">{item.commissionRate}% commission</p>
                            {item.payoutAmount && <p className="text-xs text-emerald-400">Payout: ₹{fmt(item.payoutAmount)}</p>}
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-white"
                          title="View details" onClick={() => setDetailItem(item)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                        {item.status === 'unsold' && (
                          <>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-white"
                              title="Edit" onClick={() => openEdit(item)}>
                              <Edit2 className="w-4 h-4" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-emerald-400"
                              title="Record sale" onClick={() => { setTargetItem(item); setSellForm({ salePrice: item.askingPrice }); setShowSellDialog(true); }}>
                              <DollarSign className="w-4 h-4" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-amber-400"
                              title="Mark for return" onClick={() => handleReturn(item)}>
                              <RotateCcw className="w-4 h-4" />
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400"
                              title="Delete" onClick={() => handleDelete(item)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                        {item.status === 'payout_pending' && (
                          <>
                            <Button size="sm" variant="ghost" className="h-8 px-2 text-amber-400 hover:text-amber-300 text-xs"
                              onClick={() => { setTargetItem(item); setShowPayDialog(true); }}>
                              Mark Paid
                            </Button>
                            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-amber-400"
                              title="Mark for return" onClick={() => handleReturn(item)}>
                              <RotateCcw className="w-4 h-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create / Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-card border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editItem ? 'Edit Consignment Item' : 'New Consignment Item'}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            <div className="col-span-2">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider mb-2 block">Consignor Details</Label>
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Name *</Label>
              <Input value={form.consignorName} onChange={e => setForm(f => ({ ...f, consignorName: e.target.value }))}
                placeholder="Full name" className="mt-1 bg-white/5 border-white/10 text-white" />
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Phone</Label>
              <Input value={form.consignorPhone} onChange={e => setForm(f => ({ ...f, consignorPhone: e.target.value }))}
                placeholder="+91 98765 43210" className="mt-1 bg-white/5 border-white/10 text-white" />
            </div>
            <div className="col-span-2">
              <Label className="text-sm text-muted-foreground">Email</Label>
              <Input value={form.consignorEmail} onChange={e => setForm(f => ({ ...f, consignorEmail: e.target.value }))}
                placeholder="consignor@example.com" className="mt-1 bg-white/5 border-white/10 text-white" />
            </div>

            <div className="col-span-2 border-t border-white/5 pt-3">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider mb-2 block">Item Details</Label>
            </div>
            <div className="col-span-2">
              <Label className="text-sm text-muted-foreground">Item Title *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Callaway Driver – 10.5°" className="mt-1 bg-white/5 border-white/10 text-white" />
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Brand</Label>
              <Input value={form.brand} onChange={e => setForm(f => ({ ...f, brand: e.target.value }))}
                placeholder="Callaway, TaylorMade…" className="mt-1 bg-white/5 border-white/10 text-white" />
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Category</Label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="mt-1 bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-white/10">
                  {['equipment', 'clubs', 'balls', 'bags', 'apparel', 'accessories', 'other'].map(c => (
                    <SelectItem key={c} value={c} className="text-white capitalize">{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Condition</Label>
              <Select value={form.condition} onValueChange={v => setForm(f => ({ ...f, condition: v }))}>
                <SelectTrigger className="mt-1 bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-white/10">
                  {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k} className="text-white">{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Asking Price (₹) *</Label>
              <Input type="number" value={form.askingPrice} onChange={e => setForm(f => ({ ...f, askingPrice: e.target.value }))}
                placeholder="5000" className="mt-1 bg-white/5 border-white/10 text-white" />
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">Commission Rate (%)</Label>
              <Input type="number" value={form.commissionRate} onChange={e => setForm(f => ({ ...f, commissionRate: e.target.value }))}
                placeholder="20" min="0" max="100" className="mt-1 bg-white/5 border-white/10 text-white" />
            </div>
            {form.askingPrice && form.commissionRate && (
              <div className="col-span-2 p-3 rounded-lg bg-white/5 border border-white/10 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Commission ({form.commissionRate}%)</span>
                  <span>₹{(parseFloat(form.askingPrice || '0') * parseFloat(form.commissionRate || '0') / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-white font-semibold mt-1">
                  <span>Consignor Payout</span>
                  <span>₹{(parseFloat(form.askingPrice || '0') * (1 - parseFloat(form.commissionRate || '0') / 100)).toFixed(2)}</span>
                </div>
              </div>
            )}
            <div className="col-span-2">
              <Label className="text-sm text-muted-foreground">Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Item details, specifications, any defects…"
                className="mt-1 bg-white/5 border-white/10 text-white resize-none" rows={3} />
            </div>
            <div className="col-span-2">
              <Label className="text-sm text-muted-foreground">Notes (internal)</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Internal notes for staff…"
                className="mt-1 bg-white/5 border-white/10 text-white resize-none" rows={2} />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <input type="checkbox" id="listedInShop" checked={form.listedInShop} onChange={e => setForm(f => ({ ...f, listedInShop: e.target.checked }))}
                className="w-4 h-4 rounded" />
              <Label htmlFor="listedInShop" className="text-sm text-muted-foreground cursor-pointer">List in online shop</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" className="text-muted-foreground" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button style={{ backgroundColor: GOLD, color: '#000' }} onClick={handleSubmit}>
              {editItem ? 'Save Changes' : 'Create Item'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Record Sale Dialog */}
      <Dialog open={showSellDialog} onOpenChange={setShowSellDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Sale</DialogTitle>
          </DialogHeader>
          {targetItem && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">Recording sale for: <span className="text-white font-medium">{targetItem.title}</span></p>
              <div>
                <Label className="text-sm text-muted-foreground">Sale Price (₹) *</Label>
                <Input type="number" value={sellForm.salePrice} onChange={e => setSellForm(f => ({ ...f, salePrice: e.target.value }))}
                  className="mt-1 bg-white/5 border-white/10 text-white" />
              </div>
              {sellForm.salePrice && (
                <div className="p-3 rounded-lg bg-white/5 border border-white/10 text-sm space-y-1">
                  <div className="flex justify-between text-muted-foreground">
                    <span>Commission ({targetItem.commissionRate}%)</span>
                    <span>₹{(parseFloat(sellForm.salePrice || '0') * parseFloat(targetItem.commissionRate) / 100).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-white font-semibold">
                    <span>Consignor Payout</span>
                    <span>₹{(parseFloat(sellForm.salePrice || '0') * (1 - parseFloat(targetItem.commissionRate) / 100)).toFixed(2)}</span>
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" className="text-muted-foreground" onClick={() => setShowSellDialog(false)}>Cancel</Button>
            <Button style={{ backgroundColor: GOLD, color: '#000' }} onClick={handleSell}>Confirm Sale</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark Payout Paid Dialog */}
      <Dialog open={showPayDialog} onOpenChange={setShowPayDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Payout</DialogTitle>
          </DialogHeader>
          {targetItem && (
            <div className="space-y-4 py-2">
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <p className="text-sm text-muted-foreground">Paying out to <span className="text-white font-medium">{targetItem.consignorName}</span></p>
                <p className="text-xl font-bold text-emerald-400 mt-1">₹{fmt(targetItem.payoutAmount)}</p>
              </div>
              <div>
                <Label className="text-sm text-muted-foreground">Payment Method *</Label>
                <Select value={payForm.payoutMethod} onValueChange={v => setPayForm(f => ({ ...f, payoutMethod: v }))}>
                  <SelectTrigger className="mt-1 bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-card border-white/10">
                    {Object.entries(PAYOUT_METHOD_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k} className="text-white">{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm text-muted-foreground">Reference / Transaction ID</Label>
                <Input value={payForm.payoutReference} onChange={e => setPayForm(f => ({ ...f, payoutReference: e.target.value }))}
                  placeholder="Optional reference…" className="mt-1 bg-white/5 border-white/10 text-white" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" className="text-muted-foreground" onClick={() => setShowPayDialog(false)}>Cancel</Button>
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handlePay}>Confirm Payout</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Item Detail Dialog */}
      <Dialog open={!!detailItem} onOpenChange={() => setDetailItem(null)}>
        <DialogContent className="bg-card border-white/10 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>{detailItem?.title}</DialogTitle>
          </DialogHeader>
          {detailItem && (
            <div className="space-y-4 py-2 text-sm">
              <div className="flex items-center justify-between">
                <StatusBadge status={detailItem.status} />
                <span className="text-xs font-mono text-muted-foreground">Token: {detailItem.lookupToken}</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-muted-foreground text-xs">Consignor</p><p className="text-white">{detailItem.consignorName}</p></div>
                <div><p className="text-muted-foreground text-xs">Phone</p><p className="text-white">{detailItem.consignorPhone ?? '—'}</p></div>
                <div><p className="text-muted-foreground text-xs">Email</p><p className="text-white">{detailItem.consignorEmail ?? '—'}</p></div>
                <div><p className="text-muted-foreground text-xs">Category</p><p className="text-white capitalize">{detailItem.category}</p></div>
                <div><p className="text-muted-foreground text-xs">Condition</p><p className="text-white">{CONDITION_LABELS[detailItem.condition] ?? detailItem.condition}</p></div>
                <div><p className="text-muted-foreground text-xs">Brand</p><p className="text-white">{detailItem.brand ?? '—'}</p></div>
                <div><p className="text-muted-foreground text-xs">Asking Price</p><p className="text-white">₹{fmt(detailItem.askingPrice)}</p></div>
                <div><p className="text-muted-foreground text-xs">Commission Rate</p><p className="text-white">{detailItem.commissionRate}%</p></div>
                {detailItem.salePrice && <>
                  <div><p className="text-muted-foreground text-xs">Sale Price</p><p className="text-white">₹{fmt(detailItem.salePrice)}</p></div>
                  <div><p className="text-muted-foreground text-xs">Commission</p><p className="text-white">₹{fmt(detailItem.commissionAmount)}</p></div>
                  <div><p className="text-muted-foreground text-xs">Consignor Payout</p><p className="text-emerald-400 font-semibold">₹{fmt(detailItem.payoutAmount)}</p></div>
                  <div><p className="text-muted-foreground text-xs">Sold On</p><p className="text-white">{detailItem.soldAt ? new Date(detailItem.soldAt).toLocaleDateString() : '—'}</p></div>
                </>}
                {detailItem.paidAt && <>
                  <div><p className="text-muted-foreground text-xs">Payout Method</p><p className="text-white">{PAYOUT_METHOD_LABELS[detailItem.payoutMethod ?? ''] ?? detailItem.payoutMethod}</p></div>
                  <div><p className="text-muted-foreground text-xs">Paid On</p><p className="text-white">{new Date(detailItem.paidAt).toLocaleDateString()}</p></div>
                  {detailItem.payoutReference && <div className="col-span-2"><p className="text-muted-foreground text-xs">Reference</p><p className="text-white">{detailItem.payoutReference}</p></div>}
                </>}
              </div>
              {detailItem.description && (
                <div><p className="text-muted-foreground text-xs mb-1">Description</p><p className="text-white/80">{detailItem.description}</p></div>
              )}
              {detailItem.notes && (
                <div><p className="text-muted-foreground text-xs mb-1">Internal Notes</p><p className="text-white/60">{detailItem.notes}</p></div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Consignor Lookup Dialog */}
      <Dialog open={showLookupDialog} onOpenChange={setShowLookupDialog}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>Consignor Item Lookup</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">Enter the tracking code provided to the consignor to check item status.</p>
            <div className="flex gap-2">
              <Input value={lookupToken} onChange={e => setLookupToken(e.target.value.toUpperCase())}
                placeholder="e.g. A1B2C3"
                className="bg-white/5 border-white/10 text-white font-mono uppercase tracking-widest"
                onKeyDown={e => e.key === 'Enter' && handleLookup()} />
              <Button onClick={handleLookup} disabled={lookupLoading} style={{ backgroundColor: GOLD, color: '#000' }}>
                {lookupLoading ? 'Searching…' : 'Look Up'}
              </Button>
            </div>
            {lookupResult && (
              <div className="p-4 rounded-lg bg-white/5 border border-white/10 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-white">{lookupResult.title}</h3>
                  <StatusBadge status={lookupResult.status} />
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div><p className="text-muted-foreground text-xs">Category</p><p className="text-white capitalize">{lookupResult.category}</p></div>
                  <div><p className="text-muted-foreground text-xs">Condition</p><p className="text-white">{CONDITION_LABELS[lookupResult.condition] ?? lookupResult.condition}</p></div>
                  <div><p className="text-muted-foreground text-xs">Asking Price</p><p className="text-white">₹{fmt(lookupResult.askingPrice)}</p></div>
                  <div><p className="text-muted-foreground text-xs">Commission</p><p className="text-white">{lookupResult.commissionRate}%</p></div>
                  {lookupResult.salePrice && <>
                    <div><p className="text-muted-foreground text-xs">Sale Price</p><p className="text-white">₹{fmt(lookupResult.salePrice)}</p></div>
                    <div><p className="text-muted-foreground text-xs">Your Payout</p><p className="text-emerald-400 font-semibold">₹{fmt(lookupResult.payoutAmount)}</p></div>
                  </>}
                  {lookupResult.paidAt && <div className="col-span-2"><p className="text-muted-foreground text-xs">Paid On</p><p className="text-white">{new Date(lookupResult.paidAt).toLocaleDateString()}</p></div>}
                  {lookupResult.returnedAt && <div className="col-span-2"><p className="text-muted-foreground text-xs">Returned On</p><p className="text-white">{new Date(lookupResult.returnedAt).toLocaleDateString()}</p></div>}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
