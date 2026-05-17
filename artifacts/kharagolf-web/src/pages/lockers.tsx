import { useState, useMemo } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Lock, LockOpen, Plus, Search, RefreshCw, Users, CheckCircle2, XCircle, AlertCircle,
  Clock, Edit2, Trash2, List, Grid3x3, RotateCcw, History, ChevronRight,
  CreditCard, Send, UserX, PackageX,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

interface Locker {
  id: number;
  lockerNumber: string;
  bay: string | null;
  row: number | null;
  column: number | null;
  status: 'available' | 'occupied' | 'reserved' | 'maintenance';
  annualFee: string;
  currency: string;
  notes: string | null;
  assignment: {
    assignmentId: number;
    memberId: number;
    firstName: string;
    lastName: string;
    memberNumber: string | null;
    expiryDate: string;
    paymentStatus: string;
    status: string;
  } | null;
}

interface Assignment {
  id: number;
  lockerId: number;
  lockerNumber: string;
  bay: string | null;
  memberId: number;
  firstName: string;
  lastName: string;
  memberNumber: string | null;
  email: string | null;
  startDate: string;
  expiryDate: string;
  status: string;
  annualFee: string;
  currency: string;
  paymentMethod: string;
  paymentStatus: string;
  paymentLinkUrl: string | null;
  notes: string | null;
}

interface ClubMember {
  id: number;
  firstName: string;
  lastName: string;
  memberNumber: string | null;
  email: string | null;
  subscriptionStatus: string;
}

interface WaitlistEntry {
  id: number;
  memberId: number;
  firstName: string;
  lastName: string;
  memberNumber: string | null;
  email: string | null;
  requestedAt: string;
  notifiedAt: string | null;
  status: string;
}

interface AuditEntry {
  id: number;
  action: string;
  reason: string | null;
  previousMember: { id: number; firstName: string; lastName: string } | null;
  newMember: { id: number; firstName: string; lastName: string } | null;
  performedByUser: { id: number; displayName: string | null; username: string } | null;
  createdAt: string;
}

const statusConfig = {
  available: { label: 'Available', color: 'bg-green-500/20 border-green-500/30 text-green-400', icon: LockOpen },
  occupied: { label: 'Occupied', color: 'bg-blue-500/20 border-blue-500/30 text-blue-400', icon: Lock },
  reserved: { label: 'Reserved', color: 'bg-yellow-500/20 border-yellow-500/30 text-yellow-400', icon: Clock },
  maintenance: { label: 'Maintenance', color: 'bg-red-500/20 border-red-500/30 text-red-400', icon: AlertCircle },
};

const paymentStatusConfig = {
  paid: { label: 'Paid', color: 'text-green-400', icon: CheckCircle2 },
  unpaid: { label: 'Unpaid', color: 'text-red-400', icon: XCircle },
  pending: { label: 'Pending', color: 'text-yellow-400', icon: Clock },
};

