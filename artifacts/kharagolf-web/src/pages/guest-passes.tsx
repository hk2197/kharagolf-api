import { useState } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  Users, UserPlus, QrCode, BarChart3, Settings, Plus, Trash2, CheckCircle2,
  AlertCircle, Clock, X, DollarSign, Scan, RefreshCw,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef } from 'react';

const GOLD = '#C9A84C';

function statusColor(status: string) {
  switch (status) {
    case 'confirmed': return 'text-emerald-400 bg-emerald-500/20';
    case 'checked_in': return 'text-blue-400 bg-blue-500/20';
    case 'pending': return 'text-amber-400 bg-amber-500/20';
    case 'no_show': return 'text-red-400 bg-red-500/20';
    case 'cancelled': return 'text-slate-400 bg-slate-500/20';
    case 'paid': return 'text-emerald-400 bg-emerald-500/20';
    case 'pending_payment': return 'text-amber-400 bg-amber-500/20';
    case 'refunded': return 'text-purple-400 bg-purple-500/20';
    default: return 'text-slate-400 bg-slate-500/20';
  }
}

function fmtDate(d: string | Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtMoney(v: string | number | null) {
  if (v == null) return '₹0';
  return `₹${parseFloat(String(v)).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`;
}

function QrDisplay({ token, orgId }: { token: string; orgId: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrData = `${window.location.origin}/guest-checkin?org=${orgId}&token=${token}`;
  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, qrData, { width: 160, margin: 1 }).catch(() => {});
    }
  }, [qrData]);
  return <canvas ref={canvasRef} className="rounded-lg" />;
}

