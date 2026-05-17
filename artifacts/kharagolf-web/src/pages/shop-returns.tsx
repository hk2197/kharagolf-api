import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  RotateCcw, AlertTriangle, CheckCircle2, XCircle, Package, Shield,
  RefreshCw, Clock, ChevronDown, ChevronUp, Ban, BarChart3,
  AlertCircle, Eye, ArrowRightLeft, Filter,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

interface ShopReturn {
  id: number;
  orderId: number | null;
  posTransactionId: number | null;
  sourceType: string;
  customerName: string;
  customerEmail: string;
  reason: string;
  reasonDetail: string | null;
  status: string;
  returnType: string;
  refundAmount: string | null;
  currency: string;
  fraudScore: number;
  fraudFlag: boolean;
  fraudFlagReason: string | null;
  adminNotes: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface ReturnDetail extends ShopReturn {
  items: Array<{
    id: number;
    productName: string;
    size: string | null;
    color: string | null;
    quantity: number;
    unitPrice: string;
    restocked: boolean;
  }>;
  razorpayRefundId?: string | null;
  posRefundMethod?: string | null;
  creditNoteAmount?: string | null;
  fraudFlagReason?: string | null;
  fraudOverriddenAt?: string | null;
}

interface ReturnsAnalytics {
  totalReturns: number;
  returnRate: string;
  refundedCount: number;
  totalRefundAmount: number;
  fraudFlagCount: number;
  restockedUnits: number;
  reasonBreakdown: Array<{ reason: string; cnt: number }>;
  productReturnRates: Array<{ productId: number | null; productName: string; returnCount: number; orderCount: number; returnRate: string }>;
  monthlyTrend: Array<{ month: string; returnCount: number; totalRefundAmount: number }>;
}

interface BlacklistEntry {
  id: number;
  userId: number;
  reason: string | null;
  createdAt: string;
  userName: string | null;
  userEmail: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  approved: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  rejected: 'bg-red-500/20 text-red-400 border-red-500/30',
  received: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  refunded: 'bg-green-500/20 text-green-400 border-green-500/30',
  flagged: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  exchanged: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

const REASON_LABELS: Record<string, string> = {
  wrong_size: 'Wrong Size',
  defective: 'Defective',
  changed_mind: 'Changed Mind',
  wrong_item: 'Wrong Item',
  damaged_in_shipping: 'Damaged in Shipping',
  other: 'Other',
};

const CURRENCY_SYM: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };
const fmt = (amount: string | number, currency = 'INR') =>
  `${CURRENCY_SYM[currency] ?? currency}${parseFloat(String(amount)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function FraudScoreBadge({ score, flagged }: { score: number; flagged: boolean }) {
  const color = flagged ? 'text-orange-400 bg-orange-500/20 border-orange-500/30'
    : score >= 40 ? 'text-yellow-400 bg-yellow-500/20 border-yellow-500/30'
    : 'text-green-400 bg-green-500/20 border-green-500/30';
  return (
    <Badge className={`border text-xs gap-1 ${color}`}>
      {flagged && <AlertTriangle className="w-3 h-3" />}
      Score: {score}
    </Badge>
  );
}

export default function ShopReturnsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const orgId = (me as { organizationId?: number } | undefined)?.organizationId;

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [fraudFilter, setFraudFilter] = useState(false);
  const [detailReturn, setDetailReturn] = useState<ReturnDetail | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [adminNotes, setAdminNotes] = useState('');
  const [exchangeVariantId, setExchangeVariantId] = useState('');
  const [blacklistReason, setBlacklistReason] = useState('');
  const [showBlacklist, setShowBlacklist] = useState(false);

  const returnsUrl = orgId
    ? `/api/organizations/${orgId}/shop/returns${statusFilter !== 'all' ? `?status=${statusFilter}` : ''}${fraudFilter ? (statusFilter !== 'all' ? '&' : '?') + 'flagged=true' : ''}`
    : null;

  const { data: returns = [], isLoading } = useQuery<ShopReturn[]>({
    queryKey: [`/api/organizations/${orgId}/shop/returns`, statusFilter, fraudFilter],
    queryFn: () => fetch(returnsUrl!, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: analytics } = useQuery<ReturnsAnalytics>({
    queryKey: [`/api/organizations/${orgId}/shop/returns-analytics`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/returns-analytics`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: blacklist = [] } = useQuery<BlacklistEntry[]>({
    queryKey: [`/api/organizations/${orgId}/shop/blacklist`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/blacklist`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && showBlacklist,
  });

  async function openDetail(ret: ShopReturn) {
    const r = await fetch(`/api/organizations/${orgId}/shop/returns/${ret.id}`, { credentials: 'include' });
    const data = await r.json();
    setDetailReturn(data);
    setAdminNotes(data.adminNotes ?? '');
    setExchangeVariantId('');
  }

  async function doAction(action: string, extra?: Record<string, unknown>) {
    if (!detailReturn || !orgId) return;
    setActionLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/shop/returns/${detailReturn.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, adminNotes, ...extra }),
      });
      if (!r.ok) {
        const err = await r.json();
        toast({ title: 'Error', description: err.error ?? 'Action failed', variant: 'destructive' });
        return;
      }
      toast({ title: 'Success', description: `Return ${action}d successfully` });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/returns`] });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/returns-analytics`] });
      setDetailReturn(null);
    } catch {
      toast({ title: 'Error', description: 'Request failed', variant: 'destructive' });
    } finally {
      setActionLoading(false);
    }
  }

  async function doExchange() {
    if (!detailReturn || !orgId || !exchangeVariantId) return;
    setActionLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/shop/returns/${detailReturn.id}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newVariantId: parseInt(exchangeVariantId), adminNotes }),
      });
      if (!r.ok) {
        const err = await r.json();
        toast({ title: 'Error', description: err.error ?? 'Exchange failed', variant: 'destructive' });
        return;
      }
      toast({ title: 'Success', description: 'Exchange processed successfully' });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/returns`] });
      setDetailReturn(null);
    } catch {
      toast({ title: 'Error', description: 'Request failed', variant: 'destructive' });
    } finally {
      setActionLoading(false);
    }
  }

  async function blacklistUser(userId: number) {
    if (!orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/shop/blacklist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId, reason: blacklistReason }),
    });
    if (!r.ok) {
      const err = await r.json();
      toast({ title: 'Error', description: err.error, variant: 'destructive' });
      return;
    }
    toast({ title: 'User blacklisted', description: 'This account cannot submit future returns.' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/blacklist`] });
    setBlacklistReason('');
  }

  async function removeFromBlacklist(userId: number) {
    if (!orgId) return;
    await fetch(`/api/organizations/${orgId}/shop/blacklist/${userId}`, { method: 'DELETE', credentials: 'include' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/blacklist`] });
    toast({ title: 'Removed from blacklist' });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto p-8 space-y-6">
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <RotateCcw className="w-6 h-6 text-primary" />
                <h1 className="text-2xl font-display font-bold text-white tracking-tight">Returns & Refunds</h1>
              </div>
              <p className="text-muted-foreground text-sm">Manage return requests, approve refunds, process exchanges, and track fraud signals</p>
            </div>
            <Button variant="outline" onClick={() => setShowBlacklist(true)}
              className="border-red-500/30 text-red-400 hover:bg-red-500/10 gap-2">
              <Ban className="w-4 h-4" /> Blacklist
            </Button>
          </div>
        </motion.div>

        {/* Analytics summary */}
        {analytics && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              { label: 'Total Returns', value: analytics.totalReturns, icon: RotateCcw, color: 'text-primary' },
              { label: 'Return Rate', value: analytics.returnRate, icon: BarChart3, color: 'text-blue-400' },
              { label: 'Refunded', value: analytics.refundedCount, icon: CheckCircle2, color: 'text-green-400' },
              { label: 'Refund Volume', value: fmt(analytics.totalRefundAmount, 'INR'), icon: RefreshCw, color: 'text-cyan-400' },
              { label: 'Fraud Flags', value: analytics.fraudFlagCount, icon: AlertTriangle, color: 'text-orange-400' },
              { label: 'Restocked Units', value: analytics.restockedUnits, icon: Package, color: 'text-purple-400' },
            ].map(card => (
              <Card key={card.label} className="glass-card">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <card.icon className={`w-4 h-4 ${card.color}`} />
                    <span className="text-muted-foreground text-xs">{card.label}</span>
                  </div>
                  <p className={`text-xl font-bold ${card.color}`}>{card.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Reason breakdown + Product return rates + Monthly trend */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {analytics?.reasonBreakdown && analytics.reasonBreakdown.length > 0 && (
            <Card className="glass-card">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-white text-sm flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-blue-400" /> Top Return Reasons
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="flex flex-wrap gap-2">
                  {analytics.reasonBreakdown.map(r => (
                    <Badge key={r.reason} className="bg-white/10 text-white border border-white/10 text-xs">
                      {REASON_LABELS[r.reason] ?? r.reason}: {Number(r.cnt)}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {analytics?.productReturnRates && analytics.productReturnRates.length > 0 && (
            <Card className="glass-card">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-white text-sm flex items-center gap-2">
                  <Package className="w-4 h-4 text-purple-400" /> Return Rate by Product
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {analytics.productReturnRates.map(p => (
                    <div key={p.productId ?? p.productName} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground truncate max-w-[60%]">{p.productName}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{p.returnCount} returned</span>
                        <Badge className={`text-[10px] ${parseFloat(p.returnRate) > 15 ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-white/10 text-white border-white/10'}`}>
                          {p.returnRate}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {analytics?.monthlyTrend && analytics.monthlyTrend.length > 0 && (
            <Card className="glass-card">
              <CardHeader className="pb-2 pt-3 px-4">
                <CardTitle className="text-white text-sm flex items-center gap-2">
                  <BarChart3 className="w-4 h-4 text-cyan-400" /> Monthly Trend
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {analytics.monthlyTrend.slice(-12).map(m => (
                    <div key={m.month} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{m.month}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-white font-medium">{m.returnCount} returns</span>
                        <span className="text-cyan-400">{fmt(m.totalRefundAmount, 'INR')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44 bg-black/40 border-white/10 text-white">
              <Filter className="w-3.5 h-3.5 mr-2 text-muted-foreground" />
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent className="bg-[#0a1628] border-white/10">
              {['all', 'pending', 'flagged', 'received', 'approved', 'refunded', 'rejected', 'exchanged'].map(s => (
                <SelectItem key={s} value={s} className="text-white capitalize">{s === 'all' ? 'All Statuses' : s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFraudFilter(f => !f)}
            className={`gap-2 text-xs ${fraudFilter ? 'border-orange-500/50 text-orange-400 bg-orange-500/10' : 'border-white/10 text-muted-foreground'}`}
          >
            <AlertTriangle className="w-3.5 h-3.5" /> Flagged Only
          </Button>
        </div>

        {/* Returns queue */}
        <Card className="glass-card overflow-hidden">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-white text-sm flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-primary" /> Returns Queue
              {returns.length > 0 && <Badge className="bg-primary/20 text-primary border border-primary/30 text-xs">{returns.length}</Badge>}
            </CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 hover:bg-transparent">
                  <TableHead className="text-muted-foreground text-xs">Customer</TableHead>
                  <TableHead className="text-muted-foreground text-xs">Reason</TableHead>
                  <TableHead className="text-muted-foreground text-xs">Amount</TableHead>
                  <TableHead className="text-muted-foreground text-xs">Source</TableHead>
                  <TableHead className="text-muted-foreground text-xs">Status</TableHead>
                  <TableHead className="text-muted-foreground text-xs">Fraud</TableHead>
                  <TableHead className="text-muted-foreground text-xs">Date</TableHead>
                  <TableHead className="text-muted-foreground text-xs">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                      <RefreshCw className="w-4 h-4 animate-spin inline mr-2" /> Loading...
                    </TableCell>
                  </TableRow>
                ) : returns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12">
                      <RotateCcw className="w-10 h-10 text-white/10 mx-auto mb-3" />
                      <p className="text-muted-foreground text-sm">No returns found</p>
                    </TableCell>
                  </TableRow>
                ) : returns.map(ret => (
                  <TableRow key={ret.id} className={`border-white/5 hover:bg-white/[0.02] ${ret.fraudFlag ? 'bg-orange-500/5' : ''}`}>
                    <TableCell>
                      <div className="font-medium text-white text-sm">{ret.customerName}</div>
                      <div className="text-muted-foreground text-xs">{ret.customerEmail}</div>
                    </TableCell>
                    <TableCell>
                      <span className="text-white text-sm">{REASON_LABELS[ret.reason] ?? ret.reason}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-white font-medium text-sm">
                        {ret.refundAmount ? fmt(ret.refundAmount, ret.currency) : '—'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge className={`text-xs border ${ret.sourceType === 'pos' ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' : 'bg-blue-500/20 text-blue-400 border-blue-500/30'}`}>
                        {ret.sourceType === 'pos' ? 'POS' : 'Online'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={`border text-xs capitalize ${STATUS_COLORS[ret.status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                        {ret.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <FraudScoreBadge score={ret.fraudScore} flagged={ret.fraudFlag} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(ret.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-white"
                        onClick={() => openDetail(ret)}>
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>

        {/* Return detail dialog */}
        <Dialog open={!!detailReturn} onOpenChange={o => { if (!o) setDetailReturn(null); }}>
          <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white">
                <RotateCcw className="w-5 h-5 text-primary" />
                Return #{detailReturn?.id} — {detailReturn?.customerName}
              </DialogTitle>
            </DialogHeader>
            {detailReturn && (
              <div className="space-y-4 mt-2">
                {/* Fraud alert */}
                {detailReturn.fraudFlag && (
                  <div className="flex items-start gap-3 p-4 bg-orange-500/10 border border-orange-500/30 rounded-xl">
                    <AlertTriangle className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-orange-400 font-semibold text-sm">Fraud Detection Alert</p>
                      <p className="text-orange-300/80 text-xs mt-1">Score: {detailReturn.fraudScore}/100</p>
                      {detailReturn.fraudFlagReason && (
                        <p className="text-orange-300/70 text-xs mt-0.5">{detailReturn.fraudFlagReason}</p>
                      )}
                    </div>
                    <Button size="sm" variant="outline"
                      className="ml-auto border-orange-500/30 text-orange-400 hover:bg-orange-500/10 text-xs flex-shrink-0"
                      disabled={actionLoading}
                      onClick={() => doAction('override_fraud')}>
                      <Shield className="w-3.5 h-3.5 mr-1.5" /> Override Flag
                    </Button>
                  </div>
                )}

                {/* Details grid */}
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { label: 'Status', value: <Badge className={`border text-xs capitalize ${STATUS_COLORS[detailReturn.status] ?? ''}`}>{detailReturn.status}</Badge> },
                    { label: 'Source', value: detailReturn.sourceType === 'pos' ? 'POS (in-person)' : 'Online order' },
                    { label: 'Reason', value: REASON_LABELS[detailReturn.reason] ?? detailReturn.reason },
                    { label: 'Type', value: detailReturn.returnType === 'exchange' ? 'Exchange' : 'Refund' },
                    { label: 'Refund Amount', value: detailReturn.refundAmount ? fmt(detailReturn.refundAmount, detailReturn.currency) : '—' },
                    { label: 'Order Ref', value: detailReturn.orderId ? `#${detailReturn.orderId}` : (detailReturn.posTransactionId ? `POS #${detailReturn.posTransactionId}` : '—') },
                    { label: 'Fraud Score', value: <FraudScoreBadge score={detailReturn.fraudScore} flagged={detailReturn.fraudFlag} /> },
                    { label: 'Date', value: new Date(detailReturn.createdAt).toLocaleDateString() },
                  ].map(({ label, value }) => (
                    <div key={label} className="p-3 bg-white/5 rounded-lg">
                      <p className="text-muted-foreground text-xs mb-1">{label}</p>
                      <div className="text-white text-sm font-medium">{value}</div>
                    </div>
                  ))}
                </div>

                {/* Detail notes */}
                {detailReturn.reasonDetail && (
                  <div className="p-3 bg-white/5 rounded-lg">
                    <p className="text-muted-foreground text-xs mb-1">Customer Notes</p>
                    <p className="text-white text-sm">{detailReturn.reasonDetail}</p>
                  </div>
                )}

                {/* Return items */}
                {detailReturn.items.length > 0 && (
                  <div>
                    <p className="text-muted-foreground text-xs mb-2 uppercase tracking-wider">Return Items</p>
                    <div className="space-y-2">
                      {detailReturn.items.map(item => (
                        <div key={item.id} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                          <div>
                            <p className="text-white text-sm font-medium">{item.productName}</p>
                            <p className="text-muted-foreground text-xs">
                              {[item.size, item.color].filter(Boolean).join(' / ') || '—'} × {item.quantity}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-white text-sm">{fmt(parseFloat(item.unitPrice) * item.quantity, detailReturn.currency)}</span>
                            {item.restocked && (
                              <Badge className="bg-green-500/20 text-green-400 border border-green-500/30 text-xs">Restocked</Badge>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Admin notes */}
                <div>
                  <label className="text-muted-foreground text-xs uppercase tracking-wider mb-2 block">Admin Notes</label>
                  <Textarea
                    value={adminNotes}
                    onChange={e => setAdminNotes(e.target.value)}
                    placeholder="Add notes visible to staff only..."
                    className="bg-black/40 border-white/10 text-white placeholder:text-white/30 text-sm min-h-[80px]"
                  />
                </div>

                {/* Exchange variant */}
                {['pending', 'received', 'approved'].includes(detailReturn.status) && (
                  <div>
                    <label className="text-muted-foreground text-xs uppercase tracking-wider mb-2 block">Exchange — New Variant ID</label>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        value={exchangeVariantId}
                        onChange={e => setExchangeVariantId(e.target.value)}
                        placeholder="Enter variant ID for exchange..."
                        className="bg-black/40 border-white/10 text-white placeholder:text-white/30"
                      />
                      <Button
                        onClick={doExchange}
                        disabled={!exchangeVariantId || actionLoading}
                        className="bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/30 gap-2 flex-shrink-0"
                      >
                        <ArrowRightLeft className="w-4 h-4" /> Exchange
                      </Button>
                    </div>
                  </div>
                )}

                {/* Blacklist button */}
                <div className="flex items-center gap-2">
                  <Input
                    value={blacklistReason}
                    onChange={e => setBlacklistReason(e.target.value)}
                    placeholder="Reason to blacklist this customer..."
                    className="bg-black/40 border-white/10 text-white placeholder:text-white/30 text-sm"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!blacklistReason}
                    onClick={async () => {
                      const userId = (detailReturn as ShopReturn & { userId?: number }).userId;
                      if (!userId) { toast({ title: 'Cannot blacklist', description: 'No user ID on this return (guest return)', variant: 'destructive' }); return; }
                      await blacklistUser(userId as number);
                    }}
                    className="border-red-500/30 text-red-400 hover:bg-red-500/10 gap-2 flex-shrink-0"
                  >
                    <Ban className="w-4 h-4" /> Blacklist
                  </Button>
                </div>

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
                  {['pending', 'flagged', 'received'].includes(detailReturn.status) && (
                    <Button
                      onClick={() => doAction('approve')}
                      disabled={actionLoading}
                      className="bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/30 gap-2"
                    >
                      <CheckCircle2 className="w-4 h-4" /> Approve & Refund
                    </Button>
                  )}
                  {['pending', 'flagged', 'received', 'approved'].includes(detailReturn.status) && (
                    <>
                      <Button
                        onClick={() => doAction('received')}
                        disabled={actionLoading}
                        variant="outline"
                        className="border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 gap-2"
                      >
                        <Package className="w-4 h-4" /> Mark Received
                      </Button>
                      <Button
                        onClick={() => doAction('reject')}
                        disabled={actionLoading}
                        variant="outline"
                        className="border-red-500/30 text-red-400 hover:bg-red-500/10 gap-2"
                      >
                        <XCircle className="w-4 h-4" /> Reject
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Blacklist management dialog */}
        <Dialog open={showBlacklist} onOpenChange={setShowBlacklist}>
          <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white">
                <Ban className="w-5 h-5 text-red-400" /> Blacklisted Accounts
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              {blacklist.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-8">No accounts are currently blacklisted.</p>
              ) : blacklist.map(entry => (
                <div key={entry.id} className="flex items-center justify-between p-3 bg-white/5 rounded-lg">
                  <div>
                    <p className="text-white text-sm font-medium">{entry.userName ?? 'Unknown'}</p>
                    <p className="text-muted-foreground text-xs">{entry.userEmail ?? '—'}</p>
                    {entry.reason && <p className="text-red-400/70 text-xs mt-0.5">{entry.reason}</p>}
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => removeFromBlacklist(entry.userId)}
                    className="text-muted-foreground hover:text-white text-xs gap-1">
                    <XCircle className="w-3.5 h-3.5" /> Remove
                  </Button>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