const currencySymbol: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysUntilExpiry(expiryDate: string): number {
  return Math.ceil((new Date(expiryDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
}

export default function LockersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;

  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [bayFilter, setBayFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tab, setTab] = useState('lockers');

  const [addLockerOpen, setAddLockerOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [selectedLocker, setSelectedLocker] = useState<Locker | null>(null);
  const [auditLocker, setAuditLocker] = useState<Locker | null>(null);
  const [bulkRenewOpen, setBulkRenewOpen] = useState(false);

  const [lockerForm, setLockerForm] = useState({ lockerNumber: '', bay: '', row: '', column: '', annualFee: '', currency: 'INR', notes: '' });
  const [assignForm, setAssignForm] = useState({ memberId: '', startDate: new Date().toISOString().split('T')[0], expiryDate: '', annualFee: '', paymentMethod: 'account_charge', notes: '', reason: '' });
  const [bulkRenewForm, setBulkRenewForm] = useState({ newExpiryDate: '', annualFee: '', paymentMethod: 'account_charge' });
  const [selectedAssignmentIds, setSelectedAssignmentIds] = useState<Set<number>>(new Set());

  const [saving, setSaving] = useState(false);

  const { data: lockers = [], isLoading } = useQuery<Locker[]>({
    queryKey: [`/api/organizations/${orgId}/lockers`],
    queryFn: () => fetch(`/api/organizations/${orgId}/lockers`).then(r => { if (!r.ok) throw new Error('Failed to load lockers'); return r.json(); }),
    enabled: !!orgId,
  });

  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: [`/api/organizations/${orgId}/lockers/assignments`],
    queryFn: () => fetch(`/api/organizations/${orgId}/lockers/assignments`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });

  const { data: waitlist = [] } = useQuery<WaitlistEntry[]>({
    queryKey: [`/api/organizations/${orgId}/lockers/waitlist`],
    queryFn: () => fetch(`/api/organizations/${orgId}/lockers/waitlist`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });

  const { data: members = [] } = useQuery<ClubMember[]>({
    queryKey: [`/api/organizations/${orgId}/club-members/members`],
    queryFn: () => fetch(`/api/organizations/${orgId}/club-members/members`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });

  const { data: auditLog = [] } = useQuery<AuditEntry[]>({
    queryKey: [`/api/organizations/${orgId}/lockers/${auditLocker?.id}/audit`],
    queryFn: () => fetch(`/api/organizations/${orgId}/lockers/${auditLocker?.id}/audit`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !!auditLocker,
  });

  const bays = useMemo(() => {
    const baySet = new Set(lockers.map(l => l.bay).filter(Boolean) as string[]);
    return [...baySet].sort();
  }, [lockers]);

  const filteredLockers = useMemo(() => lockers.filter(l => {
    if (bayFilter !== 'all' && l.bay !== bayFilter) return false;
    if (statusFilter !== 'all' && l.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = l.assignment ? `${l.assignment.firstName} ${l.assignment.lastName}`.toLowerCase() : '';
      if (!l.lockerNumber.toLowerCase().includes(q) && !name.includes(q)) return false;
    }
    return true;
  }), [lockers, bayFilter, statusFilter, search]);

  const stats = useMemo(() => ({
    total: lockers.length,
    occupied: lockers.filter(l => l.status === 'occupied').length,
    available: lockers.filter(l => l.status === 'available').length,
    maintenance: lockers.filter(l => l.status === 'maintenance').length,
    expiringSoon: assignments.filter(a => a.status === 'active' && daysUntilExpiry(a.expiryDate) <= 30).length,
  }), [lockers, assignments]);

  const saveLocker = async () => {
    if (!lockerForm.lockerNumber) { toast({ title: 'Locker number is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/lockers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...lockerForm, row: lockerForm.row ? parseInt(lockerForm.row) : undefined, column: lockerForm.column ? parseInt(lockerForm.column) : undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers`] });
      setAddLockerOpen(false);
      setLockerForm({ lockerNumber: '', bay: '', row: '', column: '', annualFee: '', currency: 'INR', notes: '' });
      toast({ title: 'Locker added' });
    } catch (e) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const saveAssignment = async (mode: 'assign' | 'reassign') => {
    if (!selectedLocker || !assignForm.memberId || !assignForm.expiryDate) {
      toast({ title: 'Member and expiry date are required', variant: 'destructive' }); return;
    }
    setSaving(true);
    const endpoint = mode === 'reassign'
      ? `/api/organizations/${orgId}/lockers/${selectedLocker.id}/reassign`
      : `/api/organizations/${orgId}/lockers/${selectedLocker.id}/assign`;
    try {
      const res = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...assignForm, memberId: parseInt(assignForm.memberId), annualFee: assignForm.annualFee || undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers`] });
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers/assignments`] });
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers/waitlist`] });
      mode === 'assign' ? setAssignOpen(false) : setReassignOpen(false);
      setAssignForm({ memberId: '', startDate: new Date().toISOString().split('T')[0], expiryDate: '', annualFee: '', paymentMethod: 'account_charge', notes: '', reason: '' });
      toast({ title: mode === 'assign' ? 'Locker assigned' : 'Locker reassigned' });
    } catch (e) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const releaseLocker = async (locker: Locker, reason?: string) => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/lockers/${locker.id}/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers`] });
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers/assignments`] });
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers/waitlist`] });
      toast({ title: 'Locker released and waitlist notified' });
    } catch (e) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const deleteWaitlistEntry = async (entryId: number) => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/lockers/waitlist/${entryId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers/waitlist`] });
      toast({ title: 'Removed from waitlist' });
    } catch (e) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const saveBulkRenew = async () => {
    if (!bulkRenewForm.newExpiryDate || selectedAssignmentIds.size === 0) {
      toast({ title: 'Select assignments and new expiry date', variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/lockers/bulk-renew`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignmentIds: [...selectedAssignmentIds], ...bulkRenewForm }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const { results } = await res.json() as { results: { id: number; success: boolean }[] };
      const succeeded = results.filter(r => r.success).length;
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers/assignments`] });
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers`] });
      setBulkRenewOpen(false);
      setSelectedAssignmentIds(new Set());
      toast({ title: `Bulk renewed ${succeeded} of ${results.length} assignments` });
    } catch (e) {
      toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const openAssign = (locker: Locker) => {
    setSelectedLocker(locker);
    setAssignForm(f => ({ ...f, annualFee: locker.annualFee }));
    setAssignOpen(true);
  };

  const openReassign = (locker: Locker) => {
    setSelectedLocker(locker);
    setAssignForm(f => ({ ...f, annualFee: locker.annualFee }));
    setReassignOpen(true);
  };

  const openAudit = (locker: Locker) => {
    setAuditLocker(locker);
    setAuditOpen(true);
  };

  const toggleAssignmentSelect = (id: number) => {
    setSelectedAssignmentIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (!orgId) return null;

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Lock className="w-6 h-6 text-primary" /> Locker Room Management
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Manage locker inventory, assignments, and renewals</p>
        </div>
        <Button onClick={() => setAddLockerOpen(true)} className="gap-2">
          <Plus className="w-4 h-4" /> Add Locker
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'Total Lockers', value: stats.total, icon: Lock, color: 'text-white' },
          { label: 'Occupied', value: stats.occupied, icon: Users, color: 'text-blue-400' },
          { label: 'Available', value: stats.available, icon: LockOpen, color: 'text-green-400' },
          { label: 'Maintenance', value: stats.maintenance, icon: AlertCircle, color: 'text-red-400' },
          { label: 'Expiring (30d)', value: stats.expiringSoon, icon: Clock, color: 'text-yellow-400' },
        ].map(s => (
          <Card key={s.label} className="bg-card/50 border-white/5">
            <CardContent className="p-4 flex items-center gap-3">
              <s.icon className={`w-8 h-8 ${s.color} flex-shrink-0`} />
              <div>
                <p className="text-2xl font-bold text-white">{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-card border border-white/5">
          <TabsTrigger value="lockers">Bay Grid</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          <TabsTrigger value="waitlist">Waitlist ({waitlist.length})</TabsTrigger>
        </TabsList>

        {/* BAY GRID TAB */}
        <TabsContent value="lockers" className="space-y-4 mt-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search lockers..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <Select value={bayFilter} onValueChange={setBayFilter}>
              <SelectTrigger className="w-36"><SelectValue placeholder="All Bays" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Bays</SelectItem>
                {bays.map(b => <SelectItem key={b} value={b}>Bay {b}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40"><SelectValue placeholder="All Statuses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="available">Available</SelectItem>
                <SelectItem value="occupied">Occupied</SelectItem>
                <SelectItem value="reserved">Reserved</SelectItem>
                <SelectItem value="maintenance">Maintenance</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex border border-white/10 rounded-lg overflow-hidden">
              <button onClick={() => setViewMode('grid')} className={`p-2 ${viewMode === 'grid' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-white/5'}`}><Grid3x3 className="w-4 h-4" /></button>
              <button onClick={() => setViewMode('list')} className={`p-2 ${viewMode === 'list' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-white/5'}`}><List className="w-4 h-4" /></button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="w-6 h-6 animate-spin mr-2" /> Loading lockers…
            </div>
          ) : filteredLockers.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Lock className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No lockers found</p>
              <p className="text-sm">Add lockers to get started</p>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3">
              {filteredLockers.map(locker => {
                const cfg = statusConfig[locker.status];
                const Icon = cfg.icon;
                const days = locker.assignment ? daysUntilExpiry(locker.assignment.expiryDate) : null;
                const expiringSoon = days !== null && days <= 30;
                return (
                  <div key={locker.id} className={`relative border rounded-xl p-3 cursor-pointer hover:border-primary/40 transition-all group ${cfg.color} ${expiringSoon ? 'ring-1 ring-yellow-500/40' : ''}`}>
                    <div className="flex items-center justify-between mb-1">
                      <Icon className="w-4 h-4" />
                      {expiringSoon && <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />}
                    </div>
                    <p className="font-bold text-white text-sm">{locker.lockerNumber}</p>
                    {locker.bay && <p className="text-[10px] opacity-70">Bay {locker.bay}</p>}
                    {locker.assignment && (
                      <p className="text-[10px] text-white/80 mt-0.5 truncate">{locker.assignment.firstName} {locker.assignment.lastName}</p>
                    )}
                    <div className="absolute inset-0 rounded-xl bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1 p-2">
                      {locker.status === 'available' ? (
                        <button onClick={() => openAssign(locker)} className="text-[10px] bg-primary text-white px-2 py-1 rounded-md w-full text-center">Assign</button>
                      ) : locker.status === 'occupied' ? (
                        <>
                          <button onClick={() => openReassign(locker)} className="text-[10px] bg-yellow-500/20 text-yellow-300 px-2 py-1 rounded-md w-full text-center">Reassign</button>
                          <button onClick={() => releaseLocker(locker, 'Admin released')} className="text-[10px] bg-red-500/20 text-red-300 px-2 py-1 rounded-md w-full text-center">Release</button>
                        </>
                      ) : null}
                      <button onClick={() => openAudit(locker)} className="text-[10px] bg-white/10 text-white px-2 py-1 rounded-md w-full text-center">Audit</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredLockers.map(locker => {
                const cfg = statusConfig[locker.status];
                const Icon = cfg.icon;
                const days = locker.assignment ? daysUntilExpiry(locker.assignment.expiryDate) : null;
                return (
                  <div key={locker.id} className="flex items-center gap-4 p-4 bg-card/50 border border-white/5 rounded-xl hover:border-white/10 transition-colors">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center border ${cfg.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-white">{locker.lockerNumber}</p>
                        {locker.bay && <span className="text-xs text-muted-foreground">Bay {locker.bay}</span>}
                        <Badge className={`text-xs border ${cfg.color}`}>{cfg.label}</Badge>
                      </div>
                      {locker.assignment && (
                        <p className="text-sm text-muted-foreground">{locker.assignment.firstName} {locker.assignment.lastName}
                          {days !== null && <span className={`ml-2 text-xs ${days <= 7 ? 'text-red-400' : days <= 30 ? 'text-yellow-400' : 'text-muted-foreground'}`}>
                            {days <= 0 ? 'Expired' : `Expires in ${days}d`}
                          </span>}
                        </p>
                      )}
                    </div>
                    <div className="text-right text-sm">
                      <p className="text-white">{currencySymbol[locker.currency] ?? locker.currency}{parseFloat(locker.annualFee).toLocaleString()}/yr</p>
                    </div>
                    <div className="flex items-center gap-1">
                      {locker.status === 'available' && (
                        <Button size="sm" variant="outline" onClick={() => openAssign(locker)} className="text-xs h-7">Assign</Button>
                      )}
                      {locker.status === 'occupied' && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => openReassign(locker)} className="text-xs h-7">Reassign</Button>
                          <Button size="sm" variant="outline" onClick={() => releaseLocker(locker, 'Admin released')} className="text-xs h-7 border-red-500/30 text-red-400 hover:bg-red-500/10">Release</Button>
                        </>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => openAudit(locker)} className="h-7 w-7 p-0"><History className="w-3.5 h-3.5" /></Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ASSIGNMENTS TAB */}
        <TabsContent value="assignments" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{assignments.filter(a => a.status === 'active').length} active assignments</p>
            <div className="flex gap-2">
              {selectedAssignmentIds.size > 0 && (
                <Button variant="outline" size="sm" onClick={() => setBulkRenewOpen(true)} className="gap-2">
                  <RotateCcw className="w-3.5 h-3.5" /> Bulk Renew ({selectedAssignmentIds.size})
                </Button>
              )}
            </div>
          </div>
          <div className="space-y-2">
            {assignments.filter(a => a.status === 'active').map(a => {
              const days = daysUntilExpiry(a.expiryDate);
              const pCfg = paymentStatusConfig[a.paymentStatus as keyof typeof paymentStatusConfig] ?? paymentStatusConfig.pending;
              const PIcon = pCfg.icon;
              return (
                <div key={a.id} className={`flex items-center gap-4 p-4 bg-card/50 border rounded-xl transition-colors ${selectedAssignmentIds.has(a.id) ? 'border-primary/40 bg-primary/5' : 'border-white/5 hover:border-white/10'}`}>
                  <input type="checkbox" className="w-4 h-4 accent-green-500" checked={selectedAssignmentIds.has(a.id)} onChange={() => toggleAssignmentSelect(a.id)} />
                  <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                    <Lock className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-white">{a.lockerNumber}</p>
                      {a.bay && <span className="text-xs text-muted-foreground">Bay {a.bay}</span>}
                    </div>
                    <p className="text-sm text-white">{a.firstName} {a.lastName}{a.memberNumber ? ` (${a.memberNumber})` : ''}</p>
                    {a.email && <p className="text-xs text-muted-foreground">{a.email}</p>}
                  </div>
                  <div className="text-right">
                    <p className="text-sm text-white">{currencySymbol[a.currency] ?? a.currency}{parseFloat(a.annualFee).toLocaleString()}/yr</p>
                    <p className={`text-xs ${days <= 7 ? 'text-red-400 font-medium' : days <= 30 ? 'text-yellow-400' : 'text-muted-foreground'}`}>
                      {days <= 0 ? 'Expired' : `Expires in ${days}d`} · {formatDate(a.expiryDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <PIcon className={`w-4 h-4 ${pCfg.color}`} />
                    {a.paymentLinkUrl && (
                      <a href={a.paymentLinkUrl} target="_blank" rel="noreferrer" className="text-xs text-primary underline underline-offset-2">Pay Link</a>
                    )}
                  </div>
                </div>
              );
            })}
            {assignments.filter(a => a.status === 'active').length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <PackageX className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No active assignments</p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* WAITLIST TAB */}
        <TabsContent value="waitlist" className="space-y-4 mt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{waitlist.length} member{waitlist.length !== 1 ? 's' : ''} on waitlist</p>
            <Button variant="outline" size="sm" onClick={async () => {
              const memberId = prompt('Enter member ID to add to waitlist:');
              if (!memberId || isNaN(parseInt(memberId))) return;
              try {
                const res = await fetch(`/api/organizations/${orgId}/lockers/waitlist`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ memberId: parseInt(memberId) }),
                });
                if (res.ok) {
                  await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/lockers/waitlist`] });
                  toast({ title: 'Added to waitlist' });
                } else {
                  const err = await res.json().catch(() => ({ error: 'Request failed' }));
                  toast({ title: 'Error', description: err.error ?? 'Could not add to waitlist', variant: 'destructive' });
                }
              } catch (e) {
                toast({ title: 'Error', description: (e as Error).message, variant: 'destructive' });
              }
            }} className="gap-2 text-xs h-7">
              <Plus className="w-3.5 h-3.5" /> Add to Waitlist
            </Button>
          </div>
          <div className="space-y-2">
            {waitlist.map((entry, idx) => (
              <div key={entry.id} className="flex items-center gap-4 p-4 bg-card/50 border border-white/5 rounded-xl hover:border-white/10 transition-colors">
                <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 text-xs font-bold text-primary">
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white">{entry.firstName} {entry.lastName}{entry.memberNumber ? ` (${entry.memberNumber})` : ''}</p>
                  {entry.email && <p className="text-xs text-muted-foreground">{entry.email}</p>}
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Joined {formatDate(entry.requestedAt)}</p>
                  {entry.notifiedAt && <Badge className="text-xs bg-blue-500/20 text-blue-400 border-blue-500/30">Notified</Badge>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => deleteWaitlistEntry(entry.id)} className="h-7 w-7 p-0 text-red-400 hover:text-red-300">
                  <XCircle className="w-4 h-4" />
                </Button>
              </div>
            ))}
            {waitlist.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No members on waitlist</p>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Add Locker Dialog */}
      <Dialog open={addLockerOpen} onOpenChange={setAddLockerOpen}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader><DialogTitle>Add Locker</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Locker Number *</label>
              <Input value={lockerForm.lockerNumber} onChange={e => setLockerForm(f => ({ ...f, lockerNumber: e.target.value }))} placeholder="e.g. A-01" className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Bay</label>
                <Input value={lockerForm.bay} onChange={e => setLockerForm(f => ({ ...f, bay: e.target.value }))} placeholder="e.g. A" className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Annual Fee</label>
                <Input type="number" value={lockerForm.annualFee} onChange={e => setLockerForm(f => ({ ...f, annualFee: e.target.value }))} placeholder="0" className="mt-1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Row</label>
                <Input type="number" value={lockerForm.row} onChange={e => setLockerForm(f => ({ ...f, row: e.target.value }))} placeholder="e.g. 1" className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Column</label>
                <Input type="number" value={lockerForm.column} onChange={e => setLockerForm(f => ({ ...f, column: e.target.value }))} placeholder="e.g. 1" className="mt-1" />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Currency</label>
              <Select value={lockerForm.currency} onValueChange={v => setLockerForm(f => ({ ...f, currency: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['INR', 'USD', 'GBP', 'EUR'].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Notes</label>
              <Input value={lockerForm.notes} onChange={e => setLockerForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddLockerOpen(false)}>Cancel</Button>
            <Button onClick={saveLocker} disabled={saving}>{saving ? 'Saving…' : 'Add Locker'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign Dialog */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader><DialogTitle>Assign Locker {selectedLocker?.lockerNumber}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Member *</label>
              <Select value={assignForm.memberId} onValueChange={v => setAssignForm(f => ({ ...f, memberId: v }))}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select a member" /></SelectTrigger>
                <SelectContent>
                  {members.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.firstName} {m.lastName}{m.memberNumber ? ` (${m.memberNumber})` : ''}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Start Date</label>
                <Input type="date" value={assignForm.startDate} onChange={e => setAssignForm(f => ({ ...f, startDate: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Expiry Date *</label>
                <Input type="date" value={assignForm.expiryDate} onChange={e => setAssignForm(f => ({ ...f, expiryDate: e.target.value }))} className="mt-1" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Annual Fee</label>
                <Input type="number" value={assignForm.annualFee} onChange={e => setAssignForm(f => ({ ...f, annualFee: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Payment Method</label>
                <Select value={assignForm.paymentMethod} onValueChange={v => setAssignForm(f => ({ ...f, paymentMethod: v }))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="account_charge">Account Charge</SelectItem>
                    <SelectItem value="razorpay">Razorpay Link</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Notes</label>
              <Input value={assignForm.notes} onChange={e => setAssignForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
            <Button onClick={() => saveAssignment('assign')} disabled={saving}>{saving ? 'Assigning…' : 'Assign Locker'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reassign Dialog */}
      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader><DialogTitle>Reassign Locker {selectedLocker?.lockerNumber}</DialogTitle></DialogHeader>
          {selectedLocker?.assignment && (
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-300 mb-2">
              Currently assigned to <strong>{selectedLocker.assignment.firstName} {selectedLocker.assignment.lastName}</strong> — this assignment will be cancelled.
            </div>
          )}
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">New Member *</label>
              <Select value={assignForm.memberId} onValueChange={v => setAssignForm(f => ({ ...f, memberId: v }))}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="Select a member" /></SelectTrigger>
                <SelectContent>
                  {members.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.firstName} {m.lastName}{m.memberNumber ? ` (${m.memberNumber})` : ''}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Start Date</label>
                <Input type="date" value={assignForm.startDate} onChange={e => setAssignForm(f => ({ ...f, startDate: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Expiry Date *</label>
                <Input type="date" value={assignForm.expiryDate} onChange={e => setAssignForm(f => ({ ...f, expiryDate: e.target.value }))} className="mt-1" />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Reason for Reassignment</label>
              <Input value={assignForm.reason} onChange={e => setAssignForm(f => ({ ...f, reason: e.target.value }))} placeholder="e.g. Member resigned" className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReassignOpen(false)}>Cancel</Button>
            <Button onClick={() => saveAssignment('reassign')} disabled={saving} className="bg-yellow-600 hover:bg-yellow-700">{saving ? 'Saving…' : 'Reassign Locker'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Audit Log Dialog */}
      <Dialog open={auditOpen} onOpenChange={setAuditOpen}>
        <DialogContent className="bg-card border-white/10 max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Audit Trail — Locker {auditLocker?.lockerNumber}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {auditLog.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No audit entries</p>
            ) : auditLog.map(entry => (
              <div key={entry.id} className="flex gap-3 p-3 bg-white/5 rounded-lg">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <History className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-white capitalize">{entry.action.replace('_', ' ')}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(entry.createdAt)}</p>
                  </div>
                  {entry.previousMember && <p className="text-xs text-muted-foreground">From: {entry.previousMember.firstName} {entry.previousMember.lastName}</p>}
                  {entry.newMember && <p className="text-xs text-white/80">To: {entry.newMember.firstName} {entry.newMember.lastName}</p>}
                  {entry.reason && <p className="text-xs text-muted-foreground italic">{entry.reason}</p>}
                  {entry.performedByUser && <p className="text-xs text-muted-foreground">By: {entry.performedByUser.displayName ?? entry.performedByUser.username}</p>}
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Bulk Renew Dialog */}
      <Dialog open={bulkRenewOpen} onOpenChange={setBulkRenewOpen}>
        <DialogContent className="bg-card border-white/10 max-w-md">
          <DialogHeader><DialogTitle>Bulk Renew {selectedAssignmentIds.size} Assignment{selectedAssignmentIds.size !== 1 ? 's' : ''}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">New Expiry Date *</label>
              <Input type="date" value={bulkRenewForm.newExpiryDate} onChange={e => setBulkRenewForm(f => ({ ...f, newExpiryDate: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Annual Fee (optional, leave blank to keep current)</label>
              <Input type="number" value={bulkRenewForm.annualFee} onChange={e => setBulkRenewForm(f => ({ ...f, annualFee: e.target.value }))} placeholder="Keep current" className="mt-1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Payment Method</label>
              <Select value={bulkRenewForm.paymentMethod} onValueChange={v => setBulkRenewForm(f => ({ ...f, paymentMethod: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="account_charge">Account Charge</SelectItem>
                  <SelectItem value="razorpay">Razorpay Link</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkRenewOpen(false)}>Cancel</Button>
            <Button onClick={saveBulkRenew} disabled={saving}>{saving ? 'Processing…' : 'Bulk Renew'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