export default function GuestPassesPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId as number;
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = ['super_admin', 'org_admin', 'tournament_director'].includes(user?.role ?? '');

  const [activeTab, setActiveTab] = useState('guests');
  const [showNewPass, setShowNewPass] = useState(false);
  const [showQr, setShowQr] = useState<{ token: string; guestName: string } | null>(null);
  const [showScan, setShowScan] = useState(false);
  const [scanToken, setScanToken] = useState('');
  const [scanResult, setScanResult] = useState<{ type: string; pass: Record<string, unknown>; warning?: string } | null>(null);
  const [showPricingDialog, setShowPricingDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<Record<string, unknown> | null>(null);
  const [reportFrom, setReportFrom] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 2); return d.toISOString().split('T')[0];
  });
  const [reportTo, setReportTo] = useState(() => new Date().toISOString().split('T')[0]);

  const [newPass, setNewPass] = useState({
    guestName: '', guestEmail: '', guestPhone: '', playDate: '', feeSettlement: 'pay_at_desk', notes: '',
  });
  const [pricingForm, setPricingForm] = useState({
    label: '', description: '', weekdayRate: '', weekendRate: '', twilightRate: '', reciprocalRate: '', isActive: true, sortOrder: 0,
  });

  const { data: guestPasses = [], isLoading: loadingGuests } = useQuery({
    queryKey: [`/api/organizations/${orgId}/guest-passes`],
    queryFn: () => fetch(`/api/organizations/${orgId}/guest-passes`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && isAdmin,
  });
  const { data: myPasses = [] } = useQuery({
    queryKey: [`/api/organizations/${orgId}/guest-passes/my`],
    queryFn: () => fetch(`/api/organizations/${orgId}/guest-passes/my`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && !isAdmin,
  });
  const passes = isAdmin ? guestPasses : myPasses;

  const { data: visitorPasses = [], isLoading: loadingVisitors } = useQuery({
    queryKey: [`/api/organizations/${orgId}/visitor-passes`],
    queryFn: () => fetch(`/api/organizations/${orgId}/visitor-passes`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && isAdmin,
  });

  const { data: pricingRules = [] } = useQuery({
    queryKey: [`/api/organizations/${orgId}/visitor-pricing`],
    queryFn: () => fetch(`/api/organizations/${orgId}/visitor-pricing`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && isAdmin,
  });

  const { data: policy } = useQuery({
    queryKey: [`/api/organizations/${orgId}/guest-policy`],
    queryFn: () => fetch(`/api/organizations/${orgId}/guest-policy`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: report } = useQuery({
    queryKey: [`/api/organizations/${orgId}/guest-passes/report`, reportFrom, reportTo],
    queryFn: () => fetch(`/api/organizations/${orgId}/guest-passes/report?from=${reportFrom}&to=${reportTo}`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && isAdmin && activeTab === 'report',
  });

  const createPassMutation = useMutation({
    mutationFn: (data: typeof newPass) => fetch(`/api/organizations/${orgId}/guest-passes`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, greenFee: 0 }),
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e))),
    onSuccess: (pass) => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/guest-passes`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/guest-passes/my`] });
      setShowNewPass(false);
      setShowQr({ token: pass.qrToken, guestName: pass.guestName });
      toast({ title: 'Guest pass created', description: `Pass for ${pass.guestName} is ready.` });
    },
    onError: (e: { error?: string }) => toast({ title: 'Error', description: e.error ?? 'Failed', variant: 'destructive' }),
  });

  const cancelPassMutation = useMutation({
    mutationFn: (passId: number) => fetch(`/api/organizations/${orgId}/guest-passes/${passId}`, {
      method: 'DELETE', credentials: 'include',
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/guest-passes`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/guest-passes/my`] });
      toast({ title: 'Guest pass cancelled' });
    },
  });

  const scanMutation = useMutation({
    mutationFn: (token: string) => fetch(`/api/organizations/${orgId}/checkin/scan`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qrToken: token }),
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e))),
    onSuccess: (data) => {
      setScanResult(data);
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/guest-passes`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/visitor-passes`] });
    },
    onError: (e: { error?: string }) => {
      setScanResult(null);
      toast({ title: 'Check-in failed', description: e.error ?? 'QR code not found', variant: 'destructive' });
    },
  });

  const createPricingMutation = useMutation({
    mutationFn: (data: typeof pricingForm) => fetch(`/api/organizations/${orgId}/visitor-pricing`, {
      method: editingRule ? 'PUT' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/visitor-pricing`] });
      setShowPricingDialog(false);
      setEditingRule(null);
      toast({ title: editingRule ? 'Pricing rule updated' : 'Pricing rule created' });
    },
  });

  const deletePricingMutation = useMutation({
    mutationFn: (ruleId: number) => fetch(`/api/organizations/${orgId}/visitor-pricing/${ruleId}`, {
      method: 'DELETE', credentials: 'include',
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/visitor-pricing`] });
      toast({ title: 'Pricing rule deleted' });
    },
  });

  function handleScan() {
    if (!scanToken.trim()) return;
    scanMutation.mutate(scanToken.trim());
  }

  function openPricingCreate() {
    setEditingRule(null);
    setPricingForm({ label: '', description: '', weekdayRate: '', weekendRate: '', twilightRate: '', reciprocalRate: '', isActive: true, sortOrder: 0 });
    setShowPricingDialog(true);
  }

  function openPricingEdit(rule: Record<string, unknown>) {
    setEditingRule(rule);
    setPricingForm({
      label: String(rule.label ?? ''),
      description: String(rule.description ?? ''),
      weekdayRate: String(rule.weekdayRate ?? ''),
      weekendRate: String(rule.weekendRate ?? ''),
      twilightRate: String(rule.twilightRate ?? ''),
      reciprocalRate: String(rule.reciprocalRate ?? ''),
      isActive: rule.isActive as boolean ?? true,
      sortOrder: Number(rule.sortOrder ?? 0),
    });
    setShowPricingDialog(true);
  }

  function savePricing() {
    if (editingRule) {
      fetch(`/api/organizations/${orgId}/visitor-pricing/${editingRule.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pricingForm),
      }).then(() => {
        qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/visitor-pricing`] });
        setShowPricingDialog(false);
        setEditingRule(null);
        toast({ title: 'Pricing rule updated' });
      });
    } else {
      fetch(`/api/organizations/${orgId}/visitor-pricing`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pricingForm),
      }).then(() => {
        qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/visitor-pricing`] });
        setShowPricingDialog(false);
        toast({ title: 'Pricing rule created' });
      });
    }
  }

  const allPasses = Array.isArray(passes) ? passes : [];
  const allVisitors = Array.isArray(visitorPasses) ? visitorPasses : [];
  const allPricingRules = Array.isArray(pricingRules) ? pricingRules : [];

  return (
    <div className="min-h-screen bg-background p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Users className="w-6 h-6" style={{ color: GOLD }} />
            Guest & Visitor Passes
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage guest invitations, visitor day passes, and check-ins
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => setShowScan(true)} className="gap-2">
              <Scan className="w-4 h-4" /> Scan QR
            </Button>
          )}
          <Button size="sm" onClick={() => setShowNewPass(true)} className="gap-2" style={{ background: GOLD, color: '#000' }}>
            <UserPlus className="w-4 h-4" /> Invite Guest
          </Button>
        </div>
      </div>

      {/* Policy summary */}
      {policy && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="p-3 bg-card/60 border-white/10">
            <p className="text-xs text-muted-foreground">Monthly Limit</p>
            <p className="text-xl font-bold text-white">{policy.maxGuestsPerMemberPerMonth ?? 10}</p>
          </Card>
          <Card className="p-3 bg-card/60 border-white/10">
            <p className="text-xs text-muted-foreground">Annual Limit</p>
            <p className="text-xl font-bold text-white">{policy.maxGuestsPerMemberPerYear ?? 60}</p>
          </Card>
          {isAdmin && (
            <>
              <Card className="p-3 bg-card/60 border-white/10">
                <p className="text-xs text-muted-foreground">Guest Passes (all)</p>
                <p className="text-xl font-bold text-white">{allPasses.length}</p>
              </Card>
              <Card className="p-3 bg-card/60 border-white/10">
                <p className="text-xs text-muted-foreground">Visitor Passes</p>
                <p className="text-xl font-bold text-white">{allVisitors.length}</p>
              </Card>
            </>
          )}
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-card/60 border border-white/10">
          <TabsTrigger value="guests">Guest Passes</TabsTrigger>
          {isAdmin && <TabsTrigger value="visitors">Visitor Passes</TabsTrigger>}
          {isAdmin && <TabsTrigger value="pricing">Visitor Pricing</TabsTrigger>}
          {isAdmin && <TabsTrigger value="report">Revenue Report</TabsTrigger>}
        </TabsList>

        {/* Guest Passes Tab */}
        <TabsContent value="guests" className="mt-4">
          {loadingGuests ? (
            <div className="text-center text-muted-foreground py-10">Loading...</div>
          ) : allPasses.length === 0 ? (
            <Card className="p-12 text-center bg-card/40 border-white/10">
              <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-white font-medium">No guest passes yet</p>
              <p className="text-muted-foreground text-sm mt-1">Invite a guest to play at your club</p>
              <Button className="mt-4" onClick={() => setShowNewPass(true)} style={{ background: GOLD, color: '#000' }}>
                <UserPlus className="w-4 h-4 mr-2" /> Invite Guest
              </Button>
            </Card>
          ) : (
            <div className="space-y-2">
              {allPasses.map((row: Record<string, unknown>) => {
                const pass = (row.pass ?? row) as Record<string, unknown>;
                const memberName = row.memberName as string | null;
                return (
                  <Card key={String(pass.id)} className="p-4 bg-card/60 border-white/10 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                      <Users className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-white">{String(pass.guestName)}</span>
                        <Badge className={`text-xs ${statusColor(String(pass.status))}`}>{String(pass.status).replace('_', ' ')}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Play date: {fmtDate(pass.playDate as string)} ·{' '}
                        Fee: {fmtMoney(pass.greenFee as string)} ·{' '}
                        Settlement: {String(pass.feeSettlement).replace('_', ' ')}
                        {isAdmin && memberName ? ` · Invited by: ${memberName}` : ''}
                      </p>
                      {pass.guestEmail && <p className="text-xs text-muted-foreground">{String(pass.guestEmail)}</p>}
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <Button size="sm" variant="ghost" onClick={() => setShowQr({ token: String(pass.qrToken), guestName: String(pass.guestName) })}>
                        <QrCode className="w-4 h-4" />
                      </Button>
                      {pass.status !== 'cancelled' && pass.status !== 'checked_in' && (
                        <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300"
                          onClick={() => cancelPassMutation.mutate(Number(pass.id))}>
                          <X className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* Visitor Passes Tab */}
        {isAdmin && (
          <TabsContent value="visitors" className="mt-4">
            {loadingVisitors ? (
              <div className="text-center text-muted-foreground py-10">Loading...</div>
            ) : allVisitors.length === 0 ? (
              <Card className="p-12 text-center bg-card/40 border-white/10">
                <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-white font-medium">No visitor passes purchased yet</p>
                <p className="text-muted-foreground text-sm mt-1">Non-members can purchase visitor passes online</p>
              </Card>
            ) : (
              <div className="space-y-2">
                {allVisitors.map((pass: Record<string, unknown>) => (
                  <Card key={String(pass.id)} className="p-4 bg-card/60 border-white/10 flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                      <Users className="w-5 h-5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-white">{String(pass.visitorName)}</span>
                        <Badge className={`text-xs ${statusColor(String(pass.status))}`}>{String(pass.status).replace('_', ' ')}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {String(pass.visitorEmail)} · Play: {fmtDate(pass.playDate as string)} · Fee: {fmtMoney(pass.greenFee as string)}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setShowQr({ token: String(pass.qrToken), guestName: String(pass.visitorName) })}>
                      <QrCode className="w-4 h-4" />
                    </Button>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        )}

        {/* Visitor Pricing Tab */}
        {isAdmin && (
          <TabsContent value="pricing" className="mt-4 space-y-4">
            <div className="flex justify-between items-center">
              <p className="text-sm text-muted-foreground">Configure green fee rates for visitor categories</p>
              <Button size="sm" onClick={openPricingCreate} style={{ background: GOLD, color: '#000' }}>
                <Plus className="w-4 h-4 mr-2" /> Add Pricing Rule
              </Button>
            </div>
            {allPricingRules.length === 0 ? (
              <Card className="p-10 text-center bg-card/40 border-white/10">
                <DollarSign className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                <p className="text-white">No visitor pricing rules configured</p>
                <p className="text-muted-foreground text-sm mt-1">Add pricing tiers for different visitor categories</p>
              </Card>
            ) : (
              <div className="space-y-2">
                {allPricingRules.map((rule: Record<string, unknown>) => (
                  <Card key={String(rule.id)} className="p-4 bg-card/60 border-white/10 flex items-center gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{String(rule.label)}</span>
                        {!rule.isActive && <Badge className="text-xs text-slate-400 bg-slate-500/20">Inactive</Badge>}
                      </div>
                      {rule.description && <p className="text-xs text-muted-foreground">{String(rule.description)}</p>}
                      <p className="text-sm text-muted-foreground mt-1">
                        Weekday: {fmtMoney(rule.weekdayRate as string)} · Weekend: {fmtMoney(rule.weekendRate as string)}
                        {rule.twilightRate ? ` · Twilight: ${fmtMoney(rule.twilightRate as string)}` : ''}
                        {rule.reciprocalRate ? ` · Reciprocal: ${fmtMoney(rule.reciprocalRate as string)}` : ''}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => openPricingEdit(rule)}>Edit</Button>
                      <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300"
                        onClick={() => deletePricingMutation.mutate(Number(rule.id))}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        )}

        {/* Revenue Report Tab */}
        {isAdmin && (
          <TabsContent value="report" className="mt-4 space-y-4">
            <Card className="p-4 bg-card/60 border-white/10">
              <div className="flex flex-wrap gap-4 items-end">
                <div>
                  <Label className="text-xs text-muted-foreground">From</Label>
                  <Input type="date" value={reportFrom} onChange={e => setReportFrom(e.target.value)} className="mt-1 w-44 bg-background/50" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">To</Label>
                  <Input type="date" value={reportTo} onChange={e => setReportTo(e.target.value)} className="mt-1 w-44 bg-background/50" />
                </div>
              </div>
            </Card>
            {report && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Card className="p-4 bg-card/60 border-white/10">
                    <p className="text-xs text-muted-foreground">Guest Pass Revenue</p>
                    <p className="text-2xl font-bold text-white">{fmtMoney(report.guestPasses?.revenue)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{report.guestPasses?.total ?? 0} passes</p>
                  </Card>
                  <Card className="p-4 bg-card/60 border-white/10">
                    <p className="text-xs text-muted-foreground">Visitor Pass Revenue</p>
                    <p className="text-2xl font-bold text-white">{fmtMoney(report.visitorPasses?.revenue)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{report.visitorPasses?.total ?? 0} passes</p>
                  </Card>
                  <Card className="p-4 bg-card/60 border-white/10">
                    <p className="text-xs text-muted-foreground">Combined Revenue</p>
                    <p className="text-2xl font-bold" style={{ color: GOLD }}>{fmtMoney(report.combinedRevenue)}</p>
                  </Card>
                  <Card className="p-4 bg-card/60 border-white/10">
                    <p className="text-xs text-muted-foreground">Check-ins</p>
                    <p className="text-2xl font-bold text-white">
                      {(report.guestPasses?.checkedIn ?? 0) + (report.visitorPasses?.checkedIn ?? 0)}
                    </p>
                  </Card>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Card className="p-4 bg-card/60 border-white/10">
                    <p className="font-semibold text-white mb-3">Guest Passes</p>
                    <div className="space-y-2">
                      {[['Confirmed', report.guestPasses?.total - report.guestPasses?.checkedIn - report.guestPasses?.noShow - report.guestPasses?.cancelled, 'text-emerald-400'],
                        ['Checked In', report.guestPasses?.checkedIn, 'text-blue-400'],
                        ['No Show', report.guestPasses?.noShow, 'text-red-400'],
                        ['Cancelled', report.guestPasses?.cancelled, 'text-slate-400']].map(([label, count, cls]) => (
                        <div key={String(label)} className="flex justify-between">
                          <span className="text-muted-foreground text-sm">{String(label)}</span>
                          <span className={`font-semibold text-sm ${cls}`}>{String(count ?? 0)}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                  <Card className="p-4 bg-card/60 border-white/10">
                    <p className="font-semibold text-white mb-3">Visitor Passes</p>
                    <div className="space-y-2">
                      {[['Paid', report.visitorPasses?.total - report.visitorPasses?.checkedIn - report.visitorPasses?.noShow - report.visitorPasses?.cancelled, 'text-emerald-400'],
                        ['Checked In', report.visitorPasses?.checkedIn, 'text-blue-400'],
                        ['No Show', report.visitorPasses?.noShow, 'text-red-400'],
                        ['Cancelled', report.visitorPasses?.cancelled, 'text-slate-400']].map(([label, count, cls]) => (
                        <div key={String(label)} className="flex justify-between">
                          <span className="text-muted-foreground text-sm">{String(label)}</span>
                          <span className={`font-semibold text-sm ${cls}`}>{String(count ?? 0)}</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              </>
            )}
          </TabsContent>
        )}
      </Tabs>

      {/* New Guest Pass Dialog */}
      <Dialog open={showNewPass} onOpenChange={setShowNewPass}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">Invite a Guest</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-muted-foreground">Guest Name *</Label>
              <Input className="mt-1 bg-background/50" value={newPass.guestName}
                onChange={e => setNewPass(p => ({ ...p, guestName: e.target.value }))} placeholder="Full name" />
            </div>
            <div>
              <Label className="text-muted-foreground">Guest Email</Label>
              <Input className="mt-1 bg-background/50" type="email" value={newPass.guestEmail}
                onChange={e => setNewPass(p => ({ ...p, guestEmail: e.target.value }))} placeholder="email@example.com" />
            </div>
            <div>
              <Label className="text-muted-foreground">Phone</Label>
              <Input className="mt-1 bg-background/50" value={newPass.guestPhone}
                onChange={e => setNewPass(p => ({ ...p, guestPhone: e.target.value }))} placeholder="+91 98765 43210" />
            </div>
            <div>
              <Label className="text-muted-foreground">Play Date *</Label>
              <Input className="mt-1 bg-background/50" type="date" value={newPass.playDate}
                onChange={e => setNewPass(p => ({ ...p, playDate: e.target.value }))} />
            </div>
            <div>
              <Label className="text-muted-foreground">Fee Settlement</Label>
              <Select value={newPass.feeSettlement} onValueChange={v => setNewPass(p => ({ ...p, feeSettlement: v }))}>
                <SelectTrigger className="mt-1 bg-background/50">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member_account">Charge to My Account</SelectItem>
                  <SelectItem value="guest_online">Guest Pays Online</SelectItem>
                  <SelectItem value="pay_at_desk">Pay at Desk</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-muted-foreground">Notes</Label>
              <Input className="mt-1 bg-background/50" value={newPass.notes}
                onChange={e => setNewPass(p => ({ ...p, notes: e.target.value }))} placeholder="Any special notes…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewPass(false)}>Cancel</Button>
            <Button onClick={() => createPassMutation.mutate(newPass)}
              disabled={!newPass.guestName || !newPass.playDate || createPassMutation.isPending}
              style={{ background: GOLD, color: '#000' }}>
              {createPassMutation.isPending ? 'Creating…' : 'Create Pass'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* QR Code Dialog */}
      <Dialog open={!!showQr} onOpenChange={() => setShowQr(null)}>
        <DialogContent className="bg-card border-white/10 max-w-sm text-center">
          <DialogHeader>
            <DialogTitle className="text-white">Guest Pass QR Code</DialogTitle>
          </DialogHeader>
          <p className="text-muted-foreground text-sm mb-4">{showQr?.guestName}</p>
          {showQr && orgId && (
            <div className="flex justify-center">
              <QrDisplay token={showQr.token} orgId={orgId} />
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-4">
            Staff scan this QR code at the club entrance to verify and check in the guest.
          </p>
        </DialogContent>
      </Dialog>

      {/* QR Scan Dialog */}
      <Dialog open={showScan} onOpenChange={(open) => { setShowScan(open); if (!open) { setScanToken(''); setScanResult(null); } }}>
        <DialogContent className="bg-card border-white/10 max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Scan className="w-5 h-5" style={{ color: GOLD }} /> Scan Guest QR
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-muted-foreground">Enter QR Token</Label>
              <div className="flex gap-2 mt-1">
                <Input className="bg-background/50 font-mono text-sm" value={scanToken}
                  onChange={e => setScanToken(e.target.value)} placeholder="Paste token or scan QR…"
                  onKeyDown={e => e.key === 'Enter' && handleScan()} />
                <Button onClick={handleScan} disabled={scanMutation.isPending} style={{ background: GOLD, color: '#000' }}>
                  {scanMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : 'Scan'}
                </Button>
              </div>
            </div>
            {scanResult && (
              <Card className="p-4 bg-emerald-500/10 border-emerald-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  <span className="font-semibold text-white">
                    {scanResult.warning ? 'Already Checked In' : 'Check-in Successful!'}
                  </span>
                </div>
                {scanResult.warning && <p className="text-amber-400 text-sm">{scanResult.warning}</p>}
                <p className="text-sm text-muted-foreground">
                  Type: {scanResult.type === 'guest_pass' ? 'Member Guest' : 'Visitor Pass'}<br />
                  Name: {String((scanResult.pass as Record<string, unknown>).guestName ?? (scanResult.pass as Record<string, unknown>).visitorName)}
                </p>
              </Card>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Pricing Dialog */}
      <Dialog open={showPricingDialog} onOpenChange={setShowPricingDialog}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">{editingRule ? 'Edit Pricing Rule' : 'New Pricing Rule'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-muted-foreground">Label *</Label>
              <Input className="mt-1 bg-background/50" value={pricingForm.label}
                onChange={e => setPricingForm(p => ({ ...p, label: e.target.value }))} placeholder="e.g. Standard Visitor" />
            </div>
            <div>
              <Label className="text-muted-foreground">Description</Label>
              <Input className="mt-1 bg-background/50" value={pricingForm.description}
                onChange={e => setPricingForm(p => ({ ...p, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-muted-foreground">Weekday Rate (₹)</Label>
                <Input className="mt-1 bg-background/50" type="number" value={pricingForm.weekdayRate}
                  onChange={e => setPricingForm(p => ({ ...p, weekdayRate: e.target.value }))} />
              </div>
              <div>
                <Label className="text-muted-foreground">Weekend Rate (₹)</Label>
                <Input className="mt-1 bg-background/50" type="number" value={pricingForm.weekendRate}
                  onChange={e => setPricingForm(p => ({ ...p, weekendRate: e.target.value }))} />
              </div>
              <div>
                <Label className="text-muted-foreground">Twilight Rate (₹)</Label>
                <Input className="mt-1 bg-background/50" type="number" value={pricingForm.twilightRate}
                  onChange={e => setPricingForm(p => ({ ...p, twilightRate: e.target.value }))} />
              </div>
              <div>
                <Label className="text-muted-foreground">Reciprocal Rate (₹)</Label>
                <Input className="mt-1 bg-background/50" type="number" value={pricingForm.reciprocalRate}
                  onChange={e => setPricingForm(p => ({ ...p, reciprocalRate: e.target.value }))} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="isActive" checked={pricingForm.isActive}
                onChange={e => setPricingForm(p => ({ ...p, isActive: e.target.checked }))} />
              <Label htmlFor="isActive" className="text-muted-foreground cursor-pointer">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowPricingDialog(false)}>Cancel</Button>
            <Button onClick={savePricing} disabled={!pricingForm.label} style={{ background: GOLD, color: '#000' }}>
              {editingRule ? 'Save Changes' : 'Create Rule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
